// @amlfilter/browser/engine — compatibility re-exports of the shared,
// domain-neutral edge-processing substrate. AML-specific screening stays on the
// package root; trust, transport, storage, and Worker failures come from the
// standalone dependency.
export {
	classifyEngineError,
	type EngineErrorCode,
	type EngineErrorDetail,
	EngineOperationError,
	IntegrityError,
	NetworkError,
	RollbackError,
	SignatureError,
	sha256Hex,
	verifyEd25519,
} from "@gainratio/browser";
export {
	canonicalBytes,
	decompressAndVerify,
	type JsonValue,
} from "./engine/sharedEngineCompat";
