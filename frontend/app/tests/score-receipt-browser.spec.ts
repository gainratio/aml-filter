import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";

// Real-browser proof for the Avow score receipt.
//
// The unit suite (packages/amlfilter-browser/src/engine/scoreReceipt.test.ts)
// runs under the `node` environment because jsdom's second JavaScript realm
// breaks @noble/ed25519's `subtle.digest(..., m.buffer)` call on Node 22 — a
// harness artifact a browser cannot have. That switch is only defensible if
// something actually proves the signing path in a REAL browser, which is what
// this spec does: it imports the production scoreReceipt module into a live
// browser page (through the app's own Vite dev server) and drives
// sign -> verify -> tamper-reject -> wrong-key-reject with a clean console.
//
// The production screening path DOES seal through this module (matchReceipts.ts
// → createMatchReceiptSealer), and the user journey — seal → display → verify →
// rekey-fail-closed — is proven over the minified build by
// tests/e2e-c1/receipt-badge.spec.ts. This spec is NOT redundant with that
// lane: it is the only module-level real-browser proof of the crypto contract
// (sign -> verify -> tamper-reject -> wrong-key-reject), which is what makes
// the unit suite's `@vitest-environment node` opt-out defensible.
//
// Vite dev serves arbitrary workspace sources under /@fs/<abs path>, which is
// how the unbundled package module is reachable from the page.
const MODULE = `/@fs${fileURLToPath(
	new URL(
		"../../packages/amlfilter-browser/src/engine/scoreReceipt.ts",
		import.meta.url,
	),
)}`;

const ASSAY_MODULE = `/@fs${fileURLToPath(
	new URL(
		"../../packages/amlfilter-browser/src/engine/assayScoring.ts",
		import.meta.url,
	),
)}`;

test("Avow score receipt signs + verifies in a real browser", async ({
	page,
}) => {
	const consoleErrors: string[] = [];
	page.on("console", (m) => {
		if (m.type() === "error") consoleErrors.push(m.text());
	});
	page.on("pageerror", (e) => consoleErrors.push(`pageerror: ${e.message}`));

	await page.goto("/", { waitUntil: "domcontentloaded" });

	const out = await page.evaluate(
		async ({ modUrl, assayUrl }) => {
			const result: Record<string, unknown> = {};
			const mod = await import(/* @vite-ignore */ modUrl);
			const assay = await import(/* @vite-ignore */ assayUrl);

			const seedHex = () =>
				Array.from(crypto.getRandomValues(new Uint8Array(32)))
					.map((b) => b.toString(16).padStart(2, "0"))
					.join("");

			result.realm = {
				subtleIsBrowserNative: globalThis.crypto.subtle instanceof SubtleCrypto,
				bufferSameRealm: new Uint8Array([1]).buffer instanceof ArrayBuffer,
			};

			// The EXACT call shape @noble/ed25519 index.js:793 uses — the one that
			// failed under jsdom on Node 22 (cross-realm bare ArrayBuffer).
			try {
				await crypto.subtle.digest("SHA-512", new Uint8Array([1, 2, 3]).buffer);
				result.nobleCallShape =
					"ACCEPTED (subtle.digest with bare ArrayBuffer)";
			} catch (e) {
				result.nobleCallShape = `REJECTED: ${(e as Error).message}`;
			}

			const evidence = assay.calculateAssayScore(
				{
					name_vector: 0.8,
					name_sequence: 0.6,
					alias_match: 1,
					dob_match: 0.5,
					country_match: 0.25,
				},
				{
					name_vector: 0.55,
					name_sequence: 0.2,
					alias_match: 0.35,
					dob_match: 0.1,
					country_match: 0.05,
				},
			);
			const MATCH = {
				score: evidence.score,
				tier: "STRONG" as const,
				possibleThreshold: 0.65,
				assay: evidence,
			};
			const CONTEXT = {
				engineVersion: "4.0.0",
				watchlistVersion: "2026.06.09",
				inputsHash:
					"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
			};
			const subject = mod.matchScoreSubject(MATCH, CONTEXT);

			// Real Ed25519 signing through @gainratio/avow -> @noble/ed25519.
			const receipt = await mod.signMatchReceipt(subject, seedHex());
			const pinned = receipt.public_key;

			result.signed = {
				score: receipt.payload.score,
				tier: receipt.payload.tier,
				method: receipt.payload.assay?.method.id,
				policy: receipt.payload.assay?.method.version,
				publicKeyPrefix: String(pinned).slice(0, 16),
				signaturePrefix: String(receipt.signature).slice(0, 24),
				signatureLen: String(receipt.signature).length,
			};

			try {
				await mod.verifyMatchReceipt(receipt, pinned);
				result.verifyHonest = "PASS (resolved)";
			} catch (e) {
				result.verifyHonest = `FAIL: ${(e as Error).message}`;
			}

			try {
				await mod.verifyMatchReceipt(
					{ ...receipt, payload: { ...receipt.payload, score: 0.01 } },
					pinned,
				);
				result.verifyTampered = "FAIL — tampered receipt ACCEPTED";
			} catch (e) {
				result.verifyTampered = `PASS rejected as ${(e as Error).constructor.name}`;
			}

			try {
				const other = await mod.signMatchReceipt(subject, seedHex());
				await mod.verifyMatchReceipt(receipt, other.public_key);
				result.verifyWrongKey = "FAIL — wrong-key receipt ACCEPTED";
			} catch (e) {
				result.verifyWrongKey = `PASS rejected as ${(e as Error).constructor.name}`;
			}

			return result;
		},
		{ modUrl: MODULE, assayUrl: ASSAY_MODULE },
	);

	console.log("=== REAL BROWSER EVIDENCE ===");
	console.log(JSON.stringify(out, null, 2));
	console.log(
		"console errors:",
		consoleErrors.length === 0 ? "NONE (clean)" : consoleErrors,
	);

	expect(out.nobleCallShape).toContain("ACCEPTED");
	expect(out.verifyHonest).toContain("PASS");
	expect(out.verifyTampered).toContain("PASS");
	expect(out.verifyWrongKey).toContain("PASS");
	expect(out.signed).toMatchObject({
		method: "additive",
		policy: "amlfilter.additive.v2",
	});
	expect(consoleErrors).toEqual([]);
});
