// Thin main-thread client over the DB Worker. The main thread cannot touch
// opfs-sahpool sync access handles, so it only sends typed requests and awaits
// replies. One in-flight map keyed by request id correlates responses to
// promises — the same pattern as @amlfilter/browser engine/client.ts.

import { decodeWorkerError } from "../errors";
import type {
	CreateCustomerPayload,
	CustomerPatch,
	CustomerRow,
	MatchEvent,
	ReviewFilters,
	ReviewRow,
	TieredMatch,
	WorkstationStore,
} from "../types";
import type { DbRequest, DbResponse } from "./protocol";

/** The worker surface DbClient needs — fakeable in unit tests. */
export interface WorkerLike {
	postMessage(message: DbRequest): void;
	addEventListener(
		type: "message",
		listener: (event: MessageEvent<DbResponse>) => void,
	): void;
	terminate(): void;
}

interface Pending {
	readonly resolve: (response: DbResponse) => void;
	readonly reject: (error: Error) => void;
}

type ResultOf<K extends DbRequest["kind"]> = Extract<
	DbResponse,
	{ ok: true; kind: K }
>["result"];

export class DbClient implements WorkstationStore {
	readonly #worker: WorkerLike;
	readonly #pending = new Map<number, Pending>();
	#nextId = 0;
	#terminated = false;

	public constructor(worker: WorkerLike) {
		this.#worker = worker;
		this.#worker.addEventListener("message", (event) => {
			this.#onMessage(event.data);
		});
	}

	/** Spawn the bundled DB Worker (module worker). */
	public static spawn(): DbClient {
		const worker = new Worker(new URL("./worker.ts", import.meta.url), {
			type: "module",
		});
		return new DbClient(worker);
	}

	public open(): Promise<number> {
		return this.#call({ kind: "open", id: this.#allocId() });
	}

	public createCustomer(payload: CreateCustomerPayload): Promise<CustomerRow> {
		return this.#call({ kind: "createCustomer", id: this.#allocId(), payload });
	}

	public createCustomers(
		payloads: ReadonlyArray<CreateCustomerPayload>,
	): Promise<ReadonlyArray<CustomerRow>> {
		return this.#call({
			kind: "createCustomers",
			id: this.#allocId(),
			payloads,
		});
	}

	public listCustomers(): Promise<ReadonlyArray<CustomerRow>> {
		return this.#call({ kind: "listCustomers", id: this.#allocId() });
	}

	public getCustomer(customerId: string): Promise<CustomerRow | null> {
		return this.#call({ kind: "getCustomer", id: this.#allocId(), customerId });
	}

	public updateCustomer(
		customerId: string,
		patch: CustomerPatch,
	): Promise<CustomerRow> {
		return this.#call({
			kind: "updateCustomer",
			id: this.#allocId(),
			customerId,
			patch,
		});
	}

	public async deleteCustomer(customerId: string): Promise<void> {
		await this.#call({
			kind: "deleteCustomer",
			id: this.#allocId(),
			customerId,
		});
	}

	public recordMatches(
		customerId: string,
		matches: ReadonlyArray<TieredMatch>,
	): Promise<ReadonlyArray<ReviewRow>> {
		return this.#call({
			kind: "recordMatches",
			id: this.#allocId(),
			customerId,
			matches,
		});
	}

	public replaceMatches(
		customerId: string,
		matches: ReadonlyArray<TieredMatch>,
	): Promise<ReadonlyArray<ReviewRow>> {
		return this.#call({
			kind: "replaceMatches",
			id: this.#allocId(),
			customerId,
			matches,
		});
	}

	public markScreened(
		customerId: string,
		listVersion: string,
	): Promise<CustomerRow> {
		return this.#call({
			kind: "markScreened",
			id: this.#allocId(),
			customerId,
			listVersion,
		});
	}

	public listReviewMatches(
		filters: ReviewFilters,
	): Promise<ReadonlyArray<ReviewRow>> {
		return this.#call({
			kind: "listReviewMatches",
			id: this.#allocId(),
			filters,
		});
	}

	public resolveMatch(
		matchId: string,
		resolution: string,
		reviewerId?: string,
		notes?: string,
	): Promise<ReviewRow> {
		return this.#call({
			kind: "resolveMatch",
			id: this.#allocId(),
			matchId,
			resolution,
			...(reviewerId !== undefined ? { reviewerId } : {}),
			...(notes !== undefined ? { notes } : {}),
		});
	}

	public getMatchEvents(matchId: string): Promise<ReadonlyArray<MatchEvent>> {
		return this.#call({ kind: "getMatchEvents", id: this.#allocId(), matchId });
	}

	public getSetting(key: string): Promise<string | null> {
		return this.#call({ kind: "getSetting", id: this.#allocId(), key });
	}

	public async setSetting(key: string, value: string): Promise<void> {
		await this.#call({ kind: "setSetting", id: this.#allocId(), key, value });
	}

	public terminate(): void {
		// Settle outstanding requests before the worker dies — otherwise their
		// promises would hang forever (no reply is ever coming).
		const error = new Error(
			`DbClient terminated with ${this.#pending.size} request(s) in flight`,
		);
		for (const pending of this.#pending.values()) {
			pending.reject(error);
		}
		this.#pending.clear();
		// Block new requests — a #send() after this must reject, not post to a
		// dead worker and hang forever (no reply is ever coming).
		this.#terminated = true;
		this.#worker.terminate();
	}

	#allocId(): number {
		this.#nextId += 1;
		return this.#nextId;
	}

	async #call<K extends DbRequest["kind"]>(
		request: DbRequest & { readonly kind: K },
	): Promise<ResultOf<K>> {
		const response = await this.#send(request);
		if (response.ok && response.kind === request.kind) {
			// The kind check above guarantees this narrowing; TS cannot relate
			// the generic K to the runtime comparison, hence the single cast.
			return response.result as ResultOf<K>;
		}
		if (!response.ok) {
			throw decodeWorkerError(response.error);
		}
		throw new Error("unexpected response kind");
	}

	#send(request: DbRequest): Promise<DbResponse> {
		if (this.#terminated) {
			return Promise.reject(
				new Error(
					`DbClient is terminated; cannot send ${request.kind} request`,
				),
			);
		}
		return new Promise<DbResponse>((resolve, reject) => {
			this.#pending.set(request.id, { resolve, reject });
			this.#worker.postMessage(request);
		});
	}

	#onMessage(response: DbResponse): void {
		const pending = this.#pending.get(response.id);
		if (pending === undefined) {
			return;
		}
		this.#pending.delete(response.id);
		pending.resolve(response);
	}
}
