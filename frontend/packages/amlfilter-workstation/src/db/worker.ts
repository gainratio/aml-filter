// The DB Worker: owns the opfs-sahpool SQLite database (persistent, no
// COOP/COEP). One typed request in, one typed response out; all SQL behavior
// lives in operations.ts where it is unit-tested against in-memory SQLite.

import { encodeWorkerError } from "../errors";
import { acquirePool } from "./acquire";
import {
	createCustomer,
	createCustomers,
	deleteCustomer,
	getCustomer,
	getMatchEvents,
	getSetting,
	listCustomers,
	listReviewMatches,
	markScreened,
	recordMatches,
	replaceMatches,
	resolveMatch,
	setSetting,
	updateCustomer,
} from "./operations";
import type { DbRequest, DbResponse } from "./protocol";
import { migrate } from "./schema";
import { openPersistentDatabase, type SqlDatabase } from "./sqlite";

const POOL_NAME = "amlfilter-workstation";
const DB_FILENAME = "/kyc.sqlite3";

let database: SqlDatabase | null = null;
let databasePromise: Promise<SqlDatabase> | null = null;

// Memoize the IN-FLIGHT promise, set synchronously before any await (the same
// pattern as the engine worker's store()): two 'open' requests racing the
// first await must share one openPersistentDatabase call. Memoizing only the
// resolved value would let both racers pass the null guard — a double sahpool
// VFS install, with the second pool acquisition clobbering the first.
//
// acquirePool absorbs the page-navigation handle-release race (transient
// NoModificationAllowedError) with a short bounded retry; only persisting
// contention — a genuinely open second tab (sahpool is single-connection) —
// or a non-contention failure surfaces the "already open in another tab?"
// message it wraps every rejection in.
function openDb(): Promise<SqlDatabase> {
	if (databasePromise === null) {
		databasePromise = acquirePool(() =>
			openPersistentDatabase(POOL_NAME, DB_FILENAME),
		).catch((error: unknown) => {
			databasePromise = null; // allow retry after a transient open failure
			throw error;
		});
	}
	return databasePromise;
}

async function openOnce(): Promise<number> {
	// Cache the resolved handle so requireDb() stays a synchronous guard for
	// every post-open request kind.
	database = await openDb();
	return migrate(database);
}

function requireDb(): SqlDatabase {
	if (database === null) {
		throw new Error("database not open: send 'open' first");
	}
	return database;
}

async function execute(request: DbRequest): Promise<DbResponse> {
	switch (request.kind) {
		case "open":
			return {
				ok: true,
				id: request.id,
				kind: "open",
				result: await openOnce(),
			};
		case "createCustomer":
			return {
				ok: true,
				id: request.id,
				kind: "createCustomer",
				result: createCustomer(requireDb(), request.payload),
			};
		case "createCustomers":
			return {
				ok: true,
				id: request.id,
				kind: "createCustomers",
				result: createCustomers(requireDb(), request.payloads),
			};
		case "listCustomers":
			return {
				ok: true,
				id: request.id,
				kind: "listCustomers",
				result: listCustomers(requireDb()),
			};
		case "getCustomer":
			return {
				ok: true,
				id: request.id,
				kind: "getCustomer",
				result: getCustomer(requireDb(), request.customerId),
			};
		case "updateCustomer":
			return {
				ok: true,
				id: request.id,
				kind: "updateCustomer",
				result: updateCustomer(requireDb(), request.customerId, request.patch),
			};
		case "deleteCustomer":
			deleteCustomer(requireDb(), request.customerId);
			return { ok: true, id: request.id, kind: "deleteCustomer", result: null };
		case "recordMatches":
			return {
				ok: true,
				id: request.id,
				kind: "recordMatches",
				result: recordMatches(requireDb(), request.customerId, request.matches),
			};
		case "replaceMatches":
			return {
				ok: true,
				id: request.id,
				kind: "replaceMatches",
				result: replaceMatches(
					requireDb(),
					request.customerId,
					request.matches,
				),
			};
		case "markScreened":
			return {
				ok: true,
				id: request.id,
				kind: "markScreened",
				result: markScreened(
					requireDb(),
					request.customerId,
					request.listVersion,
				),
			};
		case "listReviewMatches":
			return {
				ok: true,
				id: request.id,
				kind: "listReviewMatches",
				result: listReviewMatches(requireDb(), request.filters),
			};
		case "resolveMatch":
			return {
				ok: true,
				id: request.id,
				kind: "resolveMatch",
				result: resolveMatch(
					requireDb(),
					request.matchId,
					request.resolution,
					request.reviewerId,
					request.notes,
				),
			};
		case "getMatchEvents":
			return {
				ok: true,
				id: request.id,
				kind: "getMatchEvents",
				result: getMatchEvents(requireDb(), request.matchId),
			};
		case "getSetting":
			return {
				ok: true,
				id: request.id,
				kind: "getSetting",
				result: getSetting(requireDb(), request.key),
			};
		case "setSetting":
			setSetting(requireDb(), request.key, request.value);
			return { ok: true, id: request.id, kind: "setSetting", result: null };
	}
}

const scope = self as unknown as {
	postMessage(message: DbResponse): void;
	addEventListener(
		type: "message",
		listener: (event: MessageEvent<DbRequest>) => void,
	): void;
};

scope.addEventListener("message", (event) => {
	void execute(event.data)
		.catch(
			(error: unknown): DbResponse => ({
				ok: false,
				id: event.data.id,
				error: encodeWorkerError(error),
			}),
		)
		.then((response) => {
			scope.postMessage(response);
		});
});
