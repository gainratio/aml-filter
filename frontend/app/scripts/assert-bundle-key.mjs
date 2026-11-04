#!/usr/bin/env node
/**
 * Fail a deploy if the bundle it ships does not verify against the pinned public
 * key. This is the guard for the demo-bundle incident: aml-filter.com served
 * `bundle/origin` signed by the throwaway demo key while pinning the production
 * `public.key`, so every visitor's in-tab signature check failed closed.
 *
 * Usage (paths default from this app root, not the caller's cwd):
 *   node scripts/assert-bundle-key.mjs
 *   node scripts/assert-bundle-key.mjs --bundle=public/bundle/live --key=public/public.key
 *
 * The default bundle is the deployable origin the app actually serves
 * (`public/bundle/origin`); after the signed release replaces it in the deploy
 * container, `node app/scripts/assert-bundle-key.mjs` is the deploy gate.
 */
import { createPublicKey, verify } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const appRoot = resolve(import.meta.dirname, "..");
const DEFAULT_BUNDLE = join(appRoot, "public/bundle/origin");
const DEFAULT_KEY = join(appRoot, "public/public.key");

/** Optional pointer fields the browser verifier excludes when absent/null, so
 * a pointer predating the field keeps its original signing preimage. */
const NULLABLE_POINTER_FIELDS = new Set([
	"bundle_id",
	"channel",
	"key_id",
	"expires_at",
]);

function fail(message) {
	console.error(`assert-bundle-key: ${message}`);
	process.exit(1);
}

function parseArgs(argv) {
	const options = { bundle: DEFAULT_BUNDLE, key: DEFAULT_KEY };
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		const separator = arg.indexOf("=");
		const flag = separator === -1 ? arg : arg.slice(0, separator);
		const inlineValue = separator === -1 ? undefined : arg.slice(separator + 1);
		if (flag !== "--bundle" && flag !== "--key") {
			fail(
				`unknown argument ${JSON.stringify(arg)} (expected --bundle=<dir> or --key=<file>)`,
			);
		}
		const value = inlineValue ?? argv[index + 1];
		if (inlineValue === undefined) index += 1;
		if (value === undefined || value === "") {
			fail(`${flag} needs a path`);
		}
		options[flag === "--bundle" ? "bundle" : "key"] = resolve(value);
	}
	return options;
}

function readPointer(bundle) {
	const pointerPath = join(bundle, "latest");
	let raw;
	try {
		raw = readFileSync(pointerPath, "utf8");
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		fail(`cannot read signed pointer ${pointerPath}: ${reason}`);
	}
	let pointer;
	try {
		pointer = JSON.parse(raw);
	} catch {
		fail(`signed pointer ${pointerPath} is not valid JSON`);
	}
	if (
		typeof pointer !== "object" ||
		pointer === null ||
		Array.isArray(pointer)
	) {
		fail(`signed pointer ${pointerPath} is not a JSON object`);
	}
	if (
		typeof pointer.manifest_hash !== "string" ||
		pointer.manifest_hash === ""
	) {
		fail(`signed pointer ${pointerPath} is missing a manifest_hash`);
	}
	if (typeof pointer.version !== "string" || pointer.version === "") {
		fail(`signed pointer ${pointerPath} is missing a version`);
	}
	if (typeof pointer.signature !== "string" || pointer.signature === "") {
		fail(`signed pointer ${pointerPath} is missing a signature`);
	}
	if (
		pointer.sequence !== undefined &&
		pointer.sequence !== null &&
		(!Number.isSafeInteger(pointer.sequence) || pointer.sequence < 0)
	) {
		fail(`signed pointer ${pointerPath} has an invalid sequence`);
	}
	return { pointer, pointerPath };
}

/** Canonical JSON: recursively sorted keys, no whitespace, raw non-ASCII UTF-8.
 * Byte-identical to the browser verifier's signing preimage. */
function canonicalJson(value) {
	if (Array.isArray(value)) {
		return `[${value.map(canonicalJson).join(",")}]`;
	}
	if (typeof value === "object" && value !== null) {
		const members = Object.keys(value)
			.sort()
			.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`);
		return `{${members.join(",")}}`;
	}
	return JSON.stringify(value);
}

/** Exactly the bytes the browser verifies: canonical JSON without `signature`
 * and without each present-but-null optional pointer field. */
function pointerSigningBytes(pointer) {
	const payload = {};
	for (const [key, value] of Object.entries(pointer)) {
		if (key === "signature") continue;
		if (value === null && NULLABLE_POINTER_FIELDS.has(key)) continue;
		payload[key] = value;
	}
	return Buffer.from(canonicalJson(payload), "utf8");
}

const { bundle, key: keyPath } = parseArgs(process.argv.slice(2));
const { pointer, pointerPath } = readPointer(bundle);

let rawKey;
try {
	rawKey = readFileSync(keyPath);
} catch (error) {
	const reason = error instanceof Error ? error.message : String(error);
	fail(`cannot read pinned public key ${keyPath}: ${reason}`);
}
if (rawKey.length !== 32) {
	fail(
		`pinned public key ${keyPath} must be 32 raw Ed25519 bytes, got ${String(rawKey.length)}`,
	);
}

const spki = Buffer.concat([
	Buffer.from("302a300506032b6570032100", "hex"),
	rawKey,
]);
let key;
try {
	key = createPublicKey({ key: spki, format: "der", type: "spki" });
} catch (error) {
	const reason = error instanceof Error ? error.message : String(error);
	fail(`cannot load pinned public key ${keyPath}: ${reason}`);
}

const signature = Buffer.from(pointer.signature, "base64");
if (signature.length !== 64) {
	fail(
		`signed pointer ${pointerPath} has a ${String(signature.length)}-byte signature, expected 64`,
	);
}

let valid = false;
try {
	valid = verify(null, pointerSigningBytes(pointer), key, signature);
} catch (error) {
	const reason = error instanceof Error ? error.message : String(error);
	fail(
		`could not verify signed pointer ${pointerPath} against ${keyPath}: ${reason}`,
	);
}

if (!valid) {
	fail(
		`bundle ${bundle} (${pointer.version}) does not verify against ${keyPath}; ` +
			"refusing to ship a bundle signed with a different key (for example the demo key)",
	);
}

console.log(
	`assert-bundle-key: ${pointer.version} (${pointer.manifest_hash.slice(0, 12)}…) verifies against ${keyPath}`,
);
