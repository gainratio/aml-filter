import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ErrorBoundary } from "./ErrorBoundary";

// A child that throws on demand so we can drive the boundary into its error
// state deterministically.
function Boom({ explode }: { explode: boolean }) {
	if (explode) {
		throw new Error("kaboom");
	}
	return <div>safe child</div>;
}

describe("ErrorBoundary", () => {
	beforeEach(() => {
		// React logs caught render errors to console.error; silence it so the
		// expected-error tests do not spam the test output.
		vi.spyOn(console, "error").mockImplementation(() => {});
	});

	afterEach(() => {
		cleanup();
		vi.restoreAllMocks();
	});

	it("renders children when no error is thrown", () => {
		render(
			<ErrorBoundary>
				<Boom explode={false} />
			</ErrorBoundary>,
		);
		expect(screen.getByText("safe child")).toBeInTheDocument();
	});

	it("renders the default fallback UI when a child throws", () => {
		render(
			<ErrorBoundary>
				<Boom explode={true} />
			</ErrorBoundary>,
		);
		expect(screen.getByText("Something went wrong")).toBeInTheDocument();
		expect(screen.getByText("kaboom")).toBeInTheDocument();
	});

	it("renders a custom fallback when provided", () => {
		render(
			<ErrorBoundary fallback={<div>custom fallback</div>}>
				<Boom explode={true} />
			</ErrorBoundary>,
		);
		expect(screen.getByText("custom fallback")).toBeInTheDocument();
	});

	it("recovers to children after Try Again is clicked", () => {
		const { rerender } = render(
			<ErrorBoundary>
				<Boom explode={true} />
			</ErrorBoundary>,
		);
		expect(screen.getByText("Something went wrong")).toBeInTheDocument();

		// Stop throwing, then reset the boundary; it should show children again.
		rerender(
			<ErrorBoundary>
				<Boom explode={false} />
			</ErrorBoundary>,
		);
		fireEvent.click(screen.getByText("Try Again"));
		expect(screen.getByText("safe child")).toBeInTheDocument();
	});
});
