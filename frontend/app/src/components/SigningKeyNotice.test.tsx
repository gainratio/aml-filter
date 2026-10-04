import { InstallKeys } from "@amlfilter/browser";
import { memoryInstallKeySql } from "@amlfilter/browser/testing";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { InstallKeysContext } from "../lib/installKeysContext";
import { SigningKeyNotice } from "./SigningKeyNotice";

async function renderOver(
	storage: Parameters<typeof memoryInstallKeySql>[0],
): Promise<void> {
	const keys = new InstallKeys({
		openSql: (await memoryInstallKeySql(storage)).open,
		legacy: null,
		channel: null,
	});
	render(
		<InstallKeysContext.Provider value={keys}>
			<SigningKeyNotice />
		</InstallKeysContext.Provider>,
	);
	await keys.load();
}

afterEach(cleanup);

describe("SigningKeyNotice", () => {
	it("tells the user when the signing key will not outlive the tab", async () => {
		await renderOver({ persistence: "memory", reason: "opfs-unavailable" });

		expect(
			await screen.findByText(/signing key is temporary/),
		).toBeInTheDocument();
	});

	it("stays silent when the key is stored on the device", async () => {
		await renderOver({ persistence: "opfs", pool: "p", file: "f" });

		expect(screen.queryByText(/signing key is temporary/)).toBeNull();
	});
});
