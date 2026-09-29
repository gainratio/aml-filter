import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const workflowDir = resolve(root, ".github/workflows");
const workflows = () =>
	readdirSync(workflowDir)
		.filter((file) => /\.ya?ml$/.test(file))
		.sort();
const read = (file: string) => readFileSync(resolve(workflowDir, file), "utf8");
const normalize = (value: string) => value.trim().replace(/\s+/g, " ");
const blockBetween = (
	yaml: string,
	startMarker: string,
	endMarker: string,
	label: string,
) => {
	const start = yaml.indexOf(startMarker);
	const body = yaml.slice(start + startMarker.length);
	const end = body.indexOf(endMarker);
	if (start < 0 || end < 0) throw new Error(`missing ${label}`);
	return normalize(body.slice(0, end));
};
const workflowTriggers = (yaml: string) =>
	blockBetween(yaml, "on:\n", "\npermissions:", "workflow triggers");
const workflowPermissions = (yaml: string) =>
	blockBetween(yaml, "permissions:\n", "\njobs:", "workflow permissions");
const jobDisplayName = (yaml: string, job: string) => {
	const name = yaml.match(
		new RegExp(`^  ${job}:\\n    name: ([^\\n]+)$`, "m"),
	)?.[1];
	if (name === undefined) throw new Error(`missing ${job} display name`);
	return name;
};
const actionInputs = (yaml: string, action: string) => {
	const actionStart = yaml.indexOf(`uses: ${action}@`);
	const rest = yaml.slice(actionStart);
	const nextStep = rest.search(/\n {6}- |\n\n? {2}[a-z][a-z-]*:\n/);
	const step = rest.slice(0, nextStep < 0 ? undefined : nextStep);
	const withMarker = "\n        with:\n";
	const inputsStart = step.indexOf(withMarker);
	if (actionStart < 0 || inputsStart < 0)
		throw new Error(`missing ${action} inputs`);
	return normalize(step.slice(inputsStart + withMarker.length));
};
const deployAuthorization = (yaml: string) => {
	const marker = "    if: >-\n";
	const start = yaml.indexOf(marker);
	const body = yaml.slice(start + marker.length);
	const end = body.indexOf("\n    runs-on:");
	if (start < 0 || end < 0) throw new Error("missing deploy authorization");
	return normalize(body.slice(0, end));
};
const DEPLOY_SOURCE = `\${{ github.event_name == 'workflow_run' && github.event.workflow_run.head_sha || github.sha }}`;
const DEPLOY_AUTHORIZATION = [
	"(github.event_name == 'workflow_run' &&",
	"github.event.workflow_run.conclusion == 'success' &&",
	"github.event.workflow_run.event == 'push' &&",
	"github.event.workflow_run.head_branch == 'main' &&",
	"github.event.workflow_run.head_repository.full_name == github.repository) ||",
	"(github.event_name == 'workflow_dispatch' && github.ref == 'refs/heads/main')",
].join(" ");
const DEPLOY_CHECKOUT_INPUTS = [
	"fetch-depth: 0",
	"persist-credentials: false",
	`ref: ${DEPLOY_SOURCE}`,
].join(" ");
const DEPLOY_DAGGER_INPUTS = [
	'version: "0.21.8"',
	"call: >-",
	"deploy",
	"--signing-key=env://WATCHLIST_SIGNING_KEY",
	"--cloudflare-api-token=env://CLOUDFLARE_API_TOKEN",
	"--cloudflare-account-id=env://CLOUDFLARE_ACCOUNT_ID",
	"--github-token=env://GITHUB_TOKEN",
	'--release-id="$RELEASE_SHA:$GITHUB_RUN_ID"',
].join(" ");
const PUBLISH_AUTHORIZATION = `${DEPLOY_AUTHORIZATION} || github.event_name == 'schedule'`;
const PUBLISH_TRIGGERS = [
	"# zizmor: ignore[dangerous-triggers] guarded deploy-after-CI; tests bind the sole triggers, repository, event, branch, conclusion, and exact head SHA",
	'schedule: - cron: "0 6 * * *"',
	"workflow_run: workflows: [Dagger] types: [completed] branches: [main]",
	"workflow_dispatch:",
].join(" ");
const PUBLISH_CHECKOUT_INPUTS = `persist-credentials: false ref: ${DEPLOY_SOURCE}`;
const CI_DAGGER_INPUTS = `version: "0.21.8" call: ci --commit-sha=\${{ github.sha }}`;
const CI_CHECKOUT_INPUTS = `fetch-depth: 0 persist-credentials: false ref: \${{ github.sha }}`;
const AUTHORIZER_TRIGGERS = "push: branches: [main] pull_request:";
const SECURITY_AUDIT_TRIGGERS =
	'schedule: - cron: "0 9 * * 1" workflow_dispatch:';
const READ_ONLY_PERMISSIONS = "contents: read";
const ALERT_MARKER = "\n  alert:\n";
const ALERT_CALL = `production-alert --github-token=env://GITHUB_TOKEN --workflow="$GITHUB_WORKFLOW" --run-id="$GITHUB_RUN_ID" --outcome="$OUTCOME"`;
const ALERTED_WORKFLOWS = [
	"deploy.yml",
	"live-smoke.yml",
	"publish-watchlist.yml",
	"watchlist-freshness.yml",
];

describe("thin Dagger ingress", () => {
	it("keeps only the seven orchestration entrypoints", () => {
		expect(workflows()).toEqual([
			"dagger.yml",
			"deploy.yml",
			"dev-tool-audit.yml",
			"live-smoke.yml",
			"publish-watchlist.yml",
			"security-audit.yml",
			"watchlist-freshness.yml",
		]);
	});

	it("preserves Dependabot as upstream PR authoring", () => {
		expect(existsSync(resolve(root, ".github/dependabot.yml"))).toBe(true);
	});

	it("runs no repository-authored shell outside Dagger", () => {
		for (const file of workflows()) {
			expect(read(file), file).not.toMatch(/^\s+run:/m);
		}
	});

	it("uses only pinned checkout and Dagger actions", () => {
		for (const file of workflows()) {
			const refs = [...read(file).matchAll(/^\s*-?\s*uses:\s*([^\s#]+)/gm)].map(
				(match) => match[1],
			);
			expect(refs, file).toEqual(
				expect.arrayContaining([expect.stringMatching(/^actions\/checkout@/)]),
			);
			expect(refs, file).toEqual(
				expect.arrayContaining([
					expect.stringMatching(/^dagger\/dagger-for-github@/),
				]),
			);
			expect(
				refs.every((ref) =>
					/^(actions\/checkout|dagger\/dagger-for-github)@/.test(ref ?? ""),
				),
			).toBe(true);
		}
	});

	it("disables persisted credentials on every checkout", () => {
		for (const file of workflows()) {
			const yaml = read(file);
			const checkouts = [...yaml.matchAll(/uses:\s*actions\/checkout@/g)]
				.length;
			const disabled = [...yaml.matchAll(/persist-credentials:\s*false/g)]
				.length;
			expect(disabled, file).toBe(checkouts);
		}
	});

	it("exposes Dagger as the only authorizing PR and push gate", () => {
		const yaml = read("dagger.yml");
		const eventIngress = workflows().filter((file) =>
			/^ {2}(?:push|pull_request):/m.test(read(file)),
		);
		// The dev-tool audit also gates PRs and main, but under its own check name, so
		// Foundation green_main (which reads only the "Dagger" check) never sees it.
		expect(eventIngress).toEqual(["dagger.yml", "dev-tool-audit.yml"]);
		expect(jobDisplayName(read("dev-tool-audit.yml"), "audit")).toBe(
			"Dev-tool audit",
		);
		expect(workflowTriggers(yaml)).toBe(AUTHORIZER_TRIGGERS);
		expect(workflowPermissions(yaml)).toBe(READ_ONLY_PERMISSIONS);
		expect(jobDisplayName(yaml, "checks")).toBe("Dagger");
		expect(yaml).not.toContain("Canonical checks");
	});

	it("keeps the authorizing Dagger workflow check-only", () => {
		const yaml = read("dagger.yml");
		expect(actionInputs(yaml, "actions/checkout")).toBe(CI_CHECKOUT_INPUTS);
		expect(actionInputs(yaml, "dagger/dagger-for-github")).toBe(
			CI_DAGGER_INPUTS,
		);
		expect(yaml).not.toContain("environment: production");
		expect(yaml).not.toContain("group: deploy-aml-filter-com");
		expect(yaml).not.toContain("secrets.");
	});

	it("isolates weekly and manual diagnostics from the Dagger authorizer", () => {
		const path = resolve(workflowDir, "security-audit.yml");
		expect(existsSync(path)).toBe(true);
		const yaml = read("security-audit.yml");
		expect(yaml.startsWith("name: Security audit\n")).toBe(true);
		expect(workflowTriggers(yaml)).toBe(SECURITY_AUDIT_TRIGGERS);
		expect(workflowPermissions(yaml)).toBe(READ_ONLY_PERMISSIONS);
		expect(jobDisplayName(yaml, "security")).toBe("Dagger security");
		expect(actionInputs(yaml, "actions/checkout")).toBe(CI_CHECKOUT_INPUTS);
		expect(actionInputs(yaml, "dagger/dagger-for-github")).toBe(
			CI_DAGGER_INPUTS,
		);
		expect(yaml).not.toMatch(/(?:secrets\.|environment:|^\s+env:)/m);
	});

	it.each(['  schedule:\n    - cron: "0 9 * * 1"\n', "  workflow_dispatch:\n"])(
		"rejects a non-push protected trigger",
		(injection) => {
			const mutated = read("dagger.yml").replace(
				"  pull_request:\n",
				`  pull_request:\n${injection}`,
			);
			expect(workflowTriggers(mutated)).not.toBe(AUTHORIZER_TRIGGERS);
		},
	);

	it("rejects the protected Dagger name on the diagnostic job", () => {
		const mutated = read("security-audit.yml").replace(
			"name: Dagger security",
			"name: Dagger",
		);
		expect(jobDisplayName(mutated, "security")).not.toBe("Dagger security");
	});

	it("deploys only from a strict completed Dagger run or main dispatch", () => {
		const yaml = read("deploy.yml");
		expect(yaml).toContain("workflow_run:");
		expect(yaml).toContain("workflow_dispatch:");
		expect(deployAuthorization(yaml)).toBe(DEPLOY_AUTHORIZATION);
	});

	it("publishes nightly, on main dispatch, or after a strict completed Dagger run", () => {
		const yaml = read("publish-watchlist.yml");
		expect(
			blockBetween(yaml, "\non:", "\npermissions:", "publish triggers"),
		).toBe(PUBLISH_TRIGGERS);
		expect(deployAuthorization(yaml)).toBe(PUBLISH_AUTHORIZATION);
	});

	it("rejects publish authorization when the conclusion guard is dropped", () => {
		const guard = "github.event.workflow_run.conclusion == 'success' &&";
		const yaml = read("publish-watchlist.yml");
		expect(yaml).toContain(guard);
		const mutated = yaml.replace(guard, "");
		expect(deployAuthorization(mutated)).not.toBe(PUBLISH_AUTHORIZATION);
	});

	it("publishes only the exact authorized CI head", () => {
		const yaml = read("publish-watchlist.yml");
		expect(actionInputs(yaml, "actions/checkout")).toBe(
			PUBLISH_CHECKOUT_INPUTS,
		);
		expect(actionInputs(yaml, "dagger/dagger-for-github")).toContain(
			'--release-id="$RELEASE_SHA:$GITHUB_RUN_ID"',
		);
		expect(yaml).toContain(`RELEASE_SHA: ${DEPLOY_SOURCE}`);
	});

	it("checks out only the exact authorized deploy source", () => {
		expect(actionInputs(read("deploy.yml"), "actions/checkout")).toBe(
			DEPLOY_CHECKOUT_INPUTS,
		);
	});

	it("passes only the exact typed deploy inputs to Dagger", () => {
		expect(actionInputs(read("deploy.yml"), "dagger/dagger-for-github")).toBe(
			DEPLOY_DAGGER_INPUTS,
		);
	});

	it("runs freshness entirely inside a fail-closed Dagger entrypoint", () => {
		const yaml = read("watchlist-freshness.yml");
		const probe = yaml.slice(0, yaml.indexOf(ALERT_MARKER));
		expect(yaml).toContain("permissions:\n  contents: read\n");
		expect(yaml).toContain("call: freshness sync");
		// Only the separate alert job may write issues, and only through Dagger.
		expect(probe).not.toMatch(/issues:\s*write/);
		expect(yaml).not.toContain("actions/github-script");
		expect(yaml).not.toContain("BREACHED=");
	});

	it("probes the live site in a browser every four hours, read-only", () => {
		const yaml = read("live-smoke.yml");
		expect(workflowTriggers(yaml)).toBe(
			'schedule: - cron: "40 */4 * * *" workflow_dispatch:',
		);
		expect(yaml).toContain("permissions:\n  contents: read\n\n");
		expect(jobDisplayName(yaml, "smoke")).toBe("Live smoke (fresh visitor)");
		expect(yaml).toContain("call: live-smoke\n");
		expect(yaml).not.toContain("secrets.");
		expect(yaml).not.toContain("environment:");
		expect(yaml).not.toContain("deploy-aml-filter-com");
	});

	it("keeps event expressions out of every Dagger input pasted into bash", () => {
		// Fleet rule dagger-args-expression (hseshadr/ci#50): dagger-for-github
		// pastes args/call/shell/... into a bash script, so event values must
		// arrive through env: and be referenced as quoted shell variables.
		const forbidden =
			/^\s+(?:args|call|shell|dagger-flags|workdir|cloud-token):[^\n]*(?:\n(?!\s+[\w-]+:|\s+- )[^\n]*)*/gm;
		const expression =
			/\$\{\{[^}]*(?:\binputs\.|\bgithub\.event\.|\bgithub\.head_ref\b)/;
		for (const file of workflows()) {
			for (const [input] of read(file).matchAll(forbidden)) {
				expect(input, file).not.toMatch(expression);
			}
		}
	});

	it("serializes every production upload through one mutex", () => {
		for (const file of ["deploy.yml", "publish-watchlist.yml"]) {
			expect(read(file)).toContain("group: deploy-aml-filter-com");
			expect(read(file)).toContain("cancel-in-progress: false");
		}
	});

	it("queues every production upload behind a credential-free turnstile", () => {
		const turnstile = `version: "0.21.8" call: release-turn --github-token=env://GITHUB_TOKEN --run-id="$GITHUB_RUN_ID"`;
		for (const file of ["deploy.yml", "publish-watchlist.yml"]) {
			const yaml = read(file);
			const marker = "\n  queue:\n";
			expect(yaml, file).toContain(marker);
			const queue = yaml.slice(yaml.indexOf(marker));
			expect(yaml.slice(0, yaml.indexOf(marker)), file).toContain(
				"    needs: queue\n",
			);
			expect(jobDisplayName(queue, "queue")).toBe(
				"Wait for earlier production writes",
			);
			expect(deployAuthorization(queue)).toBe(deployAuthorization(yaml));
			expect(actionInputs(queue, "dagger/dagger-for-github")).toBe(turnstile);
			expect(queue).toContain(`GITHUB_TOKEN: \${{ github.token }}`);
			expect(queue).not.toMatch(
				/secrets\.|environment:|concurrency:|queue: max/,
			);
		}
	});

	it.each(ALERTED_WORKFLOWS)(
		"reports a failed %s run to one issue through Dagger",
		(file) => {
			const yaml = read(file);
			expect(yaml, file).toContain(ALERT_MARKER);
			const alert = yaml.slice(yaml.indexOf(ALERT_MARKER));
			expect(jobDisplayName(alert, "alert")).toBe("Report production failure");
			expect(alert).toMatch(/^ {4}if: always\(\)/m);
			expect(alert).toContain(
				"    permissions:\n      contents: read\n      issues: write\n    steps:",
			);
			expect(actionInputs(alert, "dagger/dagger-for-github")).toBe(
				`version: "0.21.8" call: ${ALERT_CALL}`,
			);
			expect(alert).not.toMatch(/secrets\.|environment:/);
			// Nothing outside the alert job may write issues.
			expect(yaml.slice(0, yaml.indexOf(ALERT_MARKER))).not.toMatch(
				/issues:\s*write/,
			);
		},
	);

	it("audits dev tooling on every PR, main push, and weekly", () => {
		const yaml = read("dev-tool-audit.yml");
		expect(workflowTriggers(yaml)).toBe(
			'push: branches: [main] pull_request: schedule: - cron: "0 9 * * 1"',
		);
		expect(workflowPermissions(yaml)).toBe(READ_ONLY_PERMISSIONS);
		expect(actionInputs(yaml, "dagger/dagger-for-github")).toBe(
			'version: "0.21.8" call: dev-tool-audit sync',
		);
	});

	it("never lets a workflow claim its own trigger to Dagger", () => {
		// Dagger reads the run's event from GitHub; no caller can claim "schedule".
		for (const file of workflows()) {
			expect(read(file), file).not.toMatch(/--event|GITHUB_EVENT_NAME/);
		}
	});
});
