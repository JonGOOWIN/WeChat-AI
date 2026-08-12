/**
 * Build an OTA release pack from the monorepo (file list + sha256 + bodies).
 *
 *   pnpm release:pack
 *   node scripts/release-pack.mjs
 *   node scripts/release-pack.mjs --bump minor
 *   node scripts/release-pack.mjs --version 0.3.0 --out dist/release
 *   node scripts/release-pack.mjs --no-bump
 *
 * Default: bump root package.json patch (0.2.0 → 0.2.1), write it back, then pack
 * so OTA files + runtime version stay in sync without manual APP_VERSION.
 *
 * Writes:
 *   <out>/<version>/manifest.json
 *   <out>/<version>/files.json   (paths + sha + base64 for push)
 *   package.json version (unless --no-write)
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { applyRootVersion, parseVersionArgs, repoRoot } from "./lib/version.mjs";

const root = repoRoot;

const ROOT_FILES = [
  "package.json",
  "pnpm-workspace.yaml",
  "pnpm-lock.yaml",
  "tsconfig.base.json",
];

const DIR_PREFIXES = [
  "apps/api",
  "packages/core",
  "packages/db",
  "packages/ilink",
  "packages/llm",
  "scripts",
];

const DENY_SEG = new Set([
  "node_modules",
  "data",
  ".git",
  ".wa-update-staging",
  ".wa-backup",
  "dist",
  "coverage",
]);

const INSTALL_TRIGGERS = new Set([
  "pnpm-lock.yaml",
  "package.json",
  "pnpm-workspace.yaml",
  "apps/api/package.json",
  "packages/core/package.json",
  "packages/db/package.json",
  "packages/ilink/package.json",
  "packages/llm/package.json",
]);

function parseArgs(argv) {
  let parsed;
  try {
    parsed = parseVersionArgs(argv, 2);
  } catch (e) {
    console.error(String(e?.message || e));
    process.exit(1);
  }

  const out = {
    version: parsed.version,
    bump: parsed.bump,
    write: parsed.write,
    outDir: path.join(root, "dist", "release"),
    help: parsed.help,
  };

  for (let i = 0; i < parsed.rest.length; i++) {
    const a = parsed.rest[i];
    if (a === "--out" || a === "-o") {
      out.outDir = path.resolve(parsed.rest[++i]);
    } else {
      console.error("unknown argument:", a);
      process.exit(1);
    }
  }

  if (out.help) {
    console.log(`Usage: node scripts/release-pack.mjs [options]

  (default)           bump patch on root package.json, write, then pack
  --bump patch|minor|major|none
  --no-bump           keep current package.json version
  --version X         set exact version (implies no auto-bump)
  --no-write          do not write package.json (pack only)
  --out dir           output root (default dist/release)
`);
    process.exit(0);
  }

  return out;
}

function sha256(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

function isDenied(relPosix) {
  const lower = relPosix.toLowerCase();
  const base = lower.split("/").pop() || "";
  if (base.startsWith(".env")) return true;
  if (base === ".ds_store") return true;
  if (/\.(db|db-wal|db-shm|log|bak)$/i.test(base)) return true;
  for (const s of lower.split("/")) {
    if (DENY_SEG.has(s)) return true;
  }
  return false;
}

function isAllowed(relPosix) {
  if (!relPosix || isDenied(relPosix)) return false;
  if (ROOT_FILES.includes(relPosix)) return true;
  for (const dir of DIR_PREFIXES) {
    if (relPosix !== dir && !relPosix.startsWith(dir + "/")) continue;
    if (dir.startsWith("packages/")) {
      const rest = relPosix.slice(dir.length + 1);
      if (rest === "package.json" || rest === "tsconfig.json") return true;
      if (rest.startsWith("src/")) return true;
      return false;
    }
    return true;
  }
  return false;
}

function walk(absDir, relPrefix, list) {
  let entries;
  try {
    entries = fs.readdirSync(absDir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const ent of entries) {
    const name = ent.name;
    if (DENY_SEG.has(name.toLowerCase())) continue;
    const rel = (relPrefix ? `${relPrefix}/${name}` : name).replace(/\\/g, "/");
    const abs = path.join(absDir, name);
    if (ent.isDirectory()) walk(abs, rel, list);
    else if (ent.isFile() && isAllowed(rel)) list.push(rel);
  }
}

function main() {
  const args = parseArgs(process.argv);

  let version;
  try {
    ({ version } = applyRootVersion({
      version: args.version,
      bump: args.bump,
      write: args.write,
    }));
  } catch (e) {
    console.error(String(e?.message || e));
    process.exit(1);
  }

  const list = [];
  for (const f of ROOT_FILES) {
    const abs = path.join(root, f);
    if (fs.existsSync(abs) && isAllowed(f)) list.push(f);
  }
  for (const dir of DIR_PREFIXES) {
    const abs = path.join(root, ...dir.split("/"));
    if (fs.existsSync(abs)) walk(abs, dir, list);
  }
  list.sort();

  const files = [];
  let totalBytes = 0;
  let requiresInstall = false;

  for (const rel of list) {
    const abs = path.join(root, ...rel.split("/"));
    const buf = fs.readFileSync(abs);
    const hash = sha256(buf);
    files.push({
      path: rel,
      sha256: hash,
      size: buf.length,
      dataBase64: buf.toString("base64"),
    });
    totalBytes += buf.length;
    if (INSTALL_TRIGGERS.has(rel)) requiresInstall = true;
  }

  const packLines = files
    .map((f) => `${f.path}:${f.sha256}`)
    .sort()
    .join("\n");
  const packSha256 = sha256(Buffer.from(packLines, "utf8"));

  const manifest = {
    version,
    createdAt: new Date().toISOString(),
    files: files.map(({ path: p, sha256: h, size }) => ({
      path: p,
      sha256: h,
      size,
    })),
    requiresInstall,
    totalBytes,
    packSha256,
    fileCount: files.length,
  };

  const outDir = path.join(args.outDir, version);
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(
    path.join(outDir, "manifest.json"),
    JSON.stringify(manifest, null, 2),
  );
  fs.writeFileSync(
    path.join(outDir, "files.json"),
    JSON.stringify({
      version,
      files: files.map((f) => ({
        path: f.path,
        sha256: f.sha256,
        size: f.size,
        dataBase64: f.dataBase64,
      })),
    }),
  );

  console.log(`Packed ${files.length} files (${totalBytes} bytes) → ${outDir}`);
  console.log(`version=${version} packSha256=${packSha256.slice(0, 12)}…`);
  console.log(`requiresInstall=${requiresInstall}`);
  console.log(
    `Next: /admin → 部署节点 → 上传通道包 → 选择 ${path.join(outDir, "files.json")}`,
  );
}

main();
