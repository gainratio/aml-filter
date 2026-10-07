import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	type Browser,
	type BrowserContext,
	expect,
	type Page,
	type TestInfo,
	test,
} from "@playwright/test";

/**
 * C1 — the signing-key export/import journey over the minified production
 * build. The key is exported as a standard age file (scrypt, sealed in a
 * short-lived Worker), imported into a FRESH browser context, and a key file
 * written by the previous release (PBKDF2 + AES-GCM JSON, the committed
 * golden fixture) still imports. A wrong passphrase changes nothing.
 *
 * It also proves the age library is lazy: nothing that carries it is fetched
 * until the user exports or imports.
 */

const ANALYST = "C1 Analyst";
const PASSPHRASE = "a long export passphrase";
const GOLDEN_FILE = join(
	import.meta.dirname,
	"../../../packages/amlfilter-browser/src/engine/__fixtures__/install-key-export-v1.golden.json",
);
const GOLDEN_PASSPHRASE = "golden fixture passphrase v1";
const GOLDEN_PUBLIC_KEY =
	"5526f742941711b3bc530ba44ff6f6dab0f0ab71af832f41a7fe3b9fdaed9c60";
/** typage's scrypt stanza label: only the age-encryption chunk carries it. */
const AGE_LIBRARY_MARKER = "age-encryption.org/v1/scrypt";
const CRYPTO_TIMEOUT_MS = 60_000;

interface Watch {
	readonly errors: string[];
	readonly ageChunks: string[];
	readonly sealWorkers: string[];
}

function watch(context: BrowserContext, page: Page): Watch {
	const seen: Watch = { errors: [], ageChunks: [], sealWorkers: [] };
	page.on("pageerror", (err) => seen.errors.push(`pageerror: ${err.message}`));
	page.on("console", (msg) => {
		if (msg.type() === "error") {
			seen.errors.push(`console.error: ${msg.text()}`);
		}
	});
	page.on("worker", (worker) => {
		if (worker.url().includes("installKeySeal.worker")) {
			seen.sealWorkers.push(worker.url());
		}
	});
	context.on("response", async (response) => {
		if (!response.url().endsWith(".js")) {
			return;
		}
		const body = await response.text().catch(() => "");
		if (body.includes(AGE_LIBRARY_MARKER)) {
			seen.ageChunks.push(response.url());
		}
	});
	return seen;
}

async function openSettings(page: Page): Promise<string> {
	await page.goto("/settings", { waitUntil: "domcontentloaded" });
	const analyst = page.locator("#analyst-name");
	const publicKey = page.getByTestId("signing-public-key");
	await expect(analyst.or(publicKey)).toBeVisible({ timeout: 60_000 });
	if (await analyst.isVisible()) {
		await analyst.fill(ANALYST);
		await analyst.press("Enter");
	}
	await expect(publicKey).toHaveText(/^[0-9a-f]{64}$/, { timeout: 60_000 });
	return (await publicKey.textContent()) ?? "";
}

async function shot(page: Page, info: TestInfo, name: string): Promise<void> {
	const dir = process.env.E2E_SCREENSHOT_DIR;
	const path = dir ? join(dir, `${name}.png`) : info.outputPath(`${name}.png`);
	await page.screenshot({ path, fullPage: true });
}

async function importFile(
	page: Page,
	file: string,
	passphrase: string,
): Promise<void> {
	await page.getByLabel("Key file").setInputFiles(file);
	await page.getByLabel("Import passphrase").fill(passphrase);
	await page.getByRole("button", { name: "Import key" }).click();
}

async function freshPage(browser: Browser) {
	const context = await browser.newContext();
	const page = await context.newPage();
	return { context, page, seen: watch(context, page) };
}

test("exports an age file, imports it in a fresh browser, and still imports the old format", async ({
	browser,
}, info) => {
	test.setTimeout(300_000);

	// --- browser A: export ---------------------------------------------
	const a = await freshPage(browser);
	const keyA = await openSettings(a.page);
	expect(a.seen.ageChunks, "age is not loaded before export").toEqual([]);

	await a.page.getByLabel("Passphrase", { exact: true }).fill(PASSPHRASE);
	await a.page.getByLabel("Repeat passphrase").fill(`${PASSPHRASE}x`);
	const mismatch = a.page.getByText("Passwords don't match.");
	await expect(mismatch).toBeVisible();
	await expect(mismatch).toHaveAttribute("role", "alert");
	await expect(a.page.getByLabel("Repeat passphrase")).toHaveAttribute(
		"aria-describedby",
		"export-confirm-problem",
	);
	await shot(a.page, info, "aml-seal-1-mismatch");

	await a.page.getByLabel("Repeat passphrase").fill(PASSPHRASE);
	await expect(mismatch).toHaveCount(0);
	const download = a.page.waitForEvent("download");
	await a.page.getByRole("button", { name: "Export encrypted key" }).click();
	const saved = await download;
	expect(saved.suggestedFilename()).toBe(
		`amlfilter-signing-key-${keyA.slice(0, 8)}.age`,
	);
	const file = info.outputPath("exported.age");
	await saved.saveAs(file);
	await expect(a.page.getByText("Key exported.")).toBeVisible({
		timeout: CRYPTO_TIMEOUT_MS,
	});
	expect(readFileSync(file, "latin1")).toMatch(
		/^age-encryption\.org\/v1\n-> scrypt \S+ 17\n/,
	);
	expect(a.seen.sealWorkers, "scrypt ran in its own Worker").toHaveLength(1);
	expect(a.seen.ageChunks.length, "age loads on export").toBeGreaterThan(0);
	await shot(a.page, info, "aml-seal-2-exported");

	// --- browser B (fresh context): wrong passphrase, then the right one -
	const b = await freshPage(browser);
	const keyB = await openSettings(b.page);
	expect(keyB).not.toBe(keyA);

	await importFile(b.page, file, "not the passphrase at all");
	await expect(
		b.page.getByText(
			"Wrong passphrase, or the file was changed. Nothing was imported.",
		),
	).toBeVisible({ timeout: CRYPTO_TIMEOUT_MS });
	await expect(b.page.getByTestId("signing-public-key")).toHaveText(keyB);
	await shot(b.page, info, "aml-seal-3-wrong-passphrase");

	await importFile(b.page, file, PASSPHRASE);
	await expect(
		b.page.getByText(`Key imported. Public key: ${keyA}`),
	).toBeVisible({ timeout: CRYPTO_TIMEOUT_MS });
	await expect(b.page.getByTestId("signing-public-key")).toHaveText(keyA);
	await shot(b.page, info, "aml-seal-4-imported");

	// --- browser C (fresh context): a key file from the previous release -
	const c = await freshPage(browser);
	await openSettings(c.page);
	await importFile(c.page, GOLDEN_FILE, GOLDEN_PASSPHRASE);
	await expect(
		c.page.getByText(`Key imported. Public key: ${GOLDEN_PUBLIC_KEY}`),
	).toBeVisible({ timeout: CRYPTO_TIMEOUT_MS });
	await expect(c.page.getByTestId("signing-public-key")).toHaveText(
		GOLDEN_PUBLIC_KEY,
	);
	expect(c.seen.ageChunks, "a v1 file needs no age code").toEqual([]);
	await shot(c.page, info, "aml-seal-5-legacy-import");

	for (const side of [a, b, c]) {
		expect(side.seen.errors, "console stays clean").toEqual([]);
		await side.context.close();
	}
});
