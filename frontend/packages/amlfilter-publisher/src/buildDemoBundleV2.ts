// LOCAL build step (NOT run in CI): build the committed DEMO-2 signed bundle
// e2e fixture under frontend/app/tests/e2e-bundle/fixtures/bundle-v2/origin/.
//
// This is the SECOND signed bundle the delta-sync e2e routes in (via page.route)
// AFTER the engine has warmed OPFS with the committed v1 bundle. It mirrors
// buildDemoBundle.ts but advances ONLY the OFAC list to "demo-2" and changes
// OFAC's entity set (one ADDED sanctioned entity, "Testor Newlysanctioned"),
// while EU/UN/UK are read from the SAME demo JSONL at the SAME version
// ("demo-1") with the SAME generatedAt. Because edge-proc content-addresses each
// staged file independently, this makes:
//   - ofac/{entities.jsonl,vectors.f32,meta.json} + the top-level catalog.json
//     change  -> NEW chunks the v2 sync must fetch, and
//   - eu/ un/ uk/ {entities.jsonl,vectors.f32,meta.json} BYTE-IDENTICAL to v1
//     -> their chunks are REUSED from OPFS, fetched ZERO times.
// That is exactly the delta the e2e proves.
//
// Requires `uv` + an edge-proc checkout (default: a sibling ../edge-proc; override with EDGEPROC_DIR).
// Signs with the EXISTING committed demo key (fixtures/demo.key — whose public
// half is the committed public.key), so the v2 /latest verifies in-tab.
//
// Run from frontend/:  pnpm --filter @amlfilter/publisher run build-demo-bundle-v2
// Override the edge-proc location with EDGEPROC_DIR=/abs/path.
//
// Determinism: generatedAt is FIXED (and identical to v1) so the staged bytes —
// and hence the content-addressed chunk/manifest hashes and the signed pointer —
// are stable AND the unchanged lists' chunks collide with v1's.

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
// v1 (unchanged) lists read from fixtures/demo; the changed OFAC list reads from
// fixtures/demo-v2 so the v1 demo fixtures stay the single source for the boot
// bundle and EU/UN/UK bytes are guaranteed identical across v1 and v2.
const DEMO = resolve(HERE, "../fixtures/demo");
const DEMO_V2 = resolve(HERE, "../fixtures/demo-v2");
const KEY = resolve(HERE, "../fixtures/demo.key");
const MODELS = resolve(HERE, "../../../app/public/models");
const STAGING = resolve(HERE, "../.bundle-v2-staging");
const ORIGIN = resolve(
	HERE,
	"../../../app/tests/e2e-bundle/fixtures/bundle-v2/origin",
);

// IDENTICAL to buildDemoBundle.ts so EU/UN/UK meta.json (which embeds
// generatedAt) is byte-for-byte the same -> their chunks dedupe against v1.
const DEMO_GENERATED_AT = "2026-06-19T00:00:00Z";
const BUNDLE_ID = "amlfilter-watchlists";

const V1_VERSION = "demo-1";
const V2_VERSION = "demo-2";
const V2_SEQUENCE = 2;

/** One demo list to bundle: catalog identity, demo JSONL dir + slug, version. */
interface DemoList {
	readonly id: string;
	readonly title: string;
	readonly slug: string;
	/** Directory the list's JSONL is read from (fixtures/demo or fixtures/demo-v2). */
	readonly dir: string;
	readonly version: string;
}

// Only OFAC advances to demo-2 (and reads the changed fixtures/demo-v2/ofac.jsonl
// with the added entity); EU/UN/UK stay at demo-1 reading the SAME fixtures/demo
// JSONL the v1 boot bundle used -> byte-identical staged files -> reused chunks.
const LISTS: readonly DemoList[] = [
	{
		id: "OFAC_SDN",
		title: "OFAC SDN",
		slug: "ofac",
		dir: DEMO_V2,
		version: V2_VERSION,
	},
	{
		id: "EU_CONSOLIDATED",
		title: "EU Consolidated",
		slug: "eu",
		dir: DEMO,
		version: V1_VERSION,
	},
	{
		id: "UN_CONSOLIDATED",
		title: "UN Consolidated",
		slug: "un",
		dir: DEMO,
		version: V1_VERSION,
	},
	{
		id: "UK_OFSI",
		title: "UK OFSI",
		slug: "uk",
		dir: DEMO,
		version: V1_VERSION,
	},
];

/** Read a demo list's JSONL, map to entities, and embed its canonical names. */
async function buildStagedList(list: DemoList): Promise<StagedList> {
	const jsonl = await readFile(resolve(list.dir, `${list.slug}.jsonl`), "utf8");
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
		version: list.version,
		model: EMBEDDING_MODEL,
		dim: EMBEDDING_DIM,
		entities,
		vectors,
		// Fixed, and identical to v1's, so the three unchanged lists still stage
		// to byte-identical bytes and their chunks dedupe against the v1 publish.
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
		version: V2_VERSION,
		sequence: V2_SEQUENCE,
	});
	// edge-proc also writes a producer-side CAS mirror (chunks/<aa>/<hash>,
	// manifests/<hash>) and a .mutation.lock next to the served contract. The
	// sync tier consumes ONLY chunk/<hash>, manifest/<hash>, latest — drop the
	// rest so the COMMITTED tree is exactly the served contract. Also drop the
	// intermediate staging.
	await removeProducerResidue(ORIGIN);
	await rm(STAGING, { recursive: true, force: true });
	process.stdout.write(
		`demo bundle v2 (${staged.length} lists, OFAC@${V2_VERSION}) -> ${ORIGIN}\n`,
	);
}

main().catch((err: unknown) => {
	process.stderr.write(
		`build-demo-bundle-v2: ${err instanceof Error ? err.message : String(err)}\n`,
	);
	process.exit(1);
});
