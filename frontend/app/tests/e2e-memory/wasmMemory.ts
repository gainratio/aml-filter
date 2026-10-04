/**
 * Tracks the bytes of every WebAssembly.Memory created in the page's dedicated
 * workers, over a raw Chrome DevTools Protocol socket. Playwright cannot patch a
 * worker BEFORE its first script runs; CDP auto-attach with
 * `waitForDebuggerOnStart` can, so the ORT and SQLite heaps are seen from their
 * first allocation. Chromium only (the launch needs --remote-debugging-port).
 */
const PATCH = `(() => { if (globalThis.__mems) return; const M = WebAssembly.Memory; const mems = globalThis.__mems = [];
 WebAssembly.Memory = class extends M { constructor(...a) { super(...a); mems.push(this); } };
 const scan = (i) => { for (const v of Object.values(i.exports)) if (v instanceof M) mems.push(v); };
 for (const fn of ["instantiate", "instantiateStreaming"]) { const o = WebAssembly[fn];
  WebAssembly[fn] = async (...a) => { const r = await o.apply(WebAssembly, a); scan(r.instance || r); return r; }; }
 const I = WebAssembly.Instance; WebAssembly.Instance = class extends I { constructor(...a) { super(...a); scan(this); } }; })()`;

type Reply = { result?: { result?: { value?: number } } };

export class WasmMemoryTracker {
	readonly #ws: WebSocket;
	readonly #pending = new Map<number, (m: Reply) => void>();
	readonly #workers = new Set<string>();
	#id = 0;

	private constructor(ws: WebSocket) {
		this.#ws = ws;
		ws.onmessage = (e) => this.#onMessage(JSON.parse(String(e.data)));
	}

	static async connect(port: number): Promise<WasmMemoryTracker> {
		const res = await fetch(`http://127.0.0.1:${port}/json/version`);
		const { webSocketDebuggerUrl } = (await res.json()) as {
			webSocketDebuggerUrl: string;
		};
		const ws = new WebSocket(webSocketDebuggerUrl);
		await new Promise((resolve) => {
			ws.onopen = resolve;
		});
		const tracker = new WasmMemoryTracker(ws);
		await tracker.#send("Target.setAutoAttach", {
			autoAttach: true,
			waitForDebuggerOnStart: false,
			flatten: true,
		});
		return tracker;
	}

	#send(
		method: string,
		params: object = {},
		sessionId?: string,
	): Promise<Reply> {
		return new Promise((resolve) => {
			const id = ++this.#id;
			this.#pending.set(id, resolve);
			this.#ws.send(JSON.stringify({ id, method, params, sessionId }));
		});
	}

	#onMessage(m: {
		id?: number;
		method?: string;
		params?: { sessionId: string; targetInfo: { type: string } };
	}): void {
		if (m.id !== undefined) {
			this.#pending.get(m.id)?.(m as Reply);
			this.#pending.delete(m.id);
			return;
		}
		if (m.method !== "Target.attachedToTarget" || m.params === undefined)
			return;
		const { sessionId, targetInfo } = m.params;
		if (targetInfo.type === "page") {
			void this.#send(
				"Target.setAutoAttach",
				{ autoAttach: true, waitForDebuggerOnStart: true, flatten: true },
				sessionId,
			);
		} else if (targetInfo.type === "worker") {
			void this.#instrument(sessionId);
		}
	}

	async #instrument(sessionId: string): Promise<void> {
		await this.#send("Runtime.enable", {}, sessionId);
		await this.#send("Runtime.evaluate", { expression: PATCH }, sessionId);
		this.#workers.add(sessionId);
		await this.#send("Runtime.runIfWaitingForDebugger", {}, sessionId);
	}

	/** Sum of every tracked WebAssembly.Memory byteLength across all workers. */
	async totalBytes(): Promise<number> {
		let total = 0;
		for (const sessionId of this.#workers) {
			const reply = await this.#send(
				"Runtime.evaluate",
				{
					expression:
						"(globalThis.__mems||[]).reduce((s,m)=>s+m.buffer.byteLength,0)",
					returnByValue: true,
				},
				sessionId,
			);
			total += reply.result?.result?.value ?? 0;
		}
		return total;
	}

	close(): void {
		this.#ws.close();
	}
}
