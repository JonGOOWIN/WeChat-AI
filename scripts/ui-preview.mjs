/**
 * UI preview harness: serves apps/api/public with mocked /api/v1/* data and
 * captures desktop + mobile, light + dark screenshots of /app and /admin.
 *
 * Usage:  node scripts/ui-preview.mjs [--out scripts/ui-shots]
 * Needs:  playwright (root devDep preferred; falls back to the npx cache)
 *         and its chromium browser (`npx playwright install chromium`).
 */
import http from "node:http";
import { readFile, mkdir, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const PUBLIC_DIR = path.join(ROOT, "apps", "api", "public");
const OUT_DIR = path.resolve(
  ROOT,
  process.argv.includes("--out")
    ? process.argv[process.argv.indexOf("--out") + 1]
    : "scripts/ui-shots",
);
const PORT = 8891;

// ── Playwright loader (node_modules first, then npx cache) ──────────
async function loadPlaywright() {
  try {
    return await import("playwright");
  } catch {
    // Optional dependency; try the core package next.
  }
  try {
    return await import("playwright-core");
  } catch {
    // Optional dependency; fall back to the npx cache below.
  }
  const cacheRoot = path.join(
    process.env.LOCALAPPDATA || path.join(process.env.USERPROFILE || "", "AppData", "Local"),
    "npm-cache",
    "_npx",
  );
  if (existsSync(cacheRoot)) {
    for (const entry of await readdir(cacheRoot)) {
      for (const pkg of ["playwright", "playwright-core"]) {
        const candidate = path.join(cacheRoot, entry, "node_modules", pkg, "index.mjs");
        if (existsSync(candidate)) {
          return await import(`file://${candidate.replace(/\\/g, "/")}`);
        }
      }
    }
  }
  throw new Error(
    "playwright not found — run `pnpm add -w -D playwright && npx playwright install chromium`",
  );
}

// ── Fixture data ────────────────────────────────────────────────────
const todayStr = new Date().toISOString().slice(0, 10);
const dayN = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
const iso = (n) => new Date(Date.now() - n * 3600000).toISOString();

const ME_ADMIN = {
  user: {
    id: "u_1001",
    username: "marina",
    name: "晚风 Marina",
    avatarUrl: null,
    isAdmin: true,
    trustLevel: 3,
  },
};

const MY_BOTS = {
  bots: [
    { id: "bot_xt01", displayName: "小桃", accountRef: "wxid_peach01", status: "active", ownerUserId: "u_1001", hasToken: true },
    { id: "bot_xg02", displayName: "雪糕", accountRef: "wxid_icecream", status: "active", ownerUserId: "u_1001", hasToken: false },
  ],
};

const MY_PEERS = {
  peers: [
    { bot_account_id: "bot_xt01", peer_id: "wxid_friend_a01", approved: 1, created_at: iso(30), personaId: "p_fuhei", personaSlug: "fuhei-xuejie", personaName: "腹黑学姐" },
    { bot_account_id: "bot_xt01", peer_id: "wxid_friend_b02", approved: 0, created_at: iso(4), personaId: null, personaSlug: null, personaName: null },
    { bot_account_id: "bot_xg02", peer_id: "wxid_friend_c03", approved: 1, created_at: iso(52), personaId: "p_catgirl", personaSlug: "official-catgirl", personaName: "温柔猫娘" },
  ],
};

const PERSONAS = [
  { id: "p_catgirl", slug: "official-catgirl", displayName: "温柔猫娘", description: "软萌粘人的猫娘，说话带喵，会撒娇会关心人。", tags: ["官方", "治愈", "猫娘"], visibility: "public", ownerUserId: "system", useCount: 128, enabled: true, isDefault: true, updatedAt: iso(200) },
  { id: "p_fuhei", slug: "fuhei-xuejie", displayName: "腹黑学姐", description: "表面温柔实则腹黑的学姐，喜欢逗人，偶尔真情流露。", tags: ["恋爱", "腹黑"], visibility: "public", ownerUserId: "u_1001", useCount: 86, enabled: true, isDefault: false, updatedAt: iso(80) },
  { id: "p_ceo", slug: "gaoleng-zongcai", displayName: "高冷总裁", description: "毒舌高冷但心软的总裁，口是心非，行动派宠人。", tags: ["恋爱", "高冷"], visibility: "public", ownerUserId: "u_1002", useCount: 54, enabled: true, isDefault: false, updatedAt: iso(120) },
  { id: "p_genki", slug: "yuanqi-shaonv", displayName: "元气少女", description: "永远活力满满的元气少女，自带阳光和感叹号！", tags: ["日常", "元气"], visibility: "public", ownerUserId: "u_1003", useCount: 40, enabled: true, isDefault: false, updatedAt: iso(60) },
  { id: "p_radio", slug: "shenye-diantai", displayName: "深夜电台主播", description: "凌晨两点的电台主播，声音温柔，善于倾听与安慰。", tags: ["治愈", "夜聊"], visibility: "public", ownerUserId: "u_1002", useCount: 33, enabled: true, isDefault: false, updatedAt: iso(30) },
  { id: "p_dushé", slug: "dushe-guimi", displayName: "毒舌闺蜜", description: "嘴上不饶人心里最护你的闺蜜，吐槽一流。", tags: ["日常", "毒舌"], visibility: "private", ownerUserId: "u_1001", useCount: 12, enabled: true, isDefault: false, updatedAt: iso(10) },
];

const SQUARE = {
  personas: PERSONAS.filter((p) => p.visibility === "public").map((p) => ({
    ...p,
    inLibrary: ["p_catgirl", "p_fuhei"].includes(p.id),
    systemPromptPreview: "你是「{{bot_name}}」……",
  })),
  total: 5, page: 1, limit: 40,
};

const MY_PERSONAS = {
  library: PERSONAS.slice(0, 3).map((p) => ({ ...p })),
  created: PERSONAS.filter((p) => p.ownerUserId === "u_1001").map((p) => ({ ...p })),
};

const usageDay = (day, seed) => {
  const t = 240000 + seed * 91000;
  return {
    day,
    prompt_tokens: Math.round(t * 0.72),
    completion_tokens: Math.round(t * 0.28),
    total_tokens: t,
    requests: 120 + seed * 37,
    by_user: {
      u_1001: { total_tokens: Math.round(t * 0.4), requests: 60 + seed * 9, username: "marina" },
      u_1002: { total_tokens: Math.round(t * 0.35), requests: 40 + seed * 12, username: "azhe" },
      u_1003: { total_tokens: Math.round(t * 0.25), requests: 20 + seed * 16, username: "tianmei" },
    },
    by_bot: {
      bot_xt01: { total_tokens: Math.round(t * 0.5), requests: 70 + seed * 15, display_name: "小桃" },
      bot_mm04: { total_tokens: Math.round(t * 0.3), requests: 30 + seed * 12, display_name: "momo" },
      bot_xg02: { total_tokens: Math.round(t * 0.2), requests: 20 + seed * 10, display_name: "雪糕" },
    },
  };
};

const SNAPSHOT = {
  bots: 4, activeBots: 3, personas: 6, defaultPersona: "official-catgirl",
  peers: 9, approvedPeers: 7, unapprovedPeers: 2, assignments: 5,
  // These three are real counts now (they used to be hardcoded 0 in repos.ts).
  // deepStats=false would mean "not measured" rather than "none".
  messages: 412, memories: 37, users: 5, deepStats: true,
};

const SAFE_CONFIG = {
  publicBaseUrl: "https://wa.example.com",
  workerEnabled: true,
  llmModel: "deepseek-v3",
  llmBaseUrl: "https://api.example.com/v1",
  multiBubbleJson: true,
  splitReply: true,
  allowUnapproved: false,
  maxReplyChunks: 4,
  maxChunkChars: 120,
};

const ADMIN_DASHBOARD = {
  snapshot: SNAPSHOT,
  usage: { today: usageDay(todayStr, 6), yesterday: usageDay(dayN(1), 4) },
  workers: ["bot_xt01", "bot_mm04"],
  workerBots: [
    { id: "bot_xt01", displayName: "小桃", status: "active" },
    { id: "bot_mm04", displayName: "momo", status: "active" },
  ],
  redisOk: true,
  safeConfig: SAFE_CONFIG,
};

const ADMIN_BOTS = {
  bots: [
    { id: "bot_xt01", displayName: "小桃", ownerUserId: "u_1001", ownerUsername: "marina", ownerName: "晚风 Marina", status: "active", accountRef: "wxid_peach01", workerActive: true, hasToken: true, peerCount: 4, unapprovedPeerCount: 0, updatedAt: iso(2) },
    { id: "bot_mm04", displayName: "momo", ownerUserId: "u_1002", ownerUsername: "azhe", ownerName: "阿哲", status: "active", accountRef: "wxid_momo04", workerActive: true, hasToken: true, peerCount: 3, unapprovedPeerCount: 2, updatedAt: iso(6) },
    { id: "bot_xg02", displayName: "雪糕", ownerUserId: "u_1001", ownerUsername: "marina", ownerName: "晚风 Marina", status: "active", accountRef: "wxid_icecream", workerActive: false, hasToken: false, peerCount: 2, unapprovedPeerCount: 0, updatedAt: iso(30) },
    { id: "bot_ay03", displayName: "阿云", ownerUserId: "u_1003", ownerUsername: "tianmei", ownerName: "甜妹研究所", status: "inactive", accountRef: "wxid_cloud03", workerActive: false, hasToken: true, peerCount: 0, unapprovedPeerCount: 0, updatedAt: iso(96) },
  ],
};

const ADMIN_USERS = {
  users: [
    { id: "u_1001", username: "marina", name: "晚风 Marina", isAdmin: true, trustLevel: 3, avatarUrl: null, botCount: 2, createdAt: iso(24 * 90) },
    { id: "u_1002", username: "azhe", name: "阿哲", isAdmin: false, trustLevel: 2, avatarUrl: null, botCount: 1, createdAt: iso(24 * 60) },
    { id: "u_1003", username: "tianmei", name: "甜妹研究所", isAdmin: false, trustLevel: 2, avatarUrl: null, botCount: 1, createdAt: iso(24 * 30) },
    { id: "u_1004", username: "nightowl", name: "夜猫子", isAdmin: false, trustLevel: 1, avatarUrl: null, botCount: 0, createdAt: iso(24 * 12) },
    { id: "u_1005", username: "lucas", name: "Lucas", isAdmin: false, trustLevel: 4, avatarUrl: null, botCount: 0, createdAt: iso(24 * 5) },
  ],
};

const ADMIN_PERSONAS = {
  total: PERSONAS.length,
  personas: PERSONAS.map((p) => ({ ...p })),
};

const ADMIN_AUDIT = {
  logs: [
    { id: "a10", action: "admin_workers_restart_all", actor_user_id: "u_1001", meta: { started: 2, skipped: 2 }, created_at: iso(1) },
    { id: "a09", action: "peer_approved", actor_user_id: "u_1001", meta: { botAccountId: "bot_xt01", peerId: "wxid_friend_b02" }, created_at: iso(3) },
    { id: "a08", action: "bot_renamed", actor_user_id: "u_1002", meta: { botId: "bot_mm04", displayName: "momo" }, created_at: iso(8) },
    { id: "a07", action: "persona_published_square", actor_user_id: "u_1001", meta: { id: "p_fuhei", visibility: "public" }, created_at: iso(20) },
    { id: "a06", action: "admin_persona_set_default", actor_user_id: "u_1001", meta: { id: "p_catgirl" }, created_at: iso(26) },
    { id: "a05", action: "admin_peer_approve_all", actor_user_id: "u_1001", meta: { approved: 3 }, created_at: iso(40) },
    { id: "a04", action: "bot_deleted", actor_user_id: "u_1003", meta: { botId: "bot_old99" }, created_at: iso(55) },
    { id: "a03", action: "persona_added_lib", actor_user_id: "u_1002", meta: { personaId: "p_radio" }, created_at: iso(70) },
    { id: "a02", action: "admin_seed_personas", actor_user_id: "u_1001", meta: { before: 4, after: 6, added: 2 }, created_at: iso(88) },
    { id: "a01", action: "bot_created", actor_user_id: "u_1001", meta: { botId: "bot_xt01" }, created_at: iso(110) },
  ],
};

const ADMIN_PEERS = {
  total: 2,
  peers: [
    { botAccountId: "bot_mm04", peerId: "wxid_new_friend_07", approved: false, botName: "momo", ownerUserId: "u_1002", ownerUsername: "azhe", personaId: null, createdAt: iso(2) },
    { botAccountId: "bot_mm04", peerId: "wxid_new_friend_08", approved: false, botName: "momo", ownerUserId: "u_1002", ownerUsername: "azhe", personaId: null, createdAt: iso(5) },
  ],
};

const ADMIN_SYSTEM = {
  snapshot: SNAPSHOT,
  workers: ["bot_xt01", "bot_mm04"],
  redisOk: true,
  uptimeSec: 2 * 86400 + 3 * 3600 + 1200,
  node: process.version,
  safeConfig: SAFE_CONFIG,
};

/** Route an intercepted /api/v1/* request to fixture JSON.
 *  mode: "ok" (authed, healthy) | "anon" (401 on auth/me) | "botsError" (bots/peers 500) */
function mockApi(pathname, query, mode) {
  if (pathname === "/api/v1/auth/me") {
    return mode === "anon"
      ? { status: 401, body: { error: "unauthorized" } }
      : { status: 200, body: ME_ADMIN };
  }
  if (mode === "botsError" && (pathname === "/api/v1/me/bots" || pathname === "/api/v1/me/peers")) {
    return { status: 500, body: { error: "mock backend failure" } };
  }
  if (pathname === "/api/v1/me/bots/login/start" || pathname === "/api/v1/me/bots/login/login_mock") {
    return {
      status: 200,
      body: {
        session: {
          sessionId: "login_mock",
          displayName: "小桃",
          ownerUserId: "u_1001",
          status: "wait_scan",
          mode: "create",
          qrcode: "mock",
          openUrl: "https://work.weixin.qq.com/ca/mock-qr-target",
          message: "请用微信扫描二维码（或打开下方链接）",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      },
    };
  }
  const table = {
    "/api/v1/me/bots": MY_BOTS,
    "/api/v1/me/peers": MY_PEERS,
    "/api/v1/me/personas": MY_PERSONAS,
    "/api/v1/square/personas": SQUARE,
    "/api/v1/admin/dashboard": ADMIN_DASHBOARD,
    "/api/v1/admin/bots": ADMIN_BOTS,
    "/api/v1/admin/users": ADMIN_USERS,
    "/api/v1/admin/personas": ADMIN_PERSONAS,
    "/api/v1/admin/audit": ADMIN_AUDIT,
    "/api/v1/admin/peers": ADMIN_PEERS,
    "/api/v1/admin/system": ADMIN_SYSTEM,
  };
  if (pathname === "/api/v1/admin/usage") {
    if (query.get("days")) {
      const n = Math.min(Number(query.get("days")) || 7, 30);
      return { status: 200, body: { days: Array.from({ length: n }, (_, i) => usageDay(dayN(i), Math.max(1, 6 - i)) ) } };
    }
    return { status: 200, body: { usage: usageDay(query.get("day") || todayStr, 6) } };
  }
  if (pathname.startsWith("/api/v1/square/personas/")) {
    const id = pathname.split("/").pop();
    const p = PERSONAS.find((x) => x.id === id) || PERSONAS[0];
    return { status: 200, body: { persona: { ...p, systemPrompt: "你是「{{bot_name}}」，一位" + p.description, inLibrary: false } } };
  }
  if (table[pathname]) return { status: 200, body: table[pathname] };
  return { status: 200, body: { ok: true } };
}

/** Grey placeholder standing in for the external QR image service. */
const QR_PLACEHOLDER_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200">
  <rect width="200" height="200" fill="#e8e8ed"/>
  <rect x="20" y="20" width="48" height="48" fill="#1d1d1f"/>
  <rect x="132" y="20" width="48" height="48" fill="#1d1d1f"/>
  <rect x="20" y="132" width="48" height="48" fill="#1d1d1f"/>
  <text x="100" y="108" font-family="sans-serif" font-size="12" fill="#6e6e73" text-anchor="middle">QR MOCK</text>
</svg>`;

// ── Static server ───────────────────────────────────────────────────
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".json": "application/json",
};

function startServer() {
  const server = http.createServer(async (req, res) => {
    try {
      let p = new URL(req.url, `http://127.0.0.1:${PORT}`).pathname;
      if (p === "/" || p === "/app") p = "/app.html";
      if (p === "/admin") p = "/admin.html";
      const file = path.join(PUBLIC_DIR, p.replace(/^\/+/, ""));
      if (!file.startsWith(PUBLIC_DIR)) throw new Error("traversal");
      const data = await readFile(file);
      res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream" });
      res.end(data);
    } catch {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end('{"error":"not found"}');
    }
  });
  return new Promise((resolve) => server.listen(PORT, "127.0.0.1", () => resolve(server)));
}

// ── Capture ─────────────────────────────────────────────────────────
const VIEWPORTS = {
  mobile: { width: 393, height: 852, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
  desktop: { width: 1440, height: 900, deviceScaleFactor: 1 },
};

async function newPage(browser, { viewport, theme, mode }) {
  const context = await browser.newContext({
    viewport: { width: viewport.width, height: viewport.height },
    deviceScaleFactor: viewport.deviceScaleFactor,
    isMobile: !!viewport.isMobile,
    hasTouch: !!viewport.hasTouch,
    locale: "zh-CN",
  });
  await context.addInitScript((t) => {
    try { localStorage.setItem("wa_theme", t); } catch {
      // Preview still works when storage is unavailable.
    }
  }, theme);
  await context.route("**/api/v1/**", (route) => {
    const u = new URL(route.request().url());
    const { status, body } = mockApi(u.pathname, u.searchParams, mode);
    route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
  });
  // External QR image service → local placeholder; other external hosts → abort
  await context.route(/^https?:\/\/api\.qrserver\.com\//, (route) =>
    route.fulfill({ contentType: "image/svg+xml", body: QR_PLACEHOLDER_SVG }),
  );
  await context.route(/^https?:\/\/(?!127\.0\.0\.1|api\.qrserver\.com)/, (route) => route.abort());
  const page = await context.newPage();
  return { context, page };
}

async function shoot(page, name, { fullPage = true } = {}) {
  await page.waitForTimeout(450);
  await page.screenshot({ path: path.join(OUT_DIR, `${name}.png`), fullPage });
  console.log("  ✓", name);
}

async function main() {
  await mkdir(OUT_DIR, { recursive: true });
  const server = await startServer();
  const { chromium } = await loadPlaywright();
  const browser = await chromium.launch();
  const base = `http://127.0.0.1:${PORT}`;

  console.log("app.html:");
  {
    const { context, page } = await newPage(browser, { viewport: VIEWPORTS.mobile, theme: "light", mode: "anon" });
    await page.goto(`${base}/app`, { waitUntil: "networkidle" });
    await shoot(page, "app-gate-mobile-light");
    await context.close();
  }
  for (const [vpName, vp] of Object.entries(VIEWPORTS)) {
    for (const theme of ["light", "dark"]) {
      const { context, page } = await newPage(browser, { viewport: vp, theme, mode: "ok" });
      await page.goto(`${base}/app`, { waitUntil: "networkidle" });
      await shoot(page, `app-bots-${vpName}-${theme}`);
      if (theme === "light") {
        await page.click('#mainTabs button[data-pane="square"]');
        await page.waitForTimeout(350);
        await shoot(page, `app-square-${vpName}-${theme}`);
        await page.click('#mainTabs button[data-pane="mine"]');
        await page.waitForTimeout(350);
        await shoot(page, `app-mine-${vpName}-${theme}`);
      }
      await context.close();
    }
  }

  console.log("app.html interactions:");
  {
    // QR login panel (wait_scan with mocked QR image)
    const { context, page } = await newPage(browser, { viewport: VIEWPORTS.mobile, theme: "light", mode: "ok" });
    await page.goto(`${base}/app`, { waitUntil: "networkidle" });
    await page.click("#addBot");
    await page.waitForTimeout(900);
    await shoot(page, "app-qr-waitscan-mobile-light");
    await context.close();
  }
  {
    // Persona detail modal (bottom sheet on mobile)
    const { context, page } = await newPage(browser, { viewport: VIEWPORTS.mobile, theme: "light", mode: "ok" });
    await page.goto(`${base}/app`, { waitUntil: "networkidle" });
    await page.click('#mainTabs button[data-pane="square"]');
    await page.waitForTimeout(500);
    await page.click("[data-detail]");
    await page.waitForTimeout(500);
    await shoot(page, "app-modal-detail-mobile-light", { fullPage: false });
    await context.close();
  }
  {
    // Destructive confirm card
    const { context, page } = await newPage(browser, { viewport: VIEWPORTS.mobile, theme: "light", mode: "ok" });
    await page.goto(`${base}/app`, { waitUntil: "networkidle" });
    await page.click("[data-del]");
    await page.waitForTimeout(400);
    await shoot(page, "app-confirm-mobile-light", { fullPage: false });
    await context.close();
  }
  {
    // Data-load failure → error rows + retry buttons (auth still ok)
    const { context, page } = await newPage(browser, { viewport: VIEWPORTS.mobile, theme: "light", mode: "botsError" });
    await page.goto(`${base}/app`, { waitUntil: "networkidle" });
    await page.waitForTimeout(400);
    await shoot(page, "app-error-mobile-light");
    await context.close();
  }

  console.log("admin.html:");
  const adminTabs = ["dash", "usage", "users", "bots", "personas", "audit", "system"];
  for (const [vpName, vp] of Object.entries(VIEWPORTS)) {
    const { context, page } = await newPage(browser, { viewport: vp, theme: "light", mode: "ok" });
    await page.goto(`${base}/admin`, { waitUntil: "networkidle" });
    await page.waitForTimeout(600);
    for (const tab of adminTabs) {
      await page.click(`.sidebar button[data-tab="${tab}"]`);
      await page.waitForTimeout(500);
      await shoot(page, `admin-${tab}-${vpName}-light`);
    }
    await context.close();
  }
  {
    const { context, page } = await newPage(browser, { viewport: VIEWPORTS.desktop, theme: "dark", mode: "ok" });
    await page.goto(`${base}/admin`, { waitUntil: "networkidle" });
    await page.waitForTimeout(600);
    await shoot(page, "admin-dash-desktop-dark");
    await context.close();
  }
  {
    const { context, page } = await newPage(browser, { viewport: VIEWPORTS.mobile, theme: "dark", mode: "ok" });
    await page.goto(`${base}/admin`, { waitUntil: "networkidle" });
    await page.waitForTimeout(600);
    await shoot(page, "admin-dash-mobile-dark");
    await context.close();
  }

  await browser.close();
  server.close();
  console.log("done →", OUT_DIR);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
