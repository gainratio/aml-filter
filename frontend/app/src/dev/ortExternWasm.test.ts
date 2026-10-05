// @vitest-environment node
import { defaultClientConditions, type UserConfig } from "vite";
import { describe, expect, it } from "vitest";
import {
	ORT_EXTERN_WASM_CONDITION,
	ortExternWasmPlugin,
} from "./ortExternWasm";

function pluginConfig(): UserConfig {
	const hook = ortExternWasmPlugin().config;
	if (typeof hook !== "function") throw new Error("config hook missing");
	return hook.call(
		{} as never,
		{},
		{ command: "build", mode: "production" },
	) as UserConfig;
}

describe("ortExternWasmPlugin", () => {
	it("selects onnxruntime-web's documented do-not-embed-the-wasm export condition", () => {
		expect(ORT_EXTERN_WASM_CONDITION).toBe("onnxruntime-web-use-extern-wasm");
		expect(pluginConfig().resolve?.conditions).toEqual([
			...defaultClientConditions,
			"onnxruntime-web-use-extern-wasm",
		]);
	});
});
