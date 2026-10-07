import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { describe, expect, it, vi } from "vitest";
import { Layout } from "./Layout";

const storage = vi.hoisted(() => ({
	fallbackLists: [] as ReadonlyArray<string>,
}));
vi.mock("@amlfilter/browser", () => ({
	vectorIndexFallbackLists: () => storage.fallbackLists,
	subscribeVectorIndexStorage: () => () => undefined,
}));

vi.mock("react-i18next", () => ({
	useTranslation: () => ({
		t: (key: string, options?: { lists?: string }) =>
			(
				({
					"nav.brandAlt": "AML-Filter",
					"nav.brand": "AML-Filter",
					"nav.screen": "Screen",
					"nav.customers": "Customers",
					"nav.review": "Review",
					"nav.settings": "Settings",
					"indexFallback.notice": `Low-memory mode for ${options?.lists}: search index is in memory`,
					"common:labels.lists.OFAC_SDN": "US OFAC",
					"common:labels.lists.EU_CONSOLIDATED": "EU",
					layoutFooter: "Local-first screening",
					layoutFooterSource: "Source code on GitHub (MIT)",
				}) as Record<string, string>
			)[key] ?? key,
	}),
}));

describe("Layout", () => {
	it("offers the reader the public source repository from the footer", () => {
		render(
			<MemoryRouter initialEntries={["/screen"]}>
				<Layout>
					<div>page</div>
				</Layout>
			</MemoryRouter>,
		);

		expect(
			screen.getByRole("link", { name: "Source code on GitHub (MIT)" }),
		).toHaveAttribute("href", "https://github.com/gainratio/aml-filter");
	});

	it("marks the current workspace route and exposes named primary navigation", () => {
		render(
			<MemoryRouter initialEntries={["/review"]}>
				<Layout>
					<div>page</div>
				</Layout>
			</MemoryRouter>,
		);

		expect(screen.getByRole("navigation", { name: /primary/i })).toBeVisible();
		expect(screen.getByRole("link", { name: "Review" })).toHaveAttribute(
			"aria-current",
			"page",
		);
		expect(screen.getByRole("link", { name: "Screen" })).not.toHaveAttribute(
			"aria-current",
		);
	});

	it("names the list whose search index fell back to in-memory storage", () => {
		storage.fallbackLists = ["OFAC_SDN"];
		render(
			<MemoryRouter initialEntries={["/screen"]}>
				<Layout>
					<div>page</div>
				</Layout>
			</MemoryRouter>,
		);
		expect(screen.getByRole("status")).toHaveTextContent(
			"Low-memory mode for US OFAC: search index is in memory",
		);
		storage.fallbackLists = [];
	});

	it("names every list that fell back, not just the latest one", () => {
		storage.fallbackLists = ["EU_CONSOLIDATED", "OFAC_SDN"];
		render(
			<MemoryRouter initialEntries={["/screen"]}>
				<Layout>
					<div>page</div>
				</Layout>
			</MemoryRouter>,
		);
		expect(screen.getByRole("status")).toHaveTextContent(
			"Low-memory mode for EU, US OFAC: search index is in memory",
		);
		storage.fallbackLists = [];
	});

	it("shows no storage notice when the index is persistent", () => {
		render(
			<MemoryRouter initialEntries={["/screen"]}>
				<Layout>
					<div>page</div>
				</Layout>
			</MemoryRouter>,
		);
		expect(screen.queryByRole("status")).toBeNull();
	});
});
