// LOCAL build step (NOT run in CI): build the committed content-addressed,
// signed edge-proc demo bundle under frontend/app/public/bundle/origin/.
//
// Requires `uv` + an edge-proc checkout (default: a sibling ../edge-proc; override with EDGEPROC_DIR).
// It builds the SAME demo entities as buildDemoMultiList.ts (same JSONL fixtures,
// same Node MiniLM embedder, same fixed generatedAt/version), stages them with
// stageBundle(), then shells out to `edgeproc publish` to chunk + Ed25519-sign the
// staging tree with the EXISTING committed demo key (fixtures/demo.key — whose
// public half is the committed public.key, so signatures verify in-tab).
//
// Run from frontend/:  pnpm --filter @amlfilter/publisher run build-demo-bundle
// Override the edge-proc location with EDGEPROC_DIR=/abs/path.
//
// Determinism: generatedAt + version are FIXED so the staged bytes — and hence
// the content-addressed chunk/manifest hashes and the signed pointer — are stable.

import { readFile, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { EMBEDDING_DIM, EMBEDDING_MODEL } from "@amlfilter/browser";
import { removeProducerResidue } from "./buildRealBundle.ts";
import { createNodeEmbedder } from "./nodeEmbedder.ts";
import { publishBundle } from "./publishBundle.ts";
import { parseEntities } from "./sourceEntity.ts";
import { type StagedList, stageBundle } from "./stageBundle.ts";
import { packVectors } from "./vectors.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const DEMO = resolve(HERE, "../fixtures/demo");
const KEY = resolve(HERE, "../fixtures/demo.key");
const MODELS = resolve(HERE, "../../../app/public/models");
const STAGING = resolve(HERE, "../.bundle-staging");
const ORIGIN = resolve(HERE, "../../../app/public/bundle/origin");

const DEMO_GENERATED_AT = "2026-06-19T00:00:00Z";
const DEMO_VERSION = "demo-1";
const DEMO_SEQUENCE = 1;
const BUNDLE_ID = "amlfilter-watchlists";

/** One demo list to bundle: catalog identity + demo JSONL slug. */
interface DemoList {
	readonly id: string;
	readonly title: string;
	readonly slug: string;
}

const LISTS: readonly DemoList[] = [
	{ id: "OFAC_SDN", title: "OFAC SDN", slug: "ofac" },
	{ id: "EU_CONSOLIDATED", title: "EU Consolidated", slug: "eu" },
	{ id: "UN_CONSOLIDATED", title: "UN Consolidated", slug: "un" },
	{ id: "UK_OFSI", title: "UK OFSI", slug: "uk" },
];

/** Read a demo list's JSONL, map to entities, and embed its canonical names. */
async function buildStagedList(list: DemoList): Promise<StagedList> {
	const jsonl = await readFile(resolve(DEMO, `${list.slug}.jsonl`), "utf8");
	const entities = parseEntities(jsonl);
	const embedder = createNodeEmbedder(MODELS);
	const vectors = await packVectors(
		embedder,
		entities.map((e) => e.name_canonical),
	);
	return {
		listId: list.id,
		slug: list.slug,
		title: list.title,
		version: DEMO_VERSION,
		model: EMBEDDING_MODEL,
		dim: EMBEDDING_DIM,
		entities,
		vectors,
		// Fixed like the version and generatedAt: this bundle's whole point is
		// byte-stability, so its freshness is a constant, never a wall clock.
		freshness: {
			fetchedAt: DEMO_GENERATED_AT,
			sourceUpdatedAt: null,
			stale: false,
			staleReason: null,
		},
	};
}

async function main(): Promise<void> {
	const staged: StagedList[] = [];
	for (const list of LISTS) {
		staged.push(await buildStagedList(list));
	}
	await stageBundle(STAGING, staged, DEMO_GENERATED_AT);
	await rm(ORIGIN, { recursive: true, force: true });
	await publishBundle({
		srcDir: STAGING,
		originDir: ORIGIN,
		keyPath: KEY,
		bundleId: BUNDLE_ID,
		version: DEMO_VERSION,
		sequence: DEMO_SEQUENCE,
	});
	// edge-proc also writes a producer-side CAS mirror (chunks/<aa>/<hash>,
	// manifests/<hash>) and a .mutation.lock next to the served contract. The
	// sync tier consumes ONLY chunk/<hash>, manifest/<hash>, latest — drop the
	// rest so the COMMITTED tree is exactly the served contract. Also drop the
	// intermediate staging.
	await removeProducerResidue(ORIGIN);
	await rm(STAGING, { recursive: true, force: true });
	process.stdout.write(
		`demo bundle (${staged.length} lists, v${DEMO_VERSION}) -> ${ORIGIN}\n`,
	);
}

main().catch((err: unknown) => {
	process.stderr.write(
		`build-demo-bundle: ${err instanceof Error ? err.message : String(err)}\n`,
	);
	process.exit(1);
});
