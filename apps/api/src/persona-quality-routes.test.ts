import assert from "node:assert/strict";
import { describe, it, type TestContext } from "node:test";
import Fastify from "fastify";
import {
  createAppSession,
  openDatabase,
  upsertUser,
} from "@wechat-ai/db";
import { loadConfig } from "./config.js";
import { registerRoutes, type RouteContext } from "./routes.js";

const redisUrl = process.env.REDIS_URL ?? "redis://127.0.0.1:6379";

async function buildPersonaApi(t: TestContext) {
  const db = openDatabase(redisUrl);
  try {
    await db.ping();
  } catch {
    db.close();
    t.skip("Redis not available");
    return null;
  }
  const suffix = `${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  const user = await upsertUser(
    db,
    { id: `quality-user-${suffix}`, username: `quality_user_${suffix}`, name: "Quality User" },
    new Set(),
  );
  const admin = await upsertUser(
    db,
    {
      id: `quality-admin-${suffix}`,
      username: `quality_admin_${suffix}`,
      name: "Quality Admin",
      forceAdmin: true,
    },
    new Set(),
  );
  const [userSid, adminSid] = await Promise.all([
    createAppSession(db, user.id),
    createAppSession(db, admin.id),
  ]);
  const cfg = loadConfig({
    REDIS_URL: redisUrl,
    SESSION_COOKIE_NAME: "quality_session",
    COOKIE_SECURE: "false",
  });
  const app = Fastify();
  await registerRoutes(app, {
    db,
    cfg,
    chat: {} as RouteContext["chat"],
    tryChat: {} as RouteContext["tryChat"],
    worker: {} as RouteContext["worker"],
    loginSessions: {} as RouteContext["loginSessions"],
  });
  t.after(async () => {
    await app.close();
    db.close();
  });
  const cookie = (sid: string) => `quality_session=${sid}`;
  return { app, db, suffix, user, admin, userCookie: cookie(userSid), adminCookie: cookie(adminSid) };
}

describe("persona quality HTTP API", () => {
  it("lets an owner create, partially update and explicitly clear overrides", async (t) => {
    const f = await buildPersonaApi(t);
    if (!f) return;
    const created = await f.app.inject({
      method: "POST",
      url: "/api/v1/square/personas",
      headers: { cookie: f.userCookie },
      payload: {
        displayName: "Quality owner persona",
        systemPrompt: "quality owner prompt",
        visibility: "private",
        conversationQuality: {
          coveragePercent: 45,
          lengthWeights: [20, 70, 10],
        },
      },
    });
    assert.equal(created.statusCode, 200, created.body);
    const persona = created.json().persona;
    assert.deepEqual(persona.conversationQuality, {
      coveragePercent: 45,
      lengthWeights: [20, 70, 10],
    });

    const updated = await f.app.inject({
      method: "PUT",
      url: `/api/v1/square/personas/${persona.id}`,
      headers: { cookie: f.userCookie },
      payload: {
        conversationQuality: {
          coveragePercent: null,
          followUpPercent: 35,
        },
      },
    });
    assert.equal(updated.statusCode, 200, updated.body);
    assert.deepEqual(updated.json().persona.conversationQuality, {
      followUpPercent: 35,
      lengthWeights: [20, 70, 10],
    });
  });

  it("keeps ownership checks and rejects invalid quality payloads", async (t) => {
    const f = await buildPersonaApi(t);
    if (!f) return;
    const created = await f.app.inject({
      method: "POST",
      url: "/api/v1/square/personas",
      headers: { cookie: f.userCookie },
      payload: {
        displayName: "Protected persona",
        systemPrompt: "protected prompt",
        visibility: "private",
      },
    });
    const id = created.json().persona.id;
    const invalid = await f.app.inject({
      method: "PUT",
      url: `/api/v1/square/personas/${id}`,
      headers: { cookie: f.userCookie },
      payload: { conversationQuality: { lengthWeights: [50, 40, 9] } },
    });
    assert.equal(invalid.statusCode, 400);
    assert.match(invalid.json().error, /totaling 100/);

    const other = await upsertUser(
      f.db,
      { id: `other-${f.suffix}`, username: `other_${f.suffix}` },
      new Set(),
    );
    const otherSid = await createAppSession(f.db, other.id);
    const forbidden = await f.app.inject({
      method: "PUT",
      url: `/api/v1/square/personas/${id}`,
      headers: { cookie: `quality_session=${otherSid}` },
      payload: { conversationQuality: { coveragePercent: 12 } },
    });
    assert.equal(forbidden.statusCode, 403);
  });

  it("supports create and clear on the Admin official-persona endpoints", async (t) => {
    const f = await buildPersonaApi(t);
    if (!f) return;
    const created = await f.app.inject({
      method: "POST",
      url: "/api/v1/admin/personas",
      headers: { cookie: f.adminCookie },
      payload: {
        slug: `official-quality-${f.suffix}`,
        displayName: "Official Quality",
        systemPrompt: "official quality prompt",
        conversationQuality: { repetitionWindowAssistantTurns: 4 },
      },
    });
    assert.equal(created.statusCode, 200, created.body);
    const persona = created.json().persona;
    assert.deepEqual(persona.conversation_quality, {
      repetitionWindowAssistantTurns: 4,
    });

    const updated = await f.app.inject({
      method: "PUT",
      url: `/api/v1/admin/personas/${persona.id}`,
      headers: { cookie: f.adminCookie },
      payload: {
        conversationQuality: { repetitionWindowAssistantTurns: null },
      },
    });
    assert.equal(updated.statusCode, 200, updated.body);
    assert.equal(updated.json().persona.conversation_quality, undefined);

    const invalid = await f.app.inject({
      method: "PUT",
      url: `/api/v1/admin/personas/${persona.id}`,
      headers: { cookie: f.adminCookie },
      payload: { conversationQuality: { coveragePercent: -1 } },
    });
    assert.equal(invalid.statusCode, 400);
    assert.match(invalid.json().error, /coveragePercent.*0.*100/);

    const invalidCreate = await f.app.inject({
      method: "POST",
      url: "/api/v1/admin/personas",
      headers: { cookie: f.adminCookie },
      payload: {
        slug: `official-quality-invalid-${f.suffix}`,
        displayName: "Invalid Official Quality",
        systemPrompt: "invalid official quality prompt",
        conversationQuality: { lengthWeights: [60, 30, 9] },
      },
    });
    assert.equal(invalidCreate.statusCode, 400);
    assert.match(invalidCreate.json().error, /totaling 100/);
  });
});
