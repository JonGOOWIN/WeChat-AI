import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  approvePeer,
  clearMessages,
  getPersonaBySlug,
  insertMessage,
  listRecentMessages,
  openDatabase,
  seedPersonas,
  setAssignment,
  upsertBotAccount,
} from "@wechat-ai/db";
import type { LlmClient } from "@wechat-ai/llm";
import { ChatService } from "./chat-service.js";

const redisUrl = process.env.REDIS_URL ?? "redis://127.0.0.1:6379";

class CapturingLlm implements Pick<LlmClient, "chat" | "chatWithUsage"> {
  readonly calls: unknown[][] = [];
  private replyIndex = 0;

  constructor(
    private readonly replies: string[] = ['{"messages":["收到"]}'],
  ) {}

  private nextReply(): string {
    const value = this.replies[this.replyIndex] ?? this.replies.at(-1) ?? "";
    this.replyIndex++;
    return value;
  }

  async chat(): Promise<string> {
    return this.nextReply();
  }

  async chatWithUsage(messages: unknown[]) {
    this.calls.push(messages);
    return {
      text: this.nextReply(),
      promptTokens: 10,
      completionTokens: 5,
      totalTokens: 15,
      model: "fake",
    };
  }
}

function asLlm(fake: CapturingLlm): LlmClient {
  return fake as unknown as LlmClient;
}

describe("ChatService global conversation quality (Redis)", () => {
  it("sends the shipped quality defaults and enough repetition history to the real model prompt", async (t) => {
    const db = openDatabase(redisUrl);
    try {
      await db.ping();
    } catch {
      await db.close();
      t.skip("Redis not available");
      return;
    }

    await seedPersonas(db);
    const persona = (await getPersonaBySlug(db, "catgirl"))!;
    const botId = `bot_quality_defaults_${process.pid}`;
    const peerId = "quality_defaults@im.wechat";
    await upsertBotAccount(db, {
      id: botId,
      ownerUserId: "u_quality",
      displayName: "quality-test",
      botToken: "test-token",
    });
    await approvePeer(db, botId, peerId);
    await setAssignment(db, botId, peerId, persona.id);
    await clearMessages(db, botId, peerId);
    for (let index = 0; index < 26; index++) {
      await insertMessage(db, {
        botAccountId: botId,
        peerId,
        personaId: persona.id,
        role: index % 2 === 0 ? "user" : "assistant",
        content: `history-${index}`,
        contextToken: "seed",
      });
    }

    const llm = new CapturingLlm();
    const chat = new ChatService(db, asLlm(llm), {
      allowUnapproved: false,
      memoryExtractEveryN: 999,
      stickersEnabled: false,
      shortHistoryLimit: 20,
    });
    const result = await chat.handleInbound({
      botAccountId: botId,
      peerId,
      text: "第一件事幫我確認時間，第二件事提醒我帶傘，好嗎？",
      contextToken: "quality-defaults",
      batchItems: [
        { id: "m1", text: "幫我確認時間", attachments: [] },
        { id: "m2", text: "提醒我帶傘，好嗎？", attachments: [] },
      ],
    });

    assert.equal(result.kind, "reply");
    assert.equal(llm.calls.length, 1);
    const messages = llm.calls[0] as Array<{ role: string; content: string }>;
    const system = messages[0]?.content ?? "";
    assert.match(system, /## 本輪對話品質計畫/);
    assert.match(system, /回覆覆蓋率：70%/);
    assert.match(system, /追問目標：20%/);
    assert.match(system, /短\/普通\/長：60%\/30%\/10%/);
    assert.match(system, /情緒延續：最近 4 個完成輪次/);
    assert.match(system, /重複檢查：最近 12 個 assistant 輪次/);
    assert.ok(
      messages.slice(1, -1).length >= 24,
      `expected at least 24 history entries, got ${messages.slice(1, -1).length}`,
    );
    await db.close();
  });

  it("hot-applies partial global settings without changing protected topics or retry decisions", async (t) => {
    const db = openDatabase(redisUrl);
    try {
      await db.ping();
    } catch {
      await db.close();
      t.skip("Redis not available");
      return;
    }
    await seedPersonas(db);
    const persona = (await getPersonaBySlug(db, "catgirl"))!;
    const botId = `bot_quality_hot_apply_${process.pid}`;
    const peerId = "quality_hot_apply@im.wechat";
    await upsertBotAccount(db, {
      id: botId,
      ownerUserId: "u_quality",
      displayName: "quality-test",
      botToken: "test-token",
    });
    await approvePeer(db, botId, peerId);
    await setAssignment(db, botId, peerId, persona.id);
    await clearMessages(db, botId, peerId);

    const llm = new CapturingLlm();
    const chat = new ChatService(db, asLlm(llm), {
      memoryExtractEveryN: 999,
      stickersEnabled: false,
      conversationQuality: {
        coveragePercent: 0,
        followUpPercent: 0,
        lengthWeights: [0, 100, 0],
      },
    });
    const request = {
      botAccountId: botId,
      peerId,
      text: "今天路上很多人。請提醒我帶傘？",
      contextToken: "quality-hot-apply",
      batchItems: [
        { id: "ordinary", text: "今天路上很多人", attachments: [] },
        { id: "protected", text: "請提醒我帶傘？", attachments: [] },
      ],
    };
    const firstResult = await chat.handleInbound(request);
    assert.deepEqual(firstResult.qualityPlan?.coveredTopicIds, ["protected"]);
    assert.deepEqual(firstResult.qualityPlan?.omittedTopicIds, ["ordinary"]);
    assert.match(firstResult.qualityPlan?.stableTurnKey ?? "", /^[0-9a-f]{8}$/);
    assert.ok(!firstResult.qualityPlan?.stableTurnKey.includes(peerId));
    const firstSystem = (llm.calls[0] as Array<{ content: string }>)[0]!.content;
    assert.match(firstSystem, /必須回覆的 topic ID：protected/);
    assert.match(firstSystem, /可省略的 topic ID：ordinary/);
    assert.match(firstSystem, /不要追問；整份可見回覆 21–60 字/);

    chat.applyRuntimeOptions({
      conversationQuality: { lengthWeights: [0, 0, 100] },
    });
    await chat.handleInbound(request);
    const secondSystem = (llm.calls[1] as Array<{ content: string }>)[0]!.content;
    assert.match(secondSystem, /回覆覆蓋率：0%/);
    assert.match(secondSystem, /必須回覆的 topic ID：protected/);
    assert.match(secondSystem, /可省略的 topic ID：ordinary/);
    assert.match(secondSystem, /不要追問；整份可見回覆 61–160 字/);
    await db.close();
  });

  it("repairs a violating reply at most once before storing a single assistant turn", async (t) => {
    const db = openDatabase(redisUrl);
    try {
      await db.ping();
    } catch {
      await db.close();
      t.skip("Redis not available");
      return;
    }
    await seedPersonas(db);
    const persona = (await getPersonaBySlug(db, "catgirl"))!;
    const botId = `bot_quality_repair_${process.pid}`;
    const peerId = "quality_repair@im.wechat";
    await upsertBotAccount(db, {
      id: botId,
      ownerUserId: "u_quality",
      displayName: "quality-test",
      botToken: "test-token",
    });
    await approvePeer(db, botId, peerId);
    await setAssignment(db, botId, peerId, persona.id);
    await clearMessages(db, botId, peerId);
    await insertMessage(db, {
      botAccountId: botId,
      peerId,
      personaId: persona.id,
      role: "assistant",
      content: "放心吧，我會一直陪著你",
      contextToken: "seed",
    });

    const llm = new CapturingLlm([
      '{"messages":["放心吧，我會一直陪著你，什麼事情都可以慢慢告訴我，我會一直都在這裡？"]}',
      '{"messages":["我記住了"]}',
    ]);
    const chat = new ChatService(db, asLlm(llm), {
      memoryExtractEveryN: 999,
      stickersEnabled: false,
      conversationQuality: {
        followUpPercent: 0,
        lengthWeights: [100, 0, 0],
        repetitionWindowAssistantTurns: 12,
      },
    });
    const result = await chat.handleInbound({
      botAccountId: botId,
      peerId,
      text: "記得就好",
      contextToken: "quality-repair",
    });

    assert.equal(result.kind, "reply");
    assert.deepEqual(result.bubbles, ["我記住了"]);
    assert.equal(llm.calls.length, 2, "primary + one bounded repair");
    const repairMessages = llm.calls[1] as Array<{ role: string; content: string }>;
    assert.match(repairMessages.at(-1)?.content ?? "", /length, follow-up, repetition/);
    const history = await listRecentMessages(db, botId, peerId, 20, persona.id);
    assert.equal(
      history.filter((message) => message.role === "assistant").length,
      2,
      "one seeded assistant turn and exactly one stored reply",
    );
    assert.equal(history.at(-1)?.content, "我記住了");

    const failingLlm = new CapturingLlm([
      '{"messages":["放心吧，我會一直陪著你，什麼事情都可以慢慢告訴我，我會一直都在這裡？"]}',
      '{"messages":["放心吧，我會一直陪著你，什麼事情都可以慢慢告訴我，我會一直都在這裡？"]}',
    ]);
    const failingChat = new ChatService(db, asLlm(failingLlm), {
      memoryExtractEveryN: 999,
      stickersEnabled: false,
      conversationQuality: {
        followUpPercent: 0,
        lengthWeights: [100, 0, 0],
        repetitionWindowAssistantTurns: 12,
      },
    });
    const failed = await failingChat.handleInbound({
      botAccountId: botId,
      peerId,
      text: "請再說一次？",
      contextToken: "quality-repair-failed",
    });
    assert.equal(failed.kind, "skip");
    assert.equal(failed.skipReason, "quality_check_failed");
    assert.deepEqual(failed.qualityPlan?.coveredTopicIds, ["turn"]);
    assert.equal(failingLlm.calls.length, 2, "repair failure never loops");
    const afterFailure = await listRecentMessages(db, botId, peerId, 20, persona.id);
    assert.equal(
      afterFailure.filter((message) => message.role === "assistant").length,
      2,
      "failed repair stores no assistant turn",
    );
    await db.close();
  });
});
