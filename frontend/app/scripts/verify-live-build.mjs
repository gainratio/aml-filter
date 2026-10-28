// Guard the production build against the failure that took aml-filter.com down:
// deploying the default (demo) bundle base instead of the signed live bundle.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const DIST = "dist";
const assets = join(DIST, "assets");
if (!existsSync(join(DIST, "bundle", "live", "latest"))) {
  console.error("verify-live-build: dist/bundle/live/latest is missing");
  process.exit(1);
}
if (!existsSync(assets)) {
  console.error("verify-live-build: dist/assets is missing; run the live build");
  process.exit(1);
}
const js = readdirSync(assets)
  .filter((name) => name.endsWith(".js"))
  .map((name) => readFileSync(join(assets, name), "utf8"))
  .join("\n");
if (!js.includes("/bundle/live")) {
  console.error("verify-live-build: built JS does not reference /bundle/live; refusing to deploy the demo origin");
  process.exit(1);
}
console.log("verify-live-build: production live bundle present");
