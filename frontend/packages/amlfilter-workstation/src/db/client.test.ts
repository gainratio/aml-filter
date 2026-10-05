import { describe, expect, it } from "vitest";
import { DuplicateReferenceError, NotFoundError } from "../errors";
import type { CustomerRow } from "../types";
import { DbClient, type WorkerLike } from "./client";
import type { DbRequest, DbResponse } from "./protocol";

class FakeWorker implements WorkerLike {
	public readonly requests: DbRequest[] = [];
	#listener: ((event: MessageEvent<DbResponse>) => void) | null = null;

	public postMessage(message: DbRequest): void {
		this.requests.push(message);
	}

	public addEventListener(
		_type: "message",
		listener: (event: MessageEvent<DbResponse>) => void,
	): void {
		this.#listener = listener;
	}

	public terminate(): void {}

	public reply(response: DbResponse): void {
		this.#listener?.({ data: response } as MessageEvent<DbResponse>);
	}
}

function makeCustomerRow(): CustomerRow {
	return {
		customer_id: "c-1",
		customer_reference: "R-1",
		name: "Ann",
		country: null,
		dob: null,
		onboarding_status: "PENDING_REVIEW",
		kyc_risk_rating: null,
		id_documents: [],
		onboarded_by: "local",
		screened_at: null,
		screened_list_version: null,
		created_at: "2026-06-09T00:00:00.000Z",
		updated_at: "2026-06-09T00:00:00.000Z",
	};
}

describe("DbClient", () => {
	it("correlates responses to requests by id", async () => {
		const worker = new FakeWorker();
		const client = new DbClient(worker);
		const openPromise = client.open();
		const listPromise = client.listCustomers();
		const [openReq, listReq] = worker.requests;
		if (openReq === undefined || listReq === undefined) {
			throw new Error("requests missing");
		}
		// Reply out of order — correlation is by id, not arrival order.
		worker.reply({
			ok: true,
			id: listReq.id,
			kind: "listCustomers",
			result: [makeCustomerRow()],
		});
		worker.reply({ ok: true, id: openReq.id, kind: "open", result: 1 });
		await expect(openPromise).resolves.toBe(1);
		await expect(listPromise).resolves.toHaveLength(1);
	});

	it("decodes typed worker errors", async () => {
		const worker = new FakeWorker();
		const client = new DbClient(worker);
		const create = client.createCustomer({
			customer_reference: "R-1",
			name: "Ann",
		});
		const request = worker.requests[0];
		if (request === undefined) throw new Error("request missing");
		worker.reply({
			ok: false,
			id: request.id,
			error: "DUPLICATE_REFERENCE|customer_reference 'R-1' already exists",
		});
		await expect(create).rejects.toBeInstanceOf(DuplicateReferenceError);

		const resolve = client.resolveMatch("m-1", "RESOLVED");
		const second = worker.requests[1];
		if (second === undefined) throw new Error("request missing");
		worker.reply({
			ok: false,
			id: second.id,
			error: "NOT_FOUND|match m-1 not found",
		});
		await expect(resolve).rejects.toBeInstanceOf(NotFoundError);
	});

	it("rejects all in-flight requests on terminate", {
		timeout: 1000,
	}, async () => {
		const worker = new FakeWorker();
		const client = new DbClient(worker);
		// FakeWorker never replies on its own — both calls stay in flight.
		const open = client.open();
		const list = client.listCustomers();
		client.terminate();
		await expect(open).rejects.toThrow(/terminated/);
		await expect(list).rejects.toThrow(/terminated/);
	});

	it("rejects a request issued AFTER terminate (no hang)", {
		timeout: 1000,
	}, async () => {
		const worker = new FakeWorker();
		const client = new DbClient(worker);
		client.terminate();
		// FakeWorker never replies; before the fix this would post to a dead
		// worker and hang forever (the 1000ms timeout would fire).
		await expect(client.open()).rejects.toThrow(/terminated/);
		await expect(client.listCustomers()).rejects.toThrow(/terminated/);
	});

	it("round-trips replaceMatches as its own request kind", async () => {
		const worker = new FakeWorker();
		const client = new DbClient(worker);
		const promise = client.replaceMatches("c-1", []);
		const request = worker.requests[0];
		if (request === undefined) throw new Error("request missing");
		expect(request.kind).toBe("replaceMatches");
		worker.reply({
			ok: true,
			id: request.id,
			kind: "replaceMatches",
			result: [],
		});
		await expect(promise).resolves.toEqual([]);
	});

	it("sends atomic createCustomers as one typed worker request", async () => {
		const worker = new FakeWorker();
		const client = new DbClient(worker);
		const promise = client.createCustomers([
			{ customer_reference: "R-1", name: "Ann" },
		]);
		const request = worker.requests[0];
		if (request === undefined) throw new Error("request missing");
		expect(request.kind).toBe("createCustomers");
		worker.reply({
			ok: true,
			id: request.id,
			kind: "createCustomers",
			result: [makeCustomerRow()],
		});
		await expect(promise).resolves.toHaveLength(1);
	});

	it("rejects on an unexpected response kind", async () => {
		const worker = new FakeWorker();
		const client = new DbClient(worker);
		const open = client.open();
		const request = worker.requests[0];
		if (request === undefined) throw new Error("request missing");
		worker.reply({
			ok: true,
			id: request.id,
			kind: "listCustomers",
			result: [],
		});
		await expect(open).rejects.toThrow(/unexpected response kind/);
	});
});
