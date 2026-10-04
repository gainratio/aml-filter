import type { CustomerResponse, IdDocument } from "./api";

const CUSTOMER_IMPORT_MAX_BYTES = 10 * 1024 * 1024;
const CUSTOMER_IMPORT_MAX_ROWS = 5_000;
const MAX_CELL_CHARS = 4_000;
const MAX_DOCUMENTS = 20;
const MAX_DOCUMENT_JSON_CHARS = 20_000;
const MAX_COLUMNS = 64;

export interface CustomerImportRow {
	readonly rowNumber: number;
	readonly customer_reference: string;
	readonly name: string;
	readonly onboarded_by: string;
	readonly country: string;
	readonly dob: string;
	readonly id_documents: ReadonlyArray<IdDocument>;
}

export interface CustomerImportError {
	readonly rowNumber: number;
	readonly field: string;
	readonly message: string;
}

export interface CustomerImportDuplicate {
	readonly rowNumber: number;
	readonly customer_reference: string;
	readonly reason: "Already onboarded" | "Duplicate in file";
}

export interface CustomerImportParseResult {
	readonly rows: ReadonlyArray<CustomerImportRow>;
	readonly errors: ReadonlyArray<CustomerImportError>;
}

export interface CustomerImportPreview {
	readonly accepted: ReadonlyArray<CustomerImportRow>;
	readonly duplicates: ReadonlyArray<CustomerImportDuplicate>;
}

export interface CustomerSpreadsheetRow {
	readonly customer_reference: string;
	readonly name: string;
	readonly onboarded_by: string;
	readonly country: string;
	readonly dob: string;
	readonly id_documents: string;
	readonly onboarding_status: string;
	readonly kyc_risk_rating: string;
	readonly created_at: string;
	readonly updated_at: string;
}

const HEADER_ALIASES: Record<
	string,
	keyof Omit<CustomerImportRow, "rowNumber">
> = {
	customer_reference: "customer_reference",
	customerreference: "customer_reference",
	reference: "customer_reference",
	customerref: "customer_reference",
	name: "name",
	customername: "name",
	fullname: "name",
	onboardedby: "onboarded_by",
	owner: "onboarded_by",
	country: "country",
	countrycode: "country",
	dob: "dob",
	dateofbirth: "dob",
	birthdate: "dob",
	iddocuments: "id_documents",
	documents: "id_documents",
};

const REQUIRED_FIELDS = ["customer_reference", "name"] as const;

function canonicalHeader(header: string): string {
	return header
		.replace(/^\uFEFF/, "")
		.toLowerCase()
		.replace(/[^a-z0-9]/g, "");
}

function canonicalField(
	header: string,
): keyof Omit<CustomerImportRow, "rowNumber"> | null {
	return HEADER_ALIASES[canonicalHeader(header)] ?? null;
}

function text(value: unknown): string {
	return value === null || value === undefined ? "" : String(value).trim();
}

function validDate(year: number, month: number, day: number): boolean {
	const date = new Date(Date.UTC(year, month - 1, day));
	return (
		date.getUTCFullYear() === year &&
		date.getUTCMonth() === month - 1 &&
		date.getUTCDate() === day
	);
}

function normalizeDate(value: unknown): string {
	if (value instanceof Date && !Number.isNaN(value.getTime())) {
		return `${value.getUTCFullYear().toString().padStart(4, "0")}-${(value.getUTCMonth() + 1).toString().padStart(2, "0")}-${value.getUTCDate().toString().padStart(2, "0")}`;
	}
	const raw = text(value);
	const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
	const us = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(raw);
	if (iso && validDate(Number(iso[1]), Number(iso[2]), Number(iso[3])))
		return raw;
	if (us) {
		const [, month, day, year] = us;
		if (
			month !== undefined &&
			day !== undefined &&
			year !== undefined &&
			validDate(Number(year), Number(month), Number(day))
		) {
			return `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
		}
	}
	return "";
}

function parseDocuments(value: unknown): ReadonlyArray<IdDocument> | null {
	const raw = text(value);
	if (!raw) return [];
	if (raw.length > MAX_DOCUMENT_JSON_CHARS) return null;
	try {
		const parsed: unknown = JSON.parse(raw);
		if (!Array.isArray(parsed)) return null;
		if (parsed.length > MAX_DOCUMENTS) return null;
		return parsed.map((item) => {
			if (!item || typeof item !== "object")
				throw new Error("invalid document");
			const record = item as Record<string, unknown>;
			const docType = text(record.doc_type);
			const number = text(record.number);
			const country = text(record.issuing_country).toUpperCase();
			const expiryValue = text(record.expiry);
			if (
				!docType ||
				!number ||
				docType.length > 80 ||
				number.length > 160 ||
				(country && !/^[A-Z]{2}$/.test(country))
			)
				throw new Error("invalid document");
			const expiry = expiryValue ? normalizeDate(expiryValue) : "";
			if (expiryValue && !expiry) throw new Error("invalid document");
			return {
				doc_type: docType,
				number,
				issuing_country: country,
				expiry: expiry || null,
			};
		});
	} catch {
		return null;
	}
}

function normalizeRecord(
	raw: Record<string, unknown>,
	rowNumber: number,
): { row: CustomerImportRow | null; errors: CustomerImportError[] } {
	const fields: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(raw)) {
		const field = canonicalField(key);
		if (field !== null) fields[field] = value;
	}
	const errors: CustomerImportError[] = [];
	for (const [field, value] of Object.entries(fields)) {
		if (text(value).length > MAX_CELL_CHARS)
			errors.push({
				rowNumber,
				field,
				message: "Cell exceeds the 4,000-character limit",
			});
	}
	for (const field of REQUIRED_FIELDS) {
		if (!text(fields[field]))
			errors.push({
				rowNumber,
				field,
				message:
					field === "name" ? "Name is required" : "Reference is required",
			});
	}
	const reference = text(fields.customer_reference);
	const name = text(fields.name);
	if (reference.length > 120)
		errors.push({
			rowNumber,
			field: "customer_reference",
			message: "Reference is too long",
		});
	if (name.length > 240)
		errors.push({ rowNumber, field: "name", message: "Name is too long" });
	const country = text(fields.country).toUpperCase();
	if (country && !/^[A-Z]{2}$/.test(country))
		errors.push({
			rowNumber,
			field: "country",
			message: "Country must be an ISO2 code",
		});
	const dobValue = text(fields.dob);
	const dob = normalizeDate(fields.dob);
	if (dobValue && !dob)
		errors.push({
			rowNumber,
			field: "dob",
			message: "Date must be YYYY-MM-DD or MM/DD/YYYY",
		});
	const documents = parseDocuments(fields.id_documents);
	if (documents === null)
		errors.push({
			rowNumber,
			field: "id_documents",
			message: "Documents must be a JSON array",
		});
	if (errors.length > 0) return { row: null, errors };
	return {
		row: {
			rowNumber,
			customer_reference: reference,
			name,
			onboarded_by: text(fields.onboarded_by) || "local",
			country,
			dob,
			id_documents: documents ?? [],
		},
		errors,
	};
}

export function parseCustomerImportRows(
	rawRows: ReadonlyArray<Record<string, unknown>>,
): CustomerImportParseResult {
	const rows: CustomerImportRow[] = [];
	const errors: CustomerImportError[] = [];
	for (let index = 0; index < rawRows.length; index += 1) {
		const raw = rawRows[index];
		if (raw === undefined || Object.values(raw).every((value) => !text(value)))
			continue;
		const result = normalizeRecord(raw, index + 2);
		if (result.row !== null) rows.push(result.row);
		errors.push(...result.errors);
	}
	return { rows, errors };
}

function referenceKey(reference: string): string {
	return reference.trim().toUpperCase();
}

export function buildCustomerImportPreview(
	rows: ReadonlyArray<CustomerImportRow>,
	existingReferences: ReadonlyArray<string>,
): CustomerImportPreview {
	const existing = new Set(existingReferences.map(referenceKey));
	const seen = new Set<string>();
	const accepted: CustomerImportRow[] = [];
	const duplicates: CustomerImportDuplicate[] = [];
	for (const row of rows) {
		const key = referenceKey(row.customer_reference);
		if (existing.has(key))
			duplicates.push({
				rowNumber: row.rowNumber,
				customer_reference: row.customer_reference,
				reason: "Already onboarded",
			});
		else if (seen.has(key))
			duplicates.push({
				rowNumber: row.rowNumber,
				customer_reference: row.customer_reference,
				reason: "Duplicate in file",
			});
		else {
			seen.add(key);
			accepted.push(row);
		}
	}
	return { accepted, duplicates };
}

function spreadsheetSafe(value: string): string {
	return /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
}

export function customersToSpreadsheetRows(
	customers: ReadonlyArray<CustomerResponse>,
): ReadonlyArray<CustomerSpreadsheetRow> {
	return customers.map((customer) => ({
		customer_reference: spreadsheetSafe(customer.customer_reference),
		name: spreadsheetSafe(customer.name),
		onboarded_by: spreadsheetSafe(customer.onboarded_by),
		country: spreadsheetSafe(customer.country ?? ""),
		dob: customer.dob ?? "",
		id_documents: spreadsheetSafe(JSON.stringify(customer.id_documents)),
		onboarding_status: spreadsheetSafe(customer.onboarding_status),
		kyc_risk_rating: spreadsheetSafe(customer.kyc_risk_rating ?? ""),
		created_at: customer.created_at,
		updated_at: customer.updated_at,
	}));
}

function fileExtension(fileName: string): string {
	return fileName.toLowerCase().split(".").pop() ?? "";
}

function assertSupportedFile(fileName: string, bytes: ArrayBuffer): void {
	const extension = fileExtension(fileName);
	if (["xlsm", "xlsb", "xlam"].includes(extension))
		throw new Error("Macro-enabled workbooks are not supported");
	if (!["csv", "xls", "xlsx"].includes(extension))
		throw new Error("Use a .csv, .xls, or .xlsx file");
	const signature = new Uint8Array(bytes.slice(0, 8));
	const isZip = signature[0] === 0x50 && signature[1] === 0x4b;
	const isOle =
		signature[0] === 0xd0 &&
		signature[1] === 0xcf &&
		signature[2] === 0x11 &&
		signature[3] === 0xe0;
	if (extension === "xlsx" && !isZip)
		throw new Error("The XLSX file signature is invalid");
	if (extension === "xls" && !isOle)
		throw new Error("The XLS file signature is invalid");
	if (extension === "csv" && new Uint8Array(bytes).includes(0))
		throw new Error("The CSV file contains binary data");
}

export async function readCustomerImportBuffer(
	buffer: ArrayBuffer,
	fileName = "customers.xlsx",
): Promise<CustomerImportParseResult> {
	if (buffer.byteLength > CUSTOMER_IMPORT_MAX_BYTES)
		throw new Error("File is larger than the 10 MB safety limit");
	assertSupportedFile(fileName, buffer);
	const xlsx = await import("xlsx");
	const workbook = xlsx.read(buffer, {
		type: "array",
		dense: true,
		cellDates: true,
		cellFormula: false,
		cellHTML: false,
		cellNF: false,
		cellStyles: false,
		bookVBA: false,
		WTF: true,
		UTC: true,
		sheetRows: CUSTOMER_IMPORT_MAX_ROWS + 2,
	});
	if (workbook.SheetNames.length === 0)
		throw new Error("Workbook has no worksheets");
	if (workbook.SheetNames.length > 1)
		throw new Error("Use a workbook with one worksheet");
	const sheet = workbook.Sheets[workbook.SheetNames[0] as string];
	if (!sheet) throw new Error("Workbook worksheet is unreadable");
	const rows = xlsx.utils.sheet_to_json<Record<string, unknown>>(sheet, {
		defval: "",
		raw: true,
	});
	if (rows.length > CUSTOMER_IMPORT_MAX_ROWS)
		throw new Error(
			`Workbook exceeds the ${CUSTOMER_IMPORT_MAX_ROWS.toLocaleString()}-row safety limit`,
		);
	if (Object.keys(rows[0] ?? {}).length > MAX_COLUMNS)
		throw new Error("Workbook exceeds the 64-column safety limit");
	return parseCustomerImportRows(rows);
}

export async function readCustomerImportFile(
	file: Blob & { readonly name?: string },
): Promise<CustomerImportParseResult> {
	if (file.size > CUSTOMER_IMPORT_MAX_BYTES)
		throw new Error("File is larger than the 10 MB safety limit");
	const fileName = file.name ?? "customers.xlsx";
	const buffer = await file.arrayBuffer();
	if (typeof Worker !== "function")
		return readCustomerImportBuffer(buffer, fileName);
	const worker = new Worker(
		new URL("./customerTransferWorker.ts", import.meta.url),
		{ type: "module" },
	);
	return new Promise((resolve, reject) => {
		let settled = false;
		const finish = (callback: () => void) => {
			if (settled) return;
			settled = true;
			window.clearTimeout(timeout);
			worker.terminate();
			callback();
		};
		const timeout = window.setTimeout(() => {
			finish(() =>
				reject(
					new Error("Spreadsheet parsing timed out; the file was not imported"),
				),
			);
		}, 30_000);
		worker.addEventListener(
			"message",
			(event: MessageEvent<CustomerImportParseResult | { error: string }>) => {
				finish(() => {
					if ("error" in event.data) reject(new Error(event.data.error));
					else resolve(event.data);
				});
			},
			{ once: true },
		);
		worker.addEventListener(
			"error",
			() =>
				finish(() =>
					reject(
						new Error("Spreadsheet parser failed; the file was not imported"),
					),
				),
			{ once: true },
		);
		worker.addEventListener(
			"messageerror",
			() =>
				finish(() =>
					reject(new Error("Spreadsheet parser returned an invalid result")),
				),
			{ once: true },
		);
		worker.postMessage({ buffer, fileName }, [buffer]);
	});
}

export async function createCustomerExportFile(
	customers: ReadonlyArray<CustomerResponse>,
): Promise<Blob> {
	const xlsx = await import("xlsx");
	const rows = customersToSpreadsheetRows(customers);
	const sheet = xlsx.utils.json_to_sheet([...rows]);
	const workbook = xlsx.utils.book_new();
	xlsx.utils.book_append_sheet(workbook, sheet, "Customers");
	const bytes = xlsx.write(workbook, {
		bookType: "xlsx",
		type: "array",
		compression: true,
	});
	return new Blob([bytes], {
		type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
	});
}
