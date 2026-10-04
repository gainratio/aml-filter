#!/usr/bin/env bash
# Run the post-deploy LIVE smoke on this machine, before merge, the way a deploy runs it.
#
# WHY. The live smoke used to run only after a production upload, so production was
# the test: three deploys in a row failed on smoke drift that a local run would have
# caught in minutes. This script builds the release you are about to ship and the one
# production serves now, both as production-like `--mode live` builds (the real signed
# lists mirrored from aml-filter.com, verified against the production key), and drives
# every pass against them on ONE local origin, so browser storage carries over exactly
# as it does for a real returning visitor:
#
#   1. @prime      against aml-filter.com itself (read-only: a static site, the
#                  journey's customers live only in the throwaway browser profile)
#   2. @prime      against a local build of the release production serves now
#   3. @returning  that same profile, after the port switches to THIS tree's build
#   4. @fresh      a brand-new profile against THIS tree's build
#
# Passes 1-4 run once per browser engine, each with its own profiles (a Chromium
# profile cannot be opened by Firefox or WebKit). After a failed pass the rest of
# that browser's passes are skipped (they depend on it) and the next browser runs.
#
# Usage (from frontend/):  pnpm smoke:local
#   SMOKE_BROWSERS=<list>    comma-separated engines: chromium,firefox,webkit
#                            (default chromium, the engine the post-deploy smoke uses)
#   PREVIOUS_REF=<git ref>   the "old release" (default: the SHA aml-filter.com serves)
#   SMOKE_PORT=<port>        local origin port (default 4273)
#   SKIP_PRODUCTION_PRIME=1  skip pass 1 (e.g. offline)
# Exit status is the verdict: non-zero if any pass in any browser fails. A summary
# table (browser, pass, PASS/FAIL/SKIP, seconds) is printed either way.
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_DIR="$(git -C "$APP_DIR" rev-parse --show-toplevel)"
PORT="${SMOKE_PORT:-4273}"
ORIGIN="http://127.0.0.1:${PORT}"
# Resolved (pwd -P): on macOS $TMPDIR is a /var -> /private/var symlink, and a
# script that compares import.meta.url with argv[1] (build-identity.mjs) silently
# skips its CLI when the two spell the path differently.
WORK="$(cd "$(mktemp -d "${TMPDIR:-/tmp}/aml-smoke-local.XXXXXX")" && pwd -P)"
PREVIEW_PID=""
SUMMARY=()
FAILED=0

cleanup() {
	summary
	if [[ -n "$PREVIEW_PID" ]]; then kill "$PREVIEW_PID" 2>/dev/null || true; fi
	git -C "$REPO_DIR" worktree remove --force "$WORK/previous" 2>/dev/null || true
	rm -rf "$WORK"
}
trap cleanup EXIT

# `pnpm run` exports the running pnpm as npm_execpath; reuse it so the script works
# whether pnpm is on PATH or reached through corepack.
pnpm() {
	if [[ -n "${npm_execpath:-}" ]]; then node "$npm_execpath" "$@"; else command pnpm "$@"; fi
}

log() { printf '\n[smoke:local] %s\n' "$*"; }

# A production-like build: real mirrored lists + a stamped build.json (the smoke pins it).
build_release() {
	local app="$1" sha="$2" run_id="$3"
	(cd "$app" && pnpm run build:live)
	node "$app/scripts/build-identity.mjs" stamp --dist "$app/dist" --sha "$sha" --run-id "$run_id"
	served_sha_of "$app/dist/build.json" "$sha"
}

# Fail unless a build.json (file or URL body on stdin) names exactly this SHA.
served_sha_of() {
	node -e '
		const [file, want] = process.argv.slice(1);
		const text = require("node:fs").readFileSync(file === "-" ? 0 : file, "utf8");
		let got = "(not JSON)";
		try { got = JSON.parse(text).git_sha; } catch {}
		if (got !== want) { console.error(`build.json git_sha ${got} != ${want}`); process.exit(1); }
	' "$1" "$2"
}

# Serve one dist on the fixed origin with THIS tree's vite config (live mode pins
# the production key), and wait until the origin really serves that release.
serve() {
	local dist="$1" sha="$2"
	if [[ -n "$PREVIEW_PID" ]]; then kill "$PREVIEW_PID"; wait "$PREVIEW_PID" 2>/dev/null || true; fi
	(cd "$APP_DIR" && exec node node_modules/vite/bin/vite.js preview --mode live \
		--outDir "$dist" --host 127.0.0.1 --port "$PORT" --strictPort) >"$WORK/preview.log" 2>&1 &
	PREVIEW_PID=$!
	for _ in $(seq 1 60); do
		if curl -fsS "$ORIGIN/build.json" 2>/dev/null | served_sha_of - "$sha" 2>/dev/null; then
			return 0
		fi
		sleep 1
	done
	cat "$WORK/preview.log" >&2
	echo "[smoke:local] $ORIGIN never served $sha from $dist" >&2
	return 1
}

# One pass in one browser: smoke <browser> <@tag> [ENV=value...]
smoke() {
	local browser="$1" grep="$2"
	shift 2
	(cd "$APP_DIR" && env LIVE_SMOKE_BROWSERS="$browser" "$@" \
		node node_modules/@playwright/test/cli.js test \
		-c playwright.live.config.ts --grep "$grep" --retries 0)
}

# Run a step, record PASS/FAIL and its duration. Returns the step's status.
# record <browser> <label> <command...>
record() {
	local browser="$1" label="$2" started status=0
	shift 2
	started=$SECONDS
	"$@" || status=$?
	if [[ $status -eq 0 ]]; then
		SUMMARY+=("$browser	$label	PASS	$((SECONDS - started))s")
	else
		SUMMARY+=("$browser	$label	FAIL(exit $status)	$((SECONDS - started))s")
		FAILED=1
	fi
	return $status
}

# Printed on every exit (the EXIT trap), so an aborted build still shows what ran.
summary() {
	if [[ ${#SUMMARY[@]} -eq 0 ]]; then return 0; fi
	printf '\n[smoke:local] summary\nbrowser\tpass\tresult\tduration\n'
	printf '%s\n' "${SUMMARY[@]}"
}

# Every pass for one browser, in order; stop that browser at its first failure.
run_browser() {
	local browser="$1" profile="$WORK/$1/returning-profile"
	if [[ "${SKIP_PRODUCTION_PRIME:-0}" != "1" ]]; then
		log "[$browser] 1/4 @prime against production (read-only)"
		record "$browser" "1 @prime production" \
			smoke "$browser" @prime LIVE_SMOKE_PROFILE="$WORK/$browser/production-profile" ||
			return 0
	fi
	log "[$browser] 2/4 @prime against the previous release on $ORIGIN"
	serve "$WORK/previous/frontend/app/dist" "$PREVIOUS_SHA"
	record "$browser" "2 @prime previous" \
		smoke "$browser" @prime LIVE_SMOKE_URL="$ORIGIN" LIVE_SMOKE_PROFILE="$profile" ||
		return 0
	log "[$browser] 3/4 @returning: same origin and profile, now serving this tree"
	serve "$APP_DIR/dist" "$CURRENT_SHA"
	record "$browser" "3 @returning current" \
		smoke "$browser" @returning LIVE_SMOKE_URL="$ORIGIN" LIVE_SMOKE_PROFILE="$profile" \
		LIVE_SMOKE_EXPECT_SHA="$CURRENT_SHA" || return 0
	log "[$browser] 4/4 @fresh against this tree"
	record "$browser" "4 @fresh current" \
		smoke "$browser" @fresh LIVE_SMOKE_URL="$ORIGIN" LIVE_SMOKE_EXPECT_SHA="$CURRENT_SHA" ||
		return 0
}

CURRENT_SHA="$(git -C "$REPO_DIR" rev-parse HEAD)"
PREVIOUS_REF="${PREVIOUS_REF:-$(curl -fsS https://aml-filter.com/build.json |
	node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).git_sha))')}"
IFS=',' read -r -a BROWSERS <<<"${SMOKE_BROWSERS:-chromium}"
if [[ ${#BROWSERS[@]} -eq 0 ]]; then BROWSERS=(""); fi
for browser in "${BROWSERS[@]}"; do
	case "$browser" in
	chromium | firefox | webkit) ;;
	*)
		echo "[smoke:local] SMOKE_BROWSERS: unknown browser '$browser' (use chromium,firefox,webkit)" >&2
		exit 2
		;;
	esac
done

log "building the previous release ($PREVIOUS_REF)"
git -C "$REPO_DIR" worktree add --detach "$WORK/previous" "$PREVIOUS_REF"
(cd "$WORK/previous/frontend" && pnpm install --frozen-lockfile)
PREVIOUS_SHA="$(git -C "$WORK/previous" rev-parse HEAD)"
build_release "$WORK/previous/frontend/app" "$PREVIOUS_SHA" 1

log "building this tree ($CURRENT_SHA)"
build_release "$APP_DIR" "$CURRENT_SHA" 2

for browser in "${BROWSERS[@]}"; do
	run_browser "$browser"
done

if [[ $FAILED -ne 0 ]]; then
	log "SMOKE FAILED in at least one browser ($CURRENT_SHA)"
	exit 1
fi
log "ALL PASSES GREEN in ${BROWSERS[*]}: production prime, previous->current returning, fresh ($CURRENT_SHA)"
