import assert from "node:assert/strict";
import { describe, it, type TestContext } from "node:test";
import Fastify from "fastify";
import {
  createAppSession,
  openDatabase,
  upsertUser,
} from "@wechat-ai/db";
import type { ConversationQualityPlan, TryChatService } from "@wechat-ai/core";
import { initActivityBus } from "./activity-stream.js";
import { loadConfig } from "./config.js";
import { registerRoutes, type RouteContext } from "./routes.js";

const redisUrl = process.env.REDIS_URL ?? "redis://127.0.0.1:6379";

async function fixture(
  t: TestContext,
  qualityPlan: ConversationQualityPlan,
  personaMode: "prompt" | "chatflow" = "prompt",
) {
  const db = openDatabase(redisUrl);
  try {
    await db.ping();
  } catch {
    db.close();
    t.skip("Redis not available");
    return null;
  }
  const suffix = `${process.pid}-${Math.random().toString(36).slice(2)}`;
  const user = await upsertUser(
    db,
    { id: `tqa-${suffix}`, username: `tqa_${suffix}` },
    new Set(),
  );
  const cfg = loadConfig({
    REDIS_URL: redisUrl,
    SESSION_COOKIE_NAME: "tqa_session",
    COOKIE_SECURE: "false",
  });
  const activity = initActivityBus({
    db,
    enabled: true,
    source: "api-test",
    redisSample: 0,
  });
  const tryChat = {
    async sendMessage() {
      return {
        parts: [{ kind: "text" as const, text: "visible assistant reply" }],
        displayText: "visible assistant reply",
        usage: { promptTokens: 11, completionTokens: 7, totalTokens: 18 },
        remainingToday: 39,
        remainingSession: 19,
        personaId: "persona-quality-activity",
        personaMode,
        qualityPlan,
      };
    },
  } as unknown as TryChatService;
  const app = Fastify();
  await registerRoutes(app, {
    db,
    cfg,
    chat: {} as RouteContext["chat"],
    tryChat,
    worker: {} as RouteContext["worker"],
    loginSessions: {} as RouteContext["loginSessions"],
  });
  const sid = await createAppSession(db, user.id);
  t.after(async () => {
    await app.close();
    await activity.stop();
    db.close();
  });
  return { app, activity, cookie: `tqa_session=${sid}` };
}

describe("try-chat quality activity", () => {
  it("emits the effective profile and reason codes without turn data", async (t) => {
    const qualityPlan: ConversationQualityPlan = {
      coveragePercent: 65,
      followUpPercent: 25,
      lengthWeights: [50, 35, 15],
      emotionContinuityTurns: 5,
      repetitionWindowAssistantTurns: 10,
      stableTurnKey: "must-never-leak",
      coveredTopicIds: ["covered-secret"],
      omittedTopicIds: ["omitted-secret"],
      protectedTopicIds: ["protected-secret"],
      followUp: false,
      lengthBucket: "short",
      lengthMinChars: 1,
      lengthMaxChars: 20,
    };
    const f = await fixture(t, qualityPlan);
    if (!f) return;

    const response = await f.app.inject({
      method: "POST",
      url: "/api/v1/try-chat/sessions/private-session-id/messages",
      headers: { cookie: f.cookie },
      payload: { text: "private user message" },
    });

    assert.equal(response.statusCode, 200, response.body);
    const event = f.activity
      .recentLocal(20)
      .find(
        (candidate) =>
          candidate.type === "llm.usage" &&
          candidate.data?.personaId === "persona-quality-activity",
      );
    assert.ok(event, "successful try-chat must emit a quality activity event");
    assert.deepEqual(event.data?.conversationQuality, {
      coveragePercent: 65,
      followUpPercent: 25,
      lengthWeights: [50, 35, 15],
      emotionContinuityTurns: 5,
      repetitionWindowAssistantTurns: 10,
    });
    assert.deepEqual(event.data?.qualityReasonCodes, [
      "protected-obligation",
      "coverage-limited",
      "follow-up-not-selected",
      "length-short",
    ]);
    assert.equal(event.data?.scope, "try-chat");
    assert.equal(event.data?.botId, undefined);
    assert.equal(event.data?.personaMode, "prompt");
    assert.equal(event.data?.promptTokens, 11);
    assert.equal(event.data?.completionTokens, 7);
    assert.equal(event.data?.totalTokens, 18);

    const serialized = JSON.stringify(event);
    for (const forbidden of [
      "private user message",
      "visible assistant reply",
      "private-session-id",
      "must-never-leak",
      "covered-secret",
      "omitted-secret",
      "protected-secret",
    ]) {
      assert.doesNotMatch(serialized, new RegExp(forbidden));
    }
  });

  it("identifies Chatflow executions without exposing conversation data", async (t) => {
    const qualityPlan: ConversationQualityPlan = {
      coveragePercent: 70,
      followUpPercent: 20,
      lengthWeights: [60, 30, 10],
      emotionContinuityTurns: 4,
      repetitionWindowAssistantTurns: 12,
      stableTurnKey: "chatflow-private-key",
      coveredTopicIds: ["chatflow-private-topic"],
      omittedTopicIds: [],
      protectedTopicIds: [],
      followUp: true,
      lengthBucket: "normal",
      lengthMinChars: 21,
      lengthMaxChars: 80,
    };
    const f = await fixture(t, qualityPlan, "chatflow");
    if (!f) return;

    const response = await f.app.inject({
      method: "POST",
      url: "/api/v1/try-chat/sessions/chatflow-private-session/messages",
      headers: { cookie: f.cookie },
      payload: { text: "chatflow private user message" },
    });

    assert.equal(response.statusCode, 200, response.body);
    const event = f.activity
      .recentLocal(20)
      .find((candidate) => candidate.type === "llm.usage");
    assert.ok(event);
    assert.equal(event.data?.personaMode, "chatflow");
    assert.deepEqual(event.data?.conversationQuality, {
      coveragePercent: 70,
      followUpPercent: 20,
      lengthWeights: [60, 30, 10],
      emotionContinuityTurns: 4,
      repetitionWindowAssistantTurns: 12,
    });
    assert.deepEqual(event.data?.qualityReasonCodes, [
      "coverage-complete",
      "follow-up-selected",
      "length-normal",
    ]);

    const serialized = JSON.stringify(event);
    for (const forbidden of [
      "chatflow private user message",
      "visible assistant reply",
      "chatflow-private-session",
      "chatflow-private-key",
      "chatflow-private-topic",
    ]) {
      assert.doesNotMatch(serialized, new RegExp(forbidden));
    }
  });
});
