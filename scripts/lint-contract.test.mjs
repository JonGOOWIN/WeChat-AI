import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { ESLint } from "eslint";

const fixture = "scripts/fixtures/lint-known-bad.js";

test("lint rejects the tracked known-bad fixture", () => {
  const result = spawnSync(
    "pnpm",
    ["exec", "eslint", "--no-ignore", fixture],
    { cwd: process.cwd(), encoding: "utf8" },
  );
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;

  assert.equal(result.status, 1, output);
  assert.match(output, /lint-known-bad\.js/);
  assert.match(output, /no-undef/);
});

async function sourceFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) return sourceFiles(target);
      return /\.(?:ts|js|mjs|cjs)$/.test(entry.name) ? [target] : [];
    }),
  );
  return files.flat();
}

async function workspaceSourceRoots() {
  const roots = [];
  for (const scope of ["apps", "packages"]) {
    const entries = await readdir(scope, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) roots.push(path.join(scope, entry.name, "src"));
    }
  }
  return roots;
}

test("lint config covers every maintained TypeScript and JavaScript file", async () => {
  const roots = [
    ...(await workspaceSourceRoots()),
    "cloudflare-worker/src",
    "scripts",
  ];
  const files = (await Promise.all(roots.map(sourceFiles)))
    .flat()
    .filter((file) => !file.includes(`${path.sep}fixtures${path.sep}`));
  const eslint = new ESLint();

  assert.ok(files.length > 100, "source enumeration reached every maintained tree");
  for (const file of files) {
    assert.equal(await eslint.isPathIgnored(file), false, `${file} is unexpectedly ignored`);
    const config = await eslint.calculateConfigForFile(file);
    assert.equal(config?.rules?.["no-unreachable"]?.[0], 2, `${file} has no active error rules`);
  }
});
