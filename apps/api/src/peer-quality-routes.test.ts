import assert from "node:assert/strict";
import { describe, it, type TestContext } from "node:test";
import Fastify from "fastify";
import {
  approvePeer,
  createAppSession,
  getPeerConversationQuality,
  openDatabase,
  upsertBotAccount,
  upsertUser,
} from "@wechat-ai/db";
import { loadConfig } from "./config.js";
import { registerRoutes, type RouteContext } from "./routes.js";

const redisUrl = process.env.REDIS_URL ?? "redis://127.0.0.1:6379";

async function fixture(t: TestContext) {
  const db = openDatabase(redisUrl);
  try { await db.ping(); } catch { db.close(); t.skip("Redis not available"); return null; }
  const suffix = `${process.pid}-${Math.random().toString(36).slice(2)}`;
  const owner = await upsertUser(db, { id: `pqo-${suffix}`, username: `pqo_${suffix}` }, new Set());
  const other = await upsertUser(db, { id: `pqx-${suffix}`, username: `pqx_${suffix}` }, new Set());
  const admin = await upsertUser(db, { id: `pqa-${suffix}`, username: `pqa_${suffix}`, forceAdmin: true }, new Set());
  const botId = `peer-quality-bot-${suffix}`;
  await upsertBotAccount(db, { id: botId, ownerUserId: owner.id, displayName: "Quality bot", botToken: "token" });
  await approvePeer(db, botId, "peer-one");
  const cfg = loadConfig({ REDIS_URL: redisUrl, SESSION_COOKIE_NAME: "pq_session", COOKIE_SECURE: "false" });
  const app = Fastify();
  await registerRoutes(app, { db, cfg, chat: {} as RouteContext["chat"], tryChat: {} as RouteContext["tryChat"], worker: {} as RouteContext["worker"], loginSessions: {} as RouteContext["loginSessions"] });
  const sessions = await Promise.all([owner, other, admin].map((u) => createAppSession(db, u.id)));
  t.after(async () => { await app.close(); db.close(); });
  return { app, db, botId, ownerCookie: `pq_session=${sessions[0]}`, otherCookie: `pq_session=${sessions[1]}`, adminCookie: `pq_session=${sessions[2]}` };
}

describe("peer quality HTTP API", () => {
  it("lets the owner and exact admin policy save, read and clear a partial override", async (t) => {
    const f = await fixture(t); if (!f) return;
    const saved = await f.app.inject({ method: "PATCH", url: "/api/v1/me/peers/quality", headers: { cookie: f.ownerCookie }, payload: { botAccountId: f.botId, peerId: "peer-one", conversationQuality: { coveragePercent: 48, lengthWeights: [10, 80, 10] } } });
    assert.equal(saved.statusCode, 200, saved.body);
    assert.deepEqual(saved.json().conversationQuality, { coveragePercent: 48, lengthWeights: [10, 80, 10] });
    const listed = await f.app.inject({ method: "GET", url: `/api/v1/me/peers?botId=${encodeURIComponent(f.botId)}`, headers: { cookie: f.adminCookie } });
    assert.equal(listed.statusCode, 200, listed.body);
    assert.deepEqual(listed.json().peers[0].conversationQuality, { coveragePercent: 48, lengthWeights: [10, 80, 10] });
    const cleared = await f.app.inject({ method: "PATCH", url: "/api/v1/me/peers/quality", headers: { cookie: f.adminCookie }, payload: { botAccountId: f.botId, peerId: "peer-one", conversationQuality: { coveragePercent: null, lengthWeights: null } } });
    assert.equal(cleared.statusCode, 200, cleared.body);
    assert.deepEqual(await getPeerConversationQuality(f.db, f.botId, "peer-one"), {});
  });

  it("denies another owner, a mismatched bot and invalid payloads", async (t) => {
    const f = await fixture(t); if (!f) return;
    const request = (cookie: string, body: object) => f.app.inject({ method: "PATCH", url: "/api/v1/me/peers/quality", headers: { cookie }, payload: body });
    assert.equal((await request(f.otherCookie, { botAccountId: f.botId, peerId: "peer-one", conversationQuality: { coveragePercent: 1 } })).statusCode, 403);
    const forbiddenRead = await f.app.inject({ method: "GET", url: `/api/v1/me/peers?botId=${encodeURIComponent(f.botId)}`, headers: { cookie: f.otherCookie } });
    assert.equal(forbiddenRead.statusCode, 403);
    assert.equal((await request(f.ownerCookie, { botAccountId: f.botId, peerId: "not-on-this-bot", conversationQuality: { coveragePercent: 1 } })).statusCode, 404);
    const invalid = await request(f.ownerCookie, { botAccountId: f.botId, peerId: "peer-one", conversationQuality: { lengthWeights: [30, 30, 30] } });
    assert.equal(invalid.statusCode, 400);
    assert.match(invalid.json().error, /totaling 100/);
    const unknown = await request(f.ownerCookie, { botAccountId: f.botId, peerId: "peer-one", conversationQuality: { futureSetting: 1 } });
    assert.equal(unknown.statusCode, 400);
    assert.match(unknown.json().error, /unknown conversationQuality field/);
  });
});
