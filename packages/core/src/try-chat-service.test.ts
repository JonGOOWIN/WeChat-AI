import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createPersona, openDatabase } from "@wechat-ai/db";
import type { LlmClient } from "@wechat-ai/llm";
import { TryChatError, TryChatService } from "./try-chat-service.js";

const redisUrl = process.env.REDIS_URL ?? "redis://127.0.0.1:6379";

describe("TryChatError", () => {
  it("carries code", () => {
    const e = new TryChatError("quota_day", "今日已满");
    assert.equal(e.code, "quota_day");
    assert.equal(e.message, "今日已满");
    assert.equal(e.name, "TryChatError");
  });
});

describe("TryChatService conversation quality", () => {
  it("merges global and persona settings without a peer override and keeps retry choices stable", async (t) => {
    const db = openDatabase(redisUrl);
    t.after(() => db.close());
    try { await db.ping(); } catch { t.skip("Redis not available"); return; }
    const persona = await createPersona(db, {
      displayName: `try-quality-${process.pid}-${Math.random()}`,
      systemPrompt: "reply naturally",
      ownerUserId: "try_quality_owner",
      visibility: "private",
      conversationQuality: {
        coveragePercent: 44,
        lengthWeights: [0, 0, 100],
      },
    });
    const calls: Array<Array<{ role: string; content: string }>> = [];
    const llm = {
      async chatWithUsage(messages: Array<{ role: string; content: string }>) {
        calls.push(messages);
        return { text: "這是一段符合測試需求的自然長回答內容，用來確認整份回覆確實遵循人設層選中的長回答規劃。", promptTokens: 1, completionTokens: 1, totalTokens: 2, model: "fixture" };
      },
    } as LlmClient;
    const service = new TryChatService(db, llm, {
      replyFilterEnabled: false,
      multiBubbleJson: false,
      conversationQuality: {
        coveragePercent: 70,
        followUpPercent: 0,
        lengthWeights: [100, 0, 0],
        emotionContinuityTurns: 3,
        repetitionWindowAssistantTurns: 5,
      },
    });
    const firstSession = await service.startSession({ userId: "try_quality_owner", personaId: persona.id });
    const retrySession = await service.startSession({ userId: "try_quality_owner", personaId: persona.id });
    const first = await service.sendMessage({ userId: "try_quality_owner", sessionId: firstSession.sessionId, text: "說說你的看法" });
    const retry = await service.sendMessage({ userId: "try_quality_owner", sessionId: retrySession.sessionId, text: "說說你的看法" });

    assert.equal(first.qualityPlan.coveragePercent, 44);
    assert.equal(first.qualityPlan.followUpPercent, 0);
    assert.deepEqual(first.qualityPlan.lengthWeights, [0, 0, 100]);
    assert.equal(first.qualityPlan.emotionContinuityTurns, 3);
    assert.equal(first.qualityPlan.repetitionWindowAssistantTurns, 5);
    assert.equal(first.qualityPlan.followUp, retry.qualityPlan.followUp);
    assert.equal(first.qualityPlan.lengthBucket, retry.qualityPlan.lengthBucket);
    for (const call of calls) {
      assert.match(call[0]?.content ?? "", /回覆覆蓋率：44%/);
      assert.match(call[0]?.content ?? "", /整份可見回覆 61–160 字/);
    }
  });

  it("passes its global-to-persona plan through a try-chat Chatflow custom system", async (t) => {
    const db = openDatabase(redisUrl);
    t.after(() => db.close());
    try { await db.ping(); } catch { t.skip("Redis not available"); return; }
    const persona = await createPersona(db, {
      displayName: `try-chatflow-quality-${process.pid}-${Math.random()}`,
      systemPrompt: "persona omitted by node",
      ownerUserId: "try_chatflow_quality_owner",
      visibility: "private",
      mode: "chatflow",
      graphJson: {
        version: 1,
        nodes: [
          { id: "start", type: "start" },
          { id: "llm", type: "llm", data: { system: "try custom system" } },
          { id: "answer", type: "answer", data: { answer: "{{llm.text}}" } },
        ],
        edges: [
          { id: "e1", source: "start", target: "llm" },
          { id: "e2", source: "llm", target: "answer" },
        ],
      },
      conversationQuality: { coveragePercent: 38 },
    });
    let system = "";
    const llm = {
      async chatWithUsage(messages: Array<{ role: string; content: string }>) {
        system = messages[0]?.content ?? "";
        return { text: "收到", promptTokens: 1, completionTokens: 1, totalTokens: 2, model: "fixture" };
      },
    } as LlmClient;
    const service = new TryChatService(db, llm, {
      multiBubbleJson: false,
      conversationQuality: { coveragePercent: 70, lengthWeights: [100, 0, 0] },
    });
    const session = await service.startSession({ userId: "try_chatflow_quality_owner", personaId: persona.id });

    const result = await service.sendMessage({ userId: "try_chatflow_quality_owner", sessionId: session.sessionId, text: "你好" });

    assert.equal(result.personaId, persona.id);
    assert.equal(result.personaMode, "chatflow");
    assert.equal(result.qualityPlan.coveragePercent, 38);
    assert.match(system, /try custom system/);
    assert.match(system, /回覆覆蓋率：38%/);
    assert.doesNotMatch(system, /persona omitted by node/);
  });
});
