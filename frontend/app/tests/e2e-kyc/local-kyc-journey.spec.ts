import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Route, test } from "@playwright/test";
import * as XLSX from "xlsx";

/**
 * The local-first KYC workstation slice journey, end-to-end with no backend:
 *
 *   open /customers with NO login → one-time analyst name → onboard a
 *   customer whose name is in the committed signed demo bundle → the
 *   sanctions-match warning fires → the Review Board shows the TIERED match
 *   → resolve it (reviewer stamped from the analyst settings row) → reload:
 *   the customer, the match, and the disposition all survived (OPFS) →
 *   a NEW watchlist is published → "Check for updates" detects it (real signed
 *   bundle poll), reloads + re-screens, and the disposition carries forward.
 *
 * Asserts REAL outcomes (rendered tiers, persisted rows, dup-rejection,
 * console hygiene), against the REAL minified build + the REAL committed signed
 * BUNDLE (app/public/bundle/origin: signed `latest` → content-hashed `manifest`
 * → `chunk/` CAS) + the REAL pinned key — per the CLAUDE.md browser-validation
 * mandate. The kyc build sets no VITE_BUNDLE_BASE_URL, so the runtime defaults to
 * /bundle/origin and the early steps (onboard → tier → resolve → reload-persists)
 * boot over the committed bundle AUTOMATICALLY, with no route needed.
 *
 * The new-publish step is driven the REAL way (no test seam): a SECOND signed
 * BUNDLE with the OFAC list bumped to version "demo-2" (EU/UN/UK stay demo-1)
 * lives under tests/e2e-bundle/fixtures/bundle-v2/origin — the SAME committed v2
 * bundle fixture the bundle delta-sync e2e (`tests/e2e-bundle/delta-sync.spec.ts`)
 * uses. A Playwright route serves the committed demo-1 bundle normally, then —
 * once `servePublishV2` flips — serves the v2 bundle (signed `latest` +
 * `manifest/<hash>` + `chunk/<hash>`) so the running tab's cheap signed `/latest`
 * poll sees a genuinely newer, validly-signed bundle whose COMPOSITE version stamp
 * now carries OFAC_SDN@demo-2.
 */

// "Ivan Fakovich" is entity OFAC_SDN:0001 in the committed signed OFAC list
// (countries: RU) — the same name the C1 /screen e2e matches against.
const SANCTIONED_NAME = "Ivan Fakovich";
const CUSTOMER_REF = "CUST-LOCAL-001";
const ANALYST = "Avery Analyst";
const REVIEW_NOTES = "Resolved as noise in the local-first e2e journey.";

const HERE = dirname(fileURLToPath(import.meta.url));
// The committed v2 bundle fixture (version "demo-2", OFAC bumped) routed in once
// `servePublishV2` flips — the SAME fixture the bundle delta-sync e2e uses.
const V2_ORIGIN = join(HERE, "../e2e-bundle/fixtures/bundle-v2/origin");

/** Path tail after `/bundle/origin/` for a routed request, or null if not ours. */
function bundleTail(url: string): string | null {
	const marker = "/bundle/origin/";
	const at = url.indexOf(marker);
	if (at < 0) {
		return null;
	}
	// Strip any query string; the CAS layout has no query params.
	return url.slice(at + marker.length).split("?")[0] ?? null;
}

test.describe.configure({ mode: "serial" });

test("local-first journey: no login → onboard → tiered match → resolve → persists → new publish re-screens → suppressed-unchanged + profile-edit CHANGED + settings rescan", async ({
	page,
}) => {
	test.setTimeout(180_000);
	// This journey intentionally exercises the all-list throughput path. Declare
	// the capability explicitly; real browsers with an unknown or ≤8 GB budget
	// use bounded streaming and are covered by the memory-policy unit contract.
	await page.addInitScript(() => {
		Object.defineProperty(navigator, "deviceMemory", {
			configurable: true,
			value: 16,
		});
	});

	// --- Console hygiene across the whole journey. -------------------------
	const consoleErrors: string[] = [];
	page.on("pageerror", (err) =>
		consoleErrors.push(`pageerror: ${err.message}`),
	);
	page.on("console", (msg) => {
		if (msg.type() === "error")
			consoleErrors.push(`console.error: ${msg.text()}`);
	});

	// --- New-publish route: serve the committed demo-1 bundle until the test
	//     flips `servePublishV2`, then serve the validly-signed demo-2 bundle
	//     (OFAC bumped) from the committed v2 fixture so the tab's signed `/latest`
	//     poll detects a real new publish. The fixture mirrors the /bundle/origin
	//     CAS layout, so each intercepted request tail maps 1:1 to a fixture file.
	//     (This is exactly how delta-sync.spec.ts flips to the v2 bundle.) -------
	let servePublishV2 = false;
	await page.route("**/bundle/origin/**", async (route: Route) => {
		if (!servePublishV2) {
			await route.continue();
			return;
		}
		const tail = bundleTail(route.request().url());
		if (tail === null) {
			await route.continue();
			return;
		}
		const body = readFileSync(join(V2_ORIGIN, tail));
		const contentType =
			tail === "latest" ? "application/json" : "application/octet-stream";
		await route.fulfill({
			status: 200,
			contentType,
			// no-store so the mutable /latest pointer is never served stale from the
			// browser HTTP cache (mirrors the engine's own cache:"no-store" intent).
			headers: { "cache-control": "no-store" },
			body,
		});
	});

	// =======================================================================
	// 1. The workstation is reachable directly — no login, no API key.
	// =======================================================================
	await page.goto("/customers");
	await expect(page).toHaveTitle(/AML-Filter/i); // port-collision guard
	await expect(page).toHaveURL(/\/customers$/);

	// =======================================================================
	// 2. One-time analyst name (a SQLite settings row).
	// =======================================================================
	await expect(
		page.getByRole("heading", { name: /welcome to the workstation/i }),
	).toBeVisible();
	await page.locator("#analyst-name").fill(ANALYST);
	await page.getByRole("button", { name: /start reviewing/i }).click();
	await expect(
		page.getByRole("heading", { name: "KYC Customer Onboarding" }),
	).toBeVisible();

	// =======================================================================
	// 3. Onboard a sanctioned name: in-tab screen → tiered match persisted.
	//    (Submitting awaits the engine internally — sync + ~23 MB model.)
	// =======================================================================
	await page.locator("#customer-reference").fill(CUSTOMER_REF);
	await page.locator("#customer-name").fill(SANCTIONED_NAME);
	await page.locator("#customer-country").fill("RU");
	await page.getByRole("button", { name: "Onboard" }).click();

	const onboardAlert = page.locator(".alert-warning");
	await expect(onboardAlert).toContainText(/potential sanctions match/i, {
		timeout: 120_000, // first run downloads the model
	});
	await expect(onboardAlert).toContainText(CUSTOMER_REF);
	await expect(
		page.getByRole("cell", { name: CUSTOMER_REF, exact: true }),
	).toBeVisible();

	// =======================================================================
	// 4. Review Board: the match renders TIERED and PENDING.
	// =======================================================================
	await page.goto("/review");
	await expect(
		page.getByRole("heading", { name: "Review Board" }),
	).toBeVisible();
	await page.locator("#status-filter").selectOption("PENDING");
	const row = page.locator("tbody tr", { hasText: CUSTOMER_REF });
	await expect(row).toBeVisible();
	// The tier is computed by the parity-locked classifier over the real
	// score; an exact self-match sits at the STRONG/POSSIBLE boundary, so
	// assert a real tier badge rather than hardcoding the band.
	await expect(
		row.locator(".badge", { hasText: /^(Strong|Possible)$/ }),
	).toBeVisible();
	await expect(
		row.locator(".badge", { hasText: "Needs review" }),
	).toBeVisible();
	await expect(row).toContainText(SANCTIONED_NAME);

	// =======================================================================
	// 5. Resolve with notes, reviewer left BLANK — the analyst settings row
	//    must stamp the audit trail (spec §9.5).
	// =======================================================================
	await row
		.getByRole("combobox", {
			name: new RegExp(`Disposition for ${CUSTOMER_REF}`),
		})
		.selectOption("FALSE_POSITIVE");
	await row
		.getByRole("textbox", { name: new RegExp(`Notes for ${CUSTOMER_REF}`) })
		.fill(REVIEW_NOTES);
	await row.getByRole("button", { name: "Resolve" }).click();
	await expect(row.locator(".badge", { hasText: "Not a match" })).toBeVisible();
	await expect(row).toContainText(ANALYST);

	// =======================================================================
	// 6. Persistence: reload — everything is still there (SQLite in OPFS).
	// =======================================================================
	await page.reload();
	const reloadedRow = page.locator("tbody tr", { hasText: CUSTOMER_REF });
	await expect(reloadedRow).toBeVisible();
	await expect(
		reloadedRow.locator(".badge", { hasText: "Not a match" }),
	).toBeVisible();
	await expect(reloadedRow).toContainText(ANALYST);
	await expect(reloadedRow).toContainText(REVIEW_NOTES);

	// …and it has LEFT the pending queue (spec §8.3): filtering to PENDING
	// after the reload shows no row for this customer.
	await page.locator("#status-filter").selectOption("PENDING");
	await expect(page.locator("tbody tr", { hasText: CUSTOMER_REF })).toHaveCount(
		0,
	);
	await page.locator("#status-filter").selectOption("");

	// The analyst name persisted too: no re-prompt on the customers page.
	await page.goto("/customers");
	await expect(
		page.getByRole("heading", { name: "KYC Customer Onboarding" }),
	).toBeVisible();
	await expect(
		page.getByRole("cell", { name: CUSTOMER_REF, exact: true }),
	).toBeVisible();

	// =======================================================================
	// 6b. LIVE new-publish detection (the headline feature): a newer BUNDLE
	//     (OFAC bumped to "demo-2", EU/UN/UK still "demo-1") goes live AFTER this
	//     tab booted on the all-demo-1 bundle. Flip the route to serve the
	//     validly-signed v2 bundle, then drive "Check for updates". The tab's
	//     cheap signed `/latest` poll must see the composite stamp advance
	//     (…|OFAC_SDN@demo-2|… ≠ …|OFAC_SDN@demo-1|…), delta-sync + RELOAD every
	//     list into the running engine (fail-closed verify), then re-screen every
	//     customer. The previously-resolved match MUST survive with its
	//     FALSE_POSITIVE disposition (proof replaceMatches carries the audit trail
	//     forward across a real reload + rescan).
	// =======================================================================
	servePublishV2 = true;
	await page.getByRole("button", { name: "Check for updates" }).click();
	// A real re-screen ran against the newly-published list (≥1 customer scanned).
	await expect(page.getByText(/Re-screened \d+ customer\(s\)/)).toBeVisible({
		timeout: 120_000,
	});
	// The UI now reports the advanced composite stamp as the last-synced version:
	// the OFAC list moved to demo-2 (EU/UN/UK stay demo-1), so the composite
	// "Last synced: …|OFAC_SDN@demo-2|…" carries OFAC_SDN@demo-2. Matching that
	// substring proves the new publish was genuinely detected and loaded, not the
	// frozen boot-time version.
	await expect(page.getByText(/OFAC_SDN@demo-2/)).toBeVisible();

	// The resolved match survived the rescan with its disposition preserved.
	await page.goto("/review");
	await expect(
		page.getByRole("heading", { name: "Review Board" }),
	).toBeVisible();
	const rescannedRow = page.locator("tbody tr", { hasText: CUSTOMER_REF });
	await expect(rescannedRow).toBeVisible();
	await expect(
		rescannedRow.locator(".badge", { hasText: "Not a match" }),
	).toBeVisible();
	await expect(rescannedRow).toContainText(ANALYST);
	await expect(rescannedRow).toContainText(REVIEW_NOTES);

	// Reload after the rescan: customer, match, and resolution all persist (OPFS).
	await page.reload();
	const afterRescanReload = page.locator("tbody tr", { hasText: CUSTOMER_REF });
	await expect(afterRescanReload).toBeVisible();
	await expect(
		afterRescanReload.locator(".badge", { hasText: "Not a match" }),
	).toBeVisible();
	await expect(afterRescanReload).toContainText(REVIEW_NOTES);

	// Back to /customers for the dup-rejection step.
	await page.goto("/customers");
	await expect(
		page.getByRole("heading", { name: "KYC Customer Onboarding" }),
	).toBeVisible();

	// =======================================================================
	// 7. Dup-rejection: onboarding the same reference fails loudly.
	// =======================================================================
	await page.locator("#customer-reference").fill(CUSTOMER_REF);
	await page.locator("#customer-name").fill(SANCTIONED_NAME);
	await page.getByRole("button", { name: "Onboard" }).click();
	await expect(page.locator(".alert-error")).toContainText(/already exists/i);

	// =======================================================================
	// 9 (Theme B / wave 2). Suppressed-on-unchanged-rescan + History trail.
	//
	//   Re-screening with NOTHING materially changed must keep the match
	//   suppressed as FALSE_POSITIVE — no fresh PENDING alert, no CHANGED flag.
	//   We drive a REAL re-screen via the row's Edit → Save affordance, saving
	//   the SAME identity ("Ivan Fakovich" / "RU"). screenCustomer recomputes
	//   the material fingerprint; an identical fingerprint carries the prior
	//   disposition forward with NO event (workstation operations.ts §6
	//   "unchanged -> carry forward, suppress"). The History drawer then proves
	//   the accumulated audit trail: DETECTED (onboard) + DISPOSITIONED (resolve).
	// =======================================================================
	const editTrigger = page.getByRole("button", {
		name: `Edit ${CUSTOMER_REF}`,
	});
	await expect(editTrigger).toBeVisible();
	await editTrigger.click();
	await page
		.getByRole("textbox", { name: `Edit name for ${CUSTOMER_REF}` })
		.fill(SANCTIONED_NAME);
	await page
		.getByRole("textbox", { name: `Edit country for ${CUSTOMER_REF}` })
		.fill("RU");
	await page.getByRole("button", { name: "Save" }).click();
	// The Save (re-screen) settled — the inline editor closed (Edit is back).
	await expect(
		page.getByRole("button", { name: `Edit ${CUSTOMER_REF}` }),
	).toBeVisible({ timeout: 120_000 });

	await page.goto("/review");
	await expect(
		page.getByRole("heading", { name: "Review Board" }),
	).toBeVisible();
	const unchangedRow = page.locator("tbody tr", { hasText: CUSTOMER_REF });
	await expect(unchangedRow).toBeVisible();
	// Still suppressed as FALSE_POSITIVE — the unchanged re-screen did not
	// re-open it, and it is NOT flagged CHANGED.
	await expect(
		unchangedRow.locator(".badge", { hasText: "Not a match" }),
	).toBeVisible();
	await expect(unchangedRow).not.toContainText("CHANGED — needs re-review");
	// No NEW pending alert was raised for this customer by the unchanged rescan.
	await page.locator("#status-filter").selectOption("PENDING");
	await expect(page.locator("tbody tr", { hasText: CUSTOMER_REF })).toHaveCount(
		0,
	);
	await page.locator("#status-filter").selectOption("");

	// History: the drawer shows the DETECTED (onboard) and DISPOSITIONED
	// (resolve) events of the accumulated audit trail.
	await expect(unchangedRow).toBeVisible();
	await unchangedRow
		.getByRole("button", { name: `History for ${CUSTOMER_REF}` })
		.click();
	const historyA = page.locator("tbody tr:has(li)");
	await expect(historyA.getByText("Match found")).toBeVisible();
	await expect(historyA.getByText("Decision recorded")).toBeVisible();
	// Collapse the drawer again before moving on.
	await unchangedRow
		.getByRole("button", { name: `History for ${CUSTOMER_REF}` })
		.click();

	// =======================================================================
	// 10 (Theme B / wave 2). Profile name-edit → CHANGED, with the full audit
	//     trail carried forward, surfaced by the View filter.
	//
	//   Edit the customer's NAME to a minor variation that still re-hits the
	//   SAME entity (DEMO_SDN:0001 "ivan fakovich"): "Ivan A. Fakovich" shares
	//   both identity-bearing tokens, so it scores above threshold, but the
	//   normalized profile differs → a NEW material fingerprint → CHANGED. The
	//   prior FALSE_POSITIVE disposition is carried forward and the row is
	//   flagged "CHANGED — needs re-review". A CHANGED row now exposes the inline
	//   Resolve controls (needsAction unions CHANGED), so we re-disposition it
	//   back to CURRENT and assert the accumulated audit trail.
	// =======================================================================
	const CHANGED_NAME = "Ivan A. Fakovich";
	await page.goto("/customers");
	await expect(
		page.getByRole("heading", { name: "KYC Customer Onboarding" }),
	).toBeVisible();
	await page.getByRole("button", { name: `Edit ${CUSTOMER_REF}` }).click();
	await page
		.getByRole("textbox", { name: `Edit name for ${CUSTOMER_REF}` })
		.fill(CHANGED_NAME);
	await page
		.getByRole("textbox", { name: `Edit country for ${CUSTOMER_REF}` })
		.fill("RU");
	await page.getByRole("button", { name: "Save" }).click();
	await expect(
		page.getByRole("button", { name: `Edit ${CUSTOMER_REF}` }),
	).toBeVisible({ timeout: 120_000 });

	await page.goto("/review");
	await expect(
		page.getByRole("heading", { name: "Review Board" }),
	).toBeVisible();

	// The View filter narrows to "Changed only" — the materially-changed row
	// is listed there.
	await page.locator("#view-filter").selectOption("CHANGED");
	const changedRow = page.locator("tbody tr", { hasText: CUSTOMER_REF });
	await expect(changedRow).toBeVisible();
	await expect(changedRow.getByText("CHANGED — needs re-review")).toBeVisible();
	// It still carries the prior FALSE_POSITIVE disposition while flagged CHANGED.
	await expect(
		changedRow.locator(".badge", { hasText: "Not a match" }),
	).toBeVisible();

	// History before re-disposition: the prior DISPOSITIONED (FALSE_POSITIVE)
	// event carried forward, PLUS a CHANGED event from the profile edit.
	await changedRow
		.getByRole("button", { name: `History for ${CUSTOMER_REF}` })
		.click();
	const changedHistory = page.locator("tbody tr:has(li)");
	await expect(changedHistory.getByText("Decision recorded")).toBeVisible();
	await expect(
		changedHistory.locator("li", { hasText: "Details changed" }),
	).toBeVisible();
	await changedRow
		.getByRole("button", { name: `History for ${CUSTOMER_REF}` })
		.click();

	// The "Needs review (new + changed)" view also surfaces the CHANGED row
	// (the query is `resolution_status = PENDING OR review_state = CHANGED`),
	// so a re-review queue includes it alongside fresh PENDING hits.
	await page.locator("#view-filter").selectOption("NEEDS_REVIEW");
	const needsReviewRow = page.locator("tbody tr", { hasText: CUSTOMER_REF });
	await expect(needsReviewRow).toBeVisible();
	await expect(
		needsReviewRow.getByText("CHANGED — needs re-review"),
	).toBeVisible();

	// Re-disposition the CHANGED row back to CURRENT. The ReviewBoardPage now
	// renders the inline Resolve controls when `needsAction(match)` is true —
	// `resolution_status === "PENDING" OR review_state === "CHANGED"` — so the
	// CHANGED row exposes the SAME controls a PENDING row does: the Disposition
	// select, Reviewer / Notes inputs, and the "Resolve" button. Re-confirm it
	// as FALSE_POSITIVE (the analyst re-reviewed the changed profile and stands
	// by the prior call). `resolveReviewMatch` writes a fresh DISPOSITIONED
	// event and resets `review_state` to CURRENT, so the CHANGED flag clears.
	const RE_REVIEW_NOTES = "Re-reviewed after profile edit; still noise.";
	await needsReviewRow
		.getByRole("combobox", {
			name: new RegExp(`Disposition for ${CUSTOMER_REF}`),
		})
		.selectOption("FALSE_POSITIVE");
	await needsReviewRow
		.getByRole("textbox", { name: new RegExp(`Notes for ${CUSTOMER_REF}`) })
		.fill(RE_REVIEW_NOTES);
	await needsReviewRow.getByRole("button", { name: "Resolve" }).click();
	// It returns to CURRENT: the "CHANGED — needs re-review" badge disappears.
	await expect(
		needsReviewRow.getByText("CHANGED — needs re-review"),
	).toHaveCount(0);

	// History now logs the full trail: the ORIGINAL DISPOSITIONED, the CHANGED
	// event from the profile edit, and the NEW DISPOSITIONED from this re-review
	// (so 2 DISPOSITIONED entries plus a CHANGED entry). Reload first so the
	// board remounts with a fresh (uncached) per-match history — the drawer
	// loads each match's audit trail lazily and caches it, so without a reload
	// an already-opened drawer would show the pre-re-disposition trail.
	await page.goto("/review");
	await page.reload();
	await expect(
		page.getByRole("heading", { name: "Review Board" }),
	).toBeVisible();
	await page.locator("#view-filter").selectOption("ALL");
	const reReviewedRow = page.locator("tbody tr", { hasText: CUSTOMER_REF });
	await expect(reReviewedRow).toBeVisible();
	await expect(
		reReviewedRow.getByText("CHANGED — needs re-review"),
	).toHaveCount(0);
	await reReviewedRow
		.getByRole("button", { name: `History for ${CUSTOMER_REF}` })
		.click();
	const reReviewHistory = page.locator("tbody tr:has(li)");
	await expect(
		reReviewHistory.locator("li", { hasText: "Details changed" }),
	).toBeVisible();
	await expect(
		reReviewHistory.locator("li", { hasText: "Decision recorded" }),
	).toHaveCount(2);
	await reReviewedRow
		.getByRole("button", { name: `History for ${CUSTOMER_REF}` })
		.click();

	// "Changed only" no longer lists the row (it is CURRENT now); "All" still does.
	await page.locator("#view-filter").selectOption("CHANGED");
	await expect(page.locator("tbody tr", { hasText: CUSTOMER_REF })).toHaveCount(
		0,
	);
	await page.locator("#view-filter").selectOption("ALL");
	await expect(
		page.locator("tbody tr", { hasText: CUSTOMER_REF }),
	).toBeVisible();

	// =======================================================================
	// 11 (Theme B / wave 2). Settings sensitivity → Apply → re-screen RAN →
	//     persists across a full reload (OPFS).
	//
	//   Change the global sensitivity from the current "Balanced" to "Lenient"
	//   and Apply. setScreeningConfig persists the config THEN re-screens every
	//   customer; because the config genuinely changed, the rescan summary
	//   banner reports a customer count (the "Re-screened N customers …" path,
	//   NOT the "Settings unchanged" no-op).
	// =======================================================================
	await page.goto("/settings");
	await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
	const sensitivity = page.getByRole("radiogroup", {
		name: "Screening sensitivity",
	});
	// Current value is the default "Balanced".
	await expect(
		sensitivity.getByRole("radio", { name: "Balanced" }),
	).toHaveAttribute("aria-checked", "true");
	await sensitivity.getByRole("radio", { name: "Lenient" }).click();
	await expect(
		sensitivity.getByRole("radio", { name: "Lenient" }),
	).toHaveAttribute("aria-checked", "true");
	await page.getByRole("button", { name: "Apply" }).click();
	// The re-screen actually ran (a customer count), not the no-op banner.
	const rescanBanner = page.getByText(/Re-screened \d+ customers/);
	await expect(rescanBanner).toBeVisible({ timeout: 120_000 });

	// The board still renders with the new threshold in effect (asserting an
	// exact match-count delta is brittle; assert the board loads post-rescan).
	await page.goto("/review");
	await expect(
		page.getByRole("heading", { name: "Review Board" }),
	).toBeVisible();
	await expect(
		page.locator("tbody tr", { hasText: CUSTOMER_REF }),
	).toBeVisible();

	// Full reload: settings (sensitivity) AND dispositions persisted to OPFS.
	await page.goto("/settings");
	await page.reload();
	await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
	const sensitivityAfterReload = page.getByRole("radiogroup", {
		name: "Screening sensitivity",
	});
	await expect(
		sensitivityAfterReload.getByRole("radio", { name: "Lenient" }),
	).toHaveAttribute("aria-checked", "true");

	// =======================================================================
	// 11b (Theme A / wave 3). Watchlist selection: the Watchlists section lists
	//     EVERY signed-catalog list with a per-list toggle, all enabled by
	//     default. Disabling a NON-OFAC list → Apply re-bootstraps the engine
	//     over the smaller set and re-screens; screening still works (the OFAC
	//     hit survives), and the selection persists across a full reload (OPFS).
	// =======================================================================
	// All four committed demo lists are present and on by default.
	for (const title of [
		"OFAC SDN",
		"EU Consolidated",
		"UN Consolidated",
		"UK OFSI",
	]) {
		await expect(page.getByRole("checkbox", { name: title })).toBeChecked();
	}
	// Disable a non-OFAC list, then Apply (re-bootstrap + re-screen).
	await page.getByRole("checkbox", { name: "EU Consolidated" }).click();
	await expect(
		page.getByRole("checkbox", { name: "EU Consolidated" }),
	).not.toBeChecked();
	await page.getByRole("button", { name: "Apply" }).click();
	// Apply resolves with a confirmation banner — screening completed cleanly.
	await expect(page.locator(".alert-success")).toBeVisible({
		timeout: 120_000,
	});

	// Screening still works: the OFAC hit for our sanctioned customer remains.
	await page.goto("/review");
	await expect(
		page.getByRole("heading", { name: "Review Board" }),
	).toBeVisible();
	await expect(
		page.locator("tbody tr", { hasText: CUSTOMER_REF }),
	).toBeVisible();

	// The disabled-list selection persists across a full reload (OPFS settings).
	await page.goto("/settings");
	await page.reload();
	await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
	await expect(
		page.getByRole("checkbox", { name: "EU Consolidated" }),
	).not.toBeChecked();
	await expect(page.getByRole("checkbox", { name: "OFAC SDN" })).toBeChecked();

	await page.goto("/review");
	await page.reload();
	await expect(
		page.getByRole("heading", { name: "Review Board" }),
	).toBeVisible();
	const persistedRow = page.locator("tbody tr", { hasText: CUSTOMER_REF });
	await expect(persistedRow).toBeVisible();
	await expect(
		persistedRow.locator(".badge", { hasText: "Not a match" }),
	).toBeVisible();
	// The re-review notes (the most recent disposition, §10) persisted to OPFS.
	await expect(persistedRow).toContainText(RE_REVIEW_NOTES);

	// =======================================================================
	// 12. Console hygiene: zero browser errors across the entire journey.
	// =======================================================================
	expect(
		consoleErrors,
		`browser console errors:\n${consoleErrors.join("\n")}`,
	).toEqual([]);
});

test("customer spreadsheet transfer previews, imports, persists, and exports locally", async ({
	page,
}) => {
	test.setTimeout(180_000);
	const consoleErrors: string[] = [];
	page.on("pageerror", (error) =>
		consoleErrors.push(`pageerror: ${error.message}`),
	);
	page.on("console", (message) => {
		if (message.type() === "error")
			consoleErrors.push(`console.error: ${message.text()}`);
	});

	await page.goto("/customers");
	await expect(
		page.getByRole("heading", { name: /welcome to the workstation/i }),
	).toBeVisible();
	await page.locator("#analyst-name").fill("Spreadsheet Analyst");
	await page.getByRole("button", { name: /start reviewing/i }).click();
	await expect(
		page.getByRole("heading", { name: "KYC Customer Onboarding" }),
	).toBeVisible();

	await page.getByLabel("Customer spreadsheet").setInputFiles({
		name: "customers.csv",
		mimeType: "text/csv",
		buffer: Buffer.from(
			"customer_reference,name,country,dob\nSHEET-001,Imported Person,US,1980-01-02\n",
		),
	});
	await expect(
		page.getByRole("heading", { name: "Review customer import" }),
	).toBeVisible();
	await expect(page.getByText(/1 ready · 0 duplicate/)).toBeVisible();
	await page.getByRole("button", { name: "Import 1 customer" }).click();
	await expect(
		page.getByRole("status").filter({ hasText: /Imported 1 customer/ }),
	).toContainText(/Imported 1 customer/, {
		timeout: 120_000,
	});
	await expect(
		page.getByRole("cell", { name: "SHEET-001", exact: true }),
	).toBeVisible();

	const downloadPromise = page.waitForEvent("download");
	await page.getByRole("button", { name: "Export XLSX" }).click();
	const download = await downloadPromise;
	expect(download.suggestedFilename()).toMatch(
		/^aml-filter-customers-\d{4}-\d{2}-\d{2}\.xlsx$/,
	);
	const downloadPath = await download.path();
	if (downloadPath === null) throw new Error("download path unavailable");
	const workbook = XLSX.read(readFileSync(downloadPath), { type: "buffer" });
	const rows = XLSX.utils.sheet_to_json<{ customer_reference: string }>(
		workbook.Sheets[workbook.SheetNames[0] as string],
	);
	expect(rows[0]?.customer_reference).toBe("SHEET-001");
	expect(consoleErrors).toEqual([]);
});
