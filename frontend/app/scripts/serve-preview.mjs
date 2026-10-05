// Playwright webServer for a production-preview lane: build, then serve — while
// holding the lane's port the whole time.
//
// WHY. The plain `pnpm build && vite preview --port N --strictPort` command has a
// check-then-bind race. Playwright checks port N once, at startup; the build then
// runs for about a minute; only then does `vite preview` try to bind N. Any process
// that takes N inside that window — a sibling lane or another worktree's gate on
// the same default port — makes the preview die with "Port N is already in use"
// (Playwright: "webServer was not able to start" / "exited early"), or, worse,
// leaves Playwright testing the squatter's build if it answers 200.
//
// HOW. Bind N first, before any build work, and answer every request with 503 so
// Playwright's readiness poll keeps waiting. A taken port fails in milliseconds
// with a message naming the port, instead of after a full build. When the build
// succeeds, release N and start the preview on it immediately.
//
// Usage: node scripts/serve-preview.mjs --port <N>

import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";

const HOST = "localhost";
const EXIT_PORT_TAKEN = 98;

/** Bind `port` and answer 503 until released. Rejects when the port is taken. */
function reservePort(port) {
	const server = createServer((_request, response) => {
		response.writeHead(503, { "retry-after": "5" });
		response.end("serve-preview: production build in progress\n");
	});
	return new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(port, HOST, () => resolve(server));
	});
}

function release(server) {
	server.closeAllConnections();
	return new Promise((resolve) => server.close(() => resolve()));
}

/** Run a shell command with inherited stdio; resolves to its exit code. */
function run(command, onChild = () => {}) {
	return new Promise((resolve) => {
		const child = spawn(command, { shell: true, stdio: "inherit" });
		onChild(child);
		child.once("error", () => resolve(1));
		child.once("exit", (code, signal) => resolve(code ?? (signal ? 1 : 0)));
	});
}

/**
 * Build with the port held, then serve on it. Resolves to the exit code the
 * process should end with (the build's on failure, the server's otherwise).
 */
export async function runServePreview({
	port,
	buildCommand,
	serveCommand,
	log = (line) => console.error(line),
	onServeChild,
}) {
	let reservation;
	try {
		reservation = await reservePort(port);
	} catch (error) {
		if (error?.code !== "EADDRINUSE") throw error;
		log(
			`serve-preview: port ${port} is already in use (another lane or worktree?). ` +
				"Refusing before the build; pick a free port via the lane's port env var.",
		);
		return EXIT_PORT_TAKEN;
	}
	const built = await run(buildCommand).finally(() => release(reservation));
	if (built !== 0) return built;
	return run(serveCommand, onServeChild);
}

function parsePort(argv) {
	const index = argv.indexOf("--port");
	const port = Number(argv[index + 1]);
	if (index < 0 || !Number.isInteger(port) || port <= 0 || port > 65_535) {
		throw new Error("usage: node scripts/serve-preview.mjs --port <N>");
	}
	return port;
}

async function main() {
	const port = parsePort(process.argv.slice(2));
	let server;
	for (const signal of ["SIGINT", "SIGTERM"]) {
		process.once(signal, () => {
			server?.kill(signal);
			process.exit(1);
		});
	}
	process.exitCode = await runServePreview({
		port,
		buildCommand: "pnpm build",
		serveCommand: `pnpm exec vite preview --port ${port} --strictPort`,
		onServeChild: (child) => {
			server = child;
		},
	});
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	await main();
}
