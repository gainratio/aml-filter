import type { CatalogListInfo } from "@amlfilter/browser";
import { render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { describe, expect, it, vi } from "vitest";
import { DEMO_STATS } from "../generated/landing-stats";
import { type CatalogSource, LandingPage } from "./LandingPage";

// The public marketing landing at "/". No backend, no auth, no model: the only
// live read is the verified signed catalog (list ids, titles, entry counts),
// injected here as a stub so no test touches the network. Wrapped in a router
// because the CTAs are react-router <Link>s.
function stubSource(
	lists: Promise<ReadonlyArray<CatalogListInfo>> = new Promise(() => {}),
) {
	return {
		catalogLists: vi.fn(() => lists),
		dispose: vi.fn(() => Promise.resolve()),
	} satisfies CatalogSource;
}

function renderPage(source: CatalogSource = stubSource()) {
	return render(
		<MemoryRouter>
			<LandingPage catalogSource={() => source} />
		</MemoryRouter>,
	);
}

function list(id: string, title: string, entitiesCount: number) {
	return { id, title, entitiesCount } as CatalogListInfo;
}

const LIVE_LISTS = [
	list("OFAC_SDN", "OFAC SDN", 18_000),
	list("EU_CONSOLIDATED", "EU consolidated", 5_000),
	list("UN_CONSOLIDATED", "UN consolidated", 1_000),
	list("UK_OFSI", "UK sanctions", 8_325),
];

const FALLBACK =
	"Four public sanctions lists: US OFAC, EU, UN and the UK Sanctions List";

describe("LandingPage", () => {
	it("renders the hero headline and lede", () => {
		renderPage();
		expect(
			screen.getByRole("heading", { level: 1, name: /in your browser/i }),
		).toBeInTheDocument();
		// The lede states the privacy promise: nothing typed leaves the device.
		expect(screen.getByText(/nothing you type leaves/i)).toBeInTheDocument();
	});

	it("names small and medium businesses with KYC obligations", () => {
		renderPage();
		expect(
			screen.getByText(
				/small and medium-sized businesses with KYC obligations/i,
			),
		).toBeInTheDocument();
	});

	it("links the primary CTA to in-browser screening at /screen", () => {
		renderPage();
		const cta = screen.getByRole("link", { name: /screen a name now/i });
		expect(cta).toHaveAttribute("href", "/screen");
	});

	it("links the secondary CTA to the workstation", () => {
		renderPage();
		const cta = screen.getByRole("link", { name: /open the workstation/i });
		expect(cta).toHaveAttribute("href", "/customers");
	});

	it("renders the metrics band with KPI numbers derived from the source files", () => {
		renderPage();
		const band = screen.getByRole("region", { name: /metrics/i });
		// The model size follows the GENERATED single source of truth (the ONNX
		// file), not a literal. $0 infra and 0 bytes of PII are intrinsic copy.
		expect(within(band).getByText("$0")).toBeInTheDocument();
		expect(
			within(band).getByText(String(DEMO_STATS.modelSizeMb)),
		).toBeInTheDocument();
		expect(within(band).getByText(/0 bytes/i)).toBeInTheDocument();
	});

	it("states the live catalog's entry total and list names once it is read", async () => {
		renderPage(stubSource(Promise.resolve(LIVE_LISTS)));
		const band = screen.getByRole("region", { name: /metrics/i });
		expect(await within(band).findByText("32,325")).toBeInTheDocument();
		expect(
			within(band).getByText("entries across 4 public sanctions lists"),
		).toBeInTheDocument();
		expect(
			within(band).getByText("US OFAC · EU · UN · UK Sanctions List"),
		).toBeInTheDocument();
	});

	it("shows a number-free list statement while the catalog is loading", () => {
		renderPage();
		const band = screen.getByRole("region", { name: /metrics/i });
		expect(within(band).getByText(FALLBACK)).toBeInTheDocument();
		// No fabricated count: the old fixture number must not appear.
		expect(within(band).queryByText("8")).toBeNull();
		expect(within(band).queryByText(/demo list/i)).toBeNull();
	});

	it("keeps the number-free statement when the catalog read fails", async () => {
		const source = stubSource(Promise.reject(new Error("offline")));
		renderPage(source);
		await waitFor(() => expect(source.catalogLists).toHaveBeenCalled());
		const band = screen.getByRole("region", { name: /metrics/i });
		expect(await within(band).findByText(FALLBACK)).toBeInTheDocument();
		expect(within(band).queryByText(/entries across/i)).toBeNull();
	});

	it("disposes the catalog runtime when the landing unmounts", () => {
		const source = stubSource();
		const { unmount } = renderPage(source);
		unmount();
		expect(source.dispose).toHaveBeenCalledTimes(1);
	});

	it("never calls the live product a demo", async () => {
		const { container } = renderPage(stubSource(Promise.resolve(LIVE_LISTS)));
		await screen.findByText("32,325");
		expect(container.textContent).not.toMatch(/\bdemo\b/i);
	});

	it("renders the three 'why' cards", () => {
		renderPage();
		const why = screen.getByRole("region", { name: /why/i });
		expect(within(why).getByText(/private/i)).toBeInTheDocument();
		// Was /offline/i, matching a card titled "Local / Offline". The app has no
		// service worker, so a reload with the network off fails outright — the
		// card was named for a capability that does not exist. The title is now
		// "Local"; matching on /offline/i here would pass on the withdrawal text
		// ("there is no offline mode") and prove nothing, so it pins the title.
		expect(within(why).getByText("Local")).toBeInTheDocument();
		expect(within(why).getByText(/verifiable/i)).toBeInTheDocument();
	});

	it("does not promise the app keeps working with no network", () => {
		// The claim this guards: AML-Filter screens IN THE TAB (true) but is not
		// an offline app (false until a service worker exists). The 'why' card
		// must say so rather than implying a cached bundle means offline use.
		renderPage();
		const why = screen.getByRole("region", { name: /why/i });
		expect(within(why).queryByText(/with no network at all/i)).toBeNull();
		expect(within(why).getByText(/no offline mode/i)).toBeInTheDocument();
	});

	it("renders the how-it-works steps including the fail-closed verification", () => {
		renderPage();
		const how = screen.getByRole("region", { name: /how it works/i });
		expect(within(how).getByText(/ed25519/i)).toBeInTheDocument();
		expect(within(how).getByText(/fail-closed/i)).toBeInTheDocument();
	});

	it("renders the local-first workstation section linking to /customers", () => {
		renderPage();
		const workstation = screen.getByRole("region", {
			name: /compliance workstation/i,
		});
		expect(within(workstation).getByText(/opfs/i)).toBeInTheDocument();
		expect(
			within(workstation).getByText(/tiered review board/i),
		).toBeInTheDocument();
		const cta = within(workstation).getByRole("link", {
			name: /start onboarding/i,
		});
		expect(cta).toHaveAttribute("href", "/customers");
	});

	it("renders the footer credit without calling the product a demo", () => {
		renderPage();
		const footer = screen.getByRole("contentinfo");
		expect(
			within(footer).getByText(/searches public sanctions data entirely/i),
		).toBeInTheDocument();
		expect(footer.textContent).not.toMatch(/\bdemo\b/i);
	});
});
