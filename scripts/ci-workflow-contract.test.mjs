import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { parse } from "yaml";

const workflowPath = ".github/workflows/ci.yml";
const expectedJobs = ["lint", "test", "typecheck", "build"];
const trustedRunnerExpression = "${{ (github.event_name != 'pull_request' || github.event.pull_request.head.repo.full_name == github.repository) && (vars.RUNS_ON || 'ubuntu-latest') || 'ubuntu-latest' }}";

async function loadWorkflow() {
  return parse(await readFile(workflowPath, "utf8"));
}

function stepsUsing(job, action) {
  return job.steps.filter((step) => step.uses === `${action}@v4`);
}

function assertReadOnlyAndSecretFree(workflow) {
  const serialized = JSON.stringify(workflow);
  assert.deepEqual(workflow.permissions, { contents: "read" });
  assert.doesNotMatch(serialized, /\$\{\{\s*secrets\./i);
  assert.doesNotMatch(serialized, /LLM_(?:API_)?KEY|OAUTH|PRODUCTION_REDIS/i);
}

function assertNonBypassableAndBounded(workflow) {
  assert.equal(workflow.defaults, undefined, "workflow must not define defaults");
  assert.equal(workflow.env, undefined, "workflow env must be absent");
  for (const [name, job] of Object.entries(workflow.jobs)) {
    assert.equal(job.if, undefined, `${name} job must not be conditional`);
    assert.equal(job.defaults, undefined, `${name} job must not define defaults`);
    assert.equal(job["continue-on-error"], undefined, `${name} job must not define continue-on-error`);
    assert.equal(job["timeout-minutes"], name === "test" ? 30 : 20);
    if (name === "test") {
      assert.deepEqual(
        job.env,
        { REDIS_URL: "redis://localhost:6379" },
        "test job env must contain only REDIS_URL",
      );
    } else {
      assert.equal(job.env, undefined, `${name} job env must be absent`);
    }
    for (const [index, step] of job.steps.entries()) {
      assert.equal(step.env, undefined, `${name} step ${index} env must be absent`);
      assert.equal(
        step["continue-on-error"],
        undefined,
        `${name} step ${index} must not define continue-on-error`,
      );
      if (step.run) {
        assert.equal(step.if, undefined, `${name} command step ${index} must always run`);
        assert.equal(step.shell, undefined, `${name} command step ${index} must not define shell`);
      }
    }
  }
}

function assertPinnedToolchainAndMatchingGates(workflow, packageJson) {
  const engineFloor = packageJson.engines.node.match(/^>=(\d+\.\d+\.\d+)$/)?.[1];

  assert.equal(packageJson.engines.node, ">=22.13.0");
  assert.match(packageJson.packageManager, /^pnpm@11\.15\.0$/);
  for (const name of expectedJobs) {
    const job = workflow.jobs[name];
    const checkoutSteps = job.steps.filter(
      (step) => typeof step.uses === "string" && step.uses.startsWith("actions/checkout@"),
    );
    assert.equal(checkoutSteps.length, 1, `${name} must run exactly one checkout action`);
    assert.equal(checkoutSteps[0].uses, "actions/checkout@v4", `${name} checkout must use v4`);
    assert.equal(checkoutSteps[0].with, undefined, `${name} checkout with must be absent`);
    assert.equal(stepsUsing(job, "pnpm/action-setup").length, 1);
    const setupNode = stepsUsing(job, "actions/setup-node");
    assert.equal(setupNode.length, 1);
    assert.equal(setupNode[0].with["node-version"], engineFloor);
    assert.equal(setupNode[0].with.cache, "pnpm");
    assert.ok(job.steps.some((step) => step.run === "pnpm install --frozen-lockfile"));
    assert.ok(job.steps.some((step) => step.run === `npm run ${name}`));
  }
}

test("CI reports the repository quality gates for pull requests and master pushes", async () => {
  const workflow = await loadWorkflow();

  assert.deepEqual(Object.keys(workflow.jobs).sort(), [...expectedJobs].sort());
  assert.ok(Object.hasOwn(workflow.on, "pull_request"), "pull_request trigger is required");
  assert.equal(workflow.on.pull_request, null, "pull_request must not have type, branch, or path filters");
  assert.equal(Object.hasOwn(workflow.on, "pull_request_target"), false);
  assert.deepEqual(Object.keys(workflow.on.push), ["branches"]);
  assert.deepEqual(workflow.on.push.branches, ["master"]);
  for (const name of expectedJobs) {
    assert.equal(workflow.jobs[name].name, name);
    assert.equal(workflow.jobs[name]["runs-on"], trustedRunnerExpression);
  }
});

test("fork pull requests cannot consume repository self-hosted runners", async () => {
  const workflow = await loadWorkflow();

  for (const name of expectedJobs) {
    const runner = workflow.jobs[name]["runs-on"];
    assert.match(runner, /github\.event_name != 'pull_request'/);
    assert.match(runner, /github\.event\.pull_request\.head\.repo\.full_name == github\.repository/);
    assert.match(runner, /vars\.RUNS_ON \|\| 'ubuntu-latest'/);
    assert.match(runner, /\|\| 'ubuntu-latest' \}\}$/);
  }
});

test("CI jobs install the pinned toolchain and run one matching gate", async () => {
  const workflow = await loadWorkflow();
  const packageJson = JSON.parse(await readFile("package.json", "utf8"));

  assertPinnedToolchainAndMatchingGates(workflow, packageJson);
});

test("CI gate rejects npm script-shell replacement at workflow, job, and step scope", async () => {
  const [workflow, mutations] = await Promise.all([
    loadWorkflow(),
    readFile("scripts/fixtures/ci-env-checkout-mutations.yml", "utf8").then(parse),
  ]);
  const targets = [
    ["workflow", (candidate) => { candidate.env = mutations.workflowEnv; }],
    ["job", (candidate) => { candidate.jobs.lint.env = mutations.jobEnv; }],
    ["test job", (candidate) => {
      candidate.jobs.test.env = { ...candidate.jobs.test.env, ...mutations.jobEnv };
    }],
    ["step", (candidate) => { candidate.jobs.lint.steps.at(-1).env = mutations.stepEnv; }],
  ];

  assert.equal(targets.length, 4, "all environment scopes and the test allowlist must be exercised");
  for (const [scope, mutate] of targets) {
    const candidate = structuredClone(workflow);
    mutate(candidate);
    assert.throws(
      () => assertNonBypassableAndBounded(candidate),
      new RegExp(`${scope}.*env|env.*${scope}`, "i"),
    );
  }
});

test("CI gate rejects checkout inputs that replace the tested revision", async () => {
  const [workflow, packageJson, mutations] = await Promise.all([
    loadWorkflow(),
    readFile("package.json", "utf8").then(JSON.parse),
    readFile("scripts/fixtures/ci-env-checkout-mutations.yml", "utf8").then(parse),
  ]);
  const checkout = stepsUsing(workflow.jobs.lint, "actions/checkout")[0];
  checkout.with = mutations.checkoutWith;

  assert.throws(
    () => assertPinnedToolchainAndMatchingGates(workflow, packageJson),
    /checkout.*with|with.*checkout/i,
  );
});

test("CI grants read-only access, isolates Redis to tests, and does not consume production secrets", async () => {
  const workflow = await loadWorkflow();

  assertReadOnlyAndSecretFree(workflow);
  for (const name of expectedJobs) {
    assert.equal(workflow.jobs[name].permissions, undefined, `${name} must not expand permissions`);
  }
  assert.deepEqual(
    expectedJobs.filter((name) => workflow.jobs[name].services),
    ["test"],
  );
  assert.match(workflow.jobs.test.services.redis.image, /^redis:7(?:\.|-|$)/);
  assert.equal(workflow.jobs.test.env.REDIS_URL, "redis://localhost:6379");
});

test("CI safety guard rejects a parsed workflow with repository writes", async () => {
  const knownBad = parse(await readFile("scripts/fixtures/ci-known-bad.yml", "utf8"));

  assert.throws(
    () => assertReadOnlyAndSecretFree(knownBad),
    /Expected values to be strictly deep-equal/,
  );
});

test("CI gate rejects expression bypasses, defaults, and command shells", async () => {
  const knownBad = parse(await readFile("scripts/fixtures/ci-bypass-known-bad.yml", "utf8"));
  const expressionOnly = structuredClone(knownBad);
  delete expressionOnly.defaults;
  const shellOnly = structuredClone(expressionOnly);
  delete shellOnly.jobs.lint["continue-on-error"];

  assert.throws(() => assertNonBypassableAndBounded(knownBad), /must not define defaults/);
  assert.throws(() => assertNonBypassableAndBounded(expressionOnly), /must not define continue-on-error/);
  assert.throws(() => assertNonBypassableAndBounded(shellOnly), /must not define shell/);
});

test("CI jobs cannot bypass failures or hang without a bound", async () => {
  assertNonBypassableAndBounded(await loadWorkflow());
});

test("self-hosted runner documentation requires Linux and Docker", async () => {
  const [readme, runbook] = await Promise.all([
    readFile("README.md", "utf8"),
    readFile("docs/runbook.md", "utf8"),
  ]);

  for (const document of [readme, runbook]) {
    const runnerLine = document.split("\n").find((line) => line.includes("RUNS_ON"));
    assert.ok(runnerLine, "RUNS_ON documentation is required");
    assert.match(runnerLine, /Linux/);
    assert.match(runnerLine, /Docker/);
  }
});

test("CI concurrency is scoped to one pull request or branch ref", async () => {
  const workflow = await loadWorkflow();
  const group = workflow.concurrency.group;

  assert.equal(workflow.concurrency["cancel-in-progress"], true);
  assert.match(group, /github\.workflow/);
  assert.match(group, /github\.event\.pull_request\.number/);
  assert.match(group, /github\.ref/);
});
