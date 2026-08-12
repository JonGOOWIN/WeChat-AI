import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { parse } from "yaml";

const workflowPath = ".github/workflows/ci.yml";
const expectedJobs = ["lint", "test", "typecheck", "build"];

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

test("CI reports the repository quality gates for pull requests and master pushes", async () => {
  const workflow = await loadWorkflow();

  assert.deepEqual(Object.keys(workflow.jobs).sort(), [...expectedJobs].sort());
  assert.ok(Object.hasOwn(workflow.on, "pull_request"), "pull_request trigger is required");
  assert.deepEqual(workflow.on.push.branches, ["master"]);
  for (const name of expectedJobs) {
    assert.equal(workflow.jobs[name].name, name);
    assert.equal(workflow.jobs[name]["runs-on"], "${{ vars.RUNS_ON || 'ubuntu-latest' }}");
  }
});

test("CI jobs install the pinned toolchain and run one matching gate", async () => {
  const workflow = await loadWorkflow();
  const packageJson = JSON.parse(await readFile("package.json", "utf8"));

  assert.equal(packageJson.engines.node, ">=20.9.0");
  assert.match(packageJson.packageManager, /^pnpm@11\.15\.0$/);
  for (const name of expectedJobs) {
    const job = workflow.jobs[name];
    assert.equal(stepsUsing(job, "actions/checkout").length, 1);
    assert.equal(stepsUsing(job, "pnpm/action-setup").length, 1);
    const setupNode = stepsUsing(job, "actions/setup-node");
    assert.equal(setupNode.length, 1);
    assert.equal(setupNode[0].with["node-version"], "20.9.0");
    assert.equal(setupNode[0].with.cache, "pnpm");
    assert.ok(job.steps.some((step) => step.run === "pnpm install --frozen-lockfile"));
    assert.ok(job.steps.some((step) => step.run === `npm run ${name}`));
  }
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

test("CI concurrency is scoped to one pull request or branch ref", async () => {
  const workflow = await loadWorkflow();
  const group = workflow.concurrency.group;

  assert.equal(workflow.concurrency["cancel-in-progress"], true);
  assert.match(group, /github\.workflow/);
  assert.match(group, /github\.event\.pull_request\.number/);
  assert.match(group, /github\.ref/);
});
