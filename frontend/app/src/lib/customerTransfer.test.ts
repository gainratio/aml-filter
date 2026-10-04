import { afterEach, describe, expect, it, vi } from "vitest";
import type { CustomerResponse } from "./api";
import {
	buildCustomerImportPreview,
	type CustomerImportRow,
	createCustomerExportFile,
	customersToSpreadsheetRows,
	parseCustomerImportRows,
	readCustomerImportBuffer,
	readCustomerImportFile,
} from "./customerTransfer";

class FakeTransferWorker {
	static last: FakeTransferWorker | null = null;
	readonly listeners = new Map<string, (event: MessageEvent) => void>();
	readonly terminate = vi.fn();

	constructor() {
		FakeTransferWorker.last = this;
	}

	addEventListener(
		type: string,
		listener: (event: MessageEvent) => void,
	): void {
		this.listeners.set(type, listener);
	}

	postMessage(): void {}

	emit(type: string, data?: unknown): void {
		this.listeners.get(type)?.({ data } as MessageEvent);
	}
}

function customer(overrides: Partial<CustomerResponse> = {}): CustomerResponse {
	return {
		customer_id: "cust-1",
		tenant_id: "local",
		customer_reference: "REF-001",
		name: "Ada Lovelace",
		onboarded_by: "alice",
		country: "GB",
		dob: "1815-12-10",
		onboarding_status: "ACTIVE",
		kyc_risk_rating: "LOW",
		id_documents: [],
		screening_entity_id: null,
		screened_at: null,
		screened_list_version: null,
		created_at: "2026-07-19T10:00:00Z",
		updated_at: "2026-07-19T10:00:00Z",
		...overrides,
	};
}

describe("customer transfer", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
		FakeTransferWorker.last = null;
	});
	it("normalizes headers and validates required fields deterministically", () => {
		const result = parseCustomerImportRows([
			{
				"Customer Reference": " ref-001 ",
				Name: "Ada Lovelace",
				"Onboarded By": "alice",
				"Country Code": "gb",
				"Date of Birth": "12/10/1815",
			},
		]);

		expect(result.errors).toEqual([]);
		expect(result.rows).toEqual([
			{
				rowNumber: 2,
				customer_reference: "ref-001",
				name: "Ada Lovelace",
				onboarded_by: "alice",
				country: "GB",
				dob: "1815-12-10",
				id_documents: [],
			},
		]);
	});

	it("reports invalid rows without dropping valid rows", () => {
		const result = parseCustomerImportRows([
			{ customer_reference: "OK-1", name: "Valid Customer" },
			{ customer_reference: "", name: "", country: "US" },
			{ customer_reference: "BAD-DATE", name: "Customer", dob: "tomorrow" },
		]);

		expect(result.rows).toHaveLength(1);
		expect(result.rows[0]?.customer_reference).toBe("OK-1");
		expect(result.errors).toEqual([
			{
				rowNumber: 3,
				field: "customer_reference",
				message: "Reference is required",
			},
			{ rowNumber: 3, field: "name", message: "Name is required" },
			{
				rowNumber: 4,
				field: "dob",
				message: "Date must be YYYY-MM-DD or MM/DD/YYYY",
			},
		]);
	});

	it("validates document JSON, dates, country codes, and field bounds", () => {
		const result = parseCustomerImportRows([
			{
				customer_reference: "DOC-1",
				name: "Documented",
				dob: new Date("1980-01-02T00:00:00Z"),
				id_documents: JSON.stringify([
					{
						doc_type: "PASSPORT",
						number: "P-1",
						issuing_country: "us",
						expiry: "12/31/2030",
					},
				]),
			},
			{
				customer_reference: "BAD-DOC",
				name: "Bad Document",
				country: "USA",
				dob: "1980-02-31",
				id_documents: "{bad",
			},
		]);

		expect(result.rows[0]).toMatchObject({
			customer_reference: "DOC-1",
			dob: "1980-01-02",
			id_documents: [
				{
					issuing_country: "US",
					expiry: "2030-12-31",
				},
			],
		});
		expect(result.errors).toEqual(
			expect.arrayContaining([
				{
					rowNumber: 3,
					field: "country",
					message: "Country must be an ISO2 code",
				},
				{
					rowNumber: 3,
					field: "dob",
					message: "Date must be YYYY-MM-DD or MM/DD/YYYY",
				},
				{
					rowNumber: 3,
					field: "id_documents",
					message: "Documents must be a JSON array",
				},
			]),
		);
	});

	it("defaults optional values and rejects unknown required headers", () => {
		const result = parseCustomerImportRows([
			{ "Customer Reference": "ALIAS-1", "Full Name": "Alias Person" },
			{ "Not A Customer Field": "value" },
			{},
		]);

		expect(result.rows[0]).toMatchObject({
			customer_reference: "ALIAS-1",
			onboarded_by: "local",
			country: "",
			dob: "",
		});
		expect(result.errors).toEqual([
			{
				rowNumber: 3,
				field: "customer_reference",
				message: "Reference is required",
			},
			{ rowNumber: 3, field: "name", message: "Name is required" },
		]);
	});

	it("fails closed for malformed documents and bounded fields", () => {
		const result = parseCustomerImportRows([
			{
				customer_reference: "R".repeat(121),
				name: "N".repeat(241),
				id_documents: JSON.stringify([
					{
						doc_type: "",
						number: "",
						issuing_country: "USA",
						expiry: "not-a-date",
					},
				]),
			},
			{
				customer_reference: "TOO-MANY-DOCS",
				name: "Many Documents",
				id_documents: JSON.stringify(
					Array.from({ length: 21 }, () => ({
						doc_type: "PASSPORT",
						number: "P-1",
					})),
				),
			},
			{
				customer_reference: "OBJECT-DOC",
				name: "Object Document",
				id_documents: JSON.stringify({ doc_type: "PASSPORT" }),
			},
		]);

		expect(result.rows).toEqual([]);
		expect(result.errors).toEqual(
			expect.arrayContaining([
				{
					rowNumber: 2,
					field: "customer_reference",
					message: "Reference is too long",
				},
				{ rowNumber: 2, field: "name", message: "Name is too long" },
				{
					rowNumber: 2,
					field: "id_documents",
					message: "Documents must be a JSON array",
				},
				{
					rowNumber: 3,
					field: "id_documents",
					message: "Documents must be a JSON array",
				},
				{
					rowNumber: 4,
					field: "id_documents",
					message: "Documents must be a JSON array",
				},
			]),
		);
	});

	it("skips duplicate references within the file and existing customers", () => {
		const rows: CustomerImportRow[] = [
			{
				rowNumber: 2,
				customer_reference: "NEW-1",
				name: "New One",
				onboarded_by: "local",
				country: "US",
				dob: "",
				id_documents: [],
			},
			{
				rowNumber: 3,
				customer_reference: "ref-001",
				name: "Duplicate",
				onboarded_by: "local",
				country: "US",
				dob: "",
				id_documents: [],
			},
			{
				rowNumber: 4,
				customer_reference: "NEW-1",
				name: "Duplicate In File",
				onboarded_by: "local",
				country: "US",
				dob: "",
				id_documents: [],
			},
		];

		const preview = buildCustomerImportPreview(rows, ["REF-001"]);

		expect(preview.accepted).toEqual([rows[0]]);
		expect(preview.duplicates).toEqual([
			{
				rowNumber: 3,
				customer_reference: "ref-001",
				reason: "Already onboarded",
			},
			{
				rowNumber: 4,
				customer_reference: "NEW-1",
				reason: "Duplicate in file",
			},
		]);
	});

	it("exports a stable, re-importable row shape and escapes formula cells", () => {
		expect(
			customersToSpreadsheetRows([
				customer({
					customer_reference: "+REF-001",
					name: '=HYPERLINK("https://evil")',
					onboarded_by: "-owner",
					country: null,
					kyc_risk_rating: null,
				}),
			]),
		).toEqual([
			{
				customer_reference: "'+REF-001",
				name: '\'=HYPERLINK("https://evil")',
				onboarded_by: "'-owner",
				country: "",
				dob: "1815-12-10",
				id_documents: "[]",
				onboarding_status: "ACTIVE",
				kyc_risk_rating: "",
				created_at: "2026-07-19T10:00:00Z",
				updated_at: "2026-07-19T10:00:00Z",
			},
		]);
	});

	it("round-trips an XLSX export through the same bounded importer", async () => {
		const blob = await createCustomerExportFile([customer()]);
		const file = Object.assign(blob, { name: "customers.xlsx" });
		const result = await readCustomerImportFile(file);

		expect(result.errors).toEqual([]);
		expect(result.rows[0]).toMatchObject({
			customer_reference: "REF-001",
			name: "Ada Lovelace",
			country: "GB",
			dob: "1815-12-10",
		});
	});

	it("reads legacy XLS bytes and rejects unsupported macro extensions", async () => {
		const xlsx = await import("xlsx");
		const sheet = xlsx.utils.json_to_sheet([
			{ customer_reference: "XLS-1", name: "Legacy" },
		]);
		const workbook = xlsx.utils.book_new();
		xlsx.utils.book_append_sheet(workbook, sheet, "Customers");
		const bytes = xlsx.write(workbook, { bookType: "xls", type: "array" });
		const result = await readCustomerImportBuffer(bytes, "customers.xls");

		expect(result.rows[0]?.customer_reference).toBe("XLS-1");
		await expect(
			readCustomerImportBuffer(bytes, "customers.xlsm"),
		).rejects.toThrow(/Macro-enabled/);
	});

	it("rejects multi-sheet workbooks and binary CSV files", async () => {
		const xlsx = await import("xlsx");
		const workbook = xlsx.utils.book_new();
		xlsx.utils.book_append_sheet(workbook, xlsx.utils.json_to_sheet([]), "One");
		xlsx.utils.book_append_sheet(workbook, xlsx.utils.json_to_sheet([]), "Two");
		const bytes = xlsx.write(workbook, { bookType: "xlsx", type: "array" });
		await expect(
			readCustomerImportBuffer(bytes, "customers.xlsx"),
		).rejects.toThrow(/one worksheet/);
		await expect(
			readCustomerImportBuffer(
				new TextEncoder().encode("a\0b").buffer,
				"customers.csv",
			),
		).rejects.toThrow(/binary data/);
	});

	it("fails closed before parsing an oversized input", async () => {
		const bytes = new Uint8Array(10 * 1024 * 1024 + 1);
		await expect(
			readCustomerImportFile(
				Object.assign(new Blob([bytes]), { name: "customers.csv" }),
			),
		).rejects.toThrow(/10 MB safety limit/);
	});

	it("rejects invalid workbook signatures and excessively wide sheets", async () => {
		const invalid = new TextEncoder().encode("not a workbook").buffer;
		await expect(
			readCustomerImportBuffer(invalid, "customers.xlsx"),
		).rejects.toThrow(/XLSX file signature is invalid/);

		const xlsx = await import("xlsx");
		const wideRow: Record<string, string> = {
			customer_reference: "WIDE-1",
			name: "Wide",
		};
		for (let index = 0; index < 63; index += 1) wideRow[`extra_${index}`] = "x";
		const sheet = xlsx.utils.json_to_sheet([wideRow]);
		const workbook = xlsx.utils.book_new();
		xlsx.utils.book_append_sheet(workbook, sheet, "Customers");
		const bytes = xlsx.write(workbook, { bookType: "xlsx", type: "array" });
		await expect(
			readCustomerImportBuffer(bytes, "customers.xlsx"),
		).rejects.toThrow(/64-column safety limit/);
	});

	it("rejects unsupported extensions, oversized buffers, and bad XLS signatures", async () => {
		await expect(
			readCustomerImportBuffer(new ArrayBuffer(0), "customers.txt"),
		).rejects.toThrow(/\.csv, \.xls, or \.xlsx/);
		await expect(
			readCustomerImportBuffer(new ArrayBuffer(8), "customers.xls"),
		).rejects.toThrow(/XLS file signature is invalid/);
		await expect(
			readCustomerImportBuffer(
				new ArrayBuffer(10 * 1024 * 1024 + 1),
				"customers.xlsx",
			),
		).rejects.toThrow(/10 MB safety limit/);
	});

	it("rejects worker failures and accepts worker results", async () => {
		vi.stubGlobal("Worker", FakeTransferWorker);
		const file = Object.assign(
			new Blob(["customer_reference,name\nWORKER-1,Worker\n"]),
			{ name: "customers.csv" },
		);
		const success = readCustomerImportFile(file);
		await new Promise((resolve) => setTimeout(resolve, 0));
		FakeTransferWorker.last?.emit("message", { rows: [], errors: [] });
		await expect(success).resolves.toEqual({ rows: [], errors: [] });

		const parserError = readCustomerImportFile(file);
		await new Promise((resolve) => setTimeout(resolve, 0));
		FakeTransferWorker.last?.emit("error");
		await expect(parserError).rejects.toThrow(/parser failed/);

		const messageError = readCustomerImportFile(file);
		await new Promise((resolve) => setTimeout(resolve, 0));
		FakeTransferWorker.last?.emit("messageerror");
		await expect(messageError).rejects.toThrow(/invalid result/);

		const workerPayloadError = readCustomerImportFile(file);
		await new Promise((resolve) => setTimeout(resolve, 0));
		FakeTransferWorker.last?.emit("message", {
			error: "parser payload rejected",
		});
		await expect(workerPayloadError).rejects.toThrow(/payload rejected/);
	});
});
