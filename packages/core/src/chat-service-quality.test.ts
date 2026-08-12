import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  K,
  approvePeer,
  clearMessages,
  createPersona,
  getPersonaBySlug,
  getUsageDayStats,
  insertMessage,
  listRecentMessages,
  openDatabase,
  seedPersonas,
  setAssignment,
  setPeerConversationQuality,
  updatePersonaMeta,
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
    private readonly usage = { promptTokens: 10, completionTokens: 5 },
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
      promptTokens: this.usage.promptTokens,
      completionTokens: this.usage.completionTokens,
      totalTokens: this.usage.promptTokens + this.usage.completionTokens,
      model: "fake",
    };
  }
}

function asLlm(fake: CapturingLlm): LlmClient {
  return fake as unknown as LlmClient;
}

describe("ChatService global conversation quality (Redis)", () => {
  it("applies global, persona and peer quality to Chatflow and keeps retry decisions stable", async (t) => {
    const db = openDatabase(redisUrl);
    t.after(() => db.close());
    try { await db.ping(); } catch { t.skip("Redis not available"); return; }
    const persona = await createPersona(db, {
      displayName: `chatflow-quality-${process.pid}`,
      systemPrompt: "chatflow persona",
      ownerUserId: "chatflow_quality_owner",
      visibility: "private",
      mode: "chatflow",
      graphJson: {
        version: 1,
        nodes: [
          { id: "start", type: "start" },
          { id: "llm", type: "llm", data: { system: "custom node system" } },
          { id: "answer", type: "answer", data: { answer: "{{llm.text}}" } },
        ],
        edges: [
          { id: "e1", source: "start", target: "llm" },
          { id: "e2", source: "llm", target: "answer" },
        ],
      },
      conversationQuality: { coveragePercent: 45, followUpPercent: 100 },
    });
    const botId = `chatflow_quality_${process.pid}_${Math.random()}`;
    const peerId = "chatflow-quality@im.wechat";
    await upsertBotAccount(db, { id: botId, ownerUserId: "chatflow_quality_owner", displayName: "chatflow", botToken: "token" });
    await approvePeer(db, botId, peerId);
    await setAssignment(db, botId, peerId, persona.id);
    await clearMessages(db, botId, peerId);
    await setPeerConversationQuality(db, botId, peerId, {
      coveragePercent: 92,
      lengthWeights: [100, 0, 0],
    });
    const llm = new CapturingLlm(
      ['{"messages":["收到"]}', '{"messages":["收到"]}'],
      { promptTokens: 500, completionTokens: 200 },
    );
    const chat = new ChatService(db, asLlm(llm), {
      stickersEnabled: false,
      memoryExtractEveryN: 999,
      conversationQuality: { coveragePercent: 70, repetitionWindowAssistantTurns: 8 },
    });
    const request = {
      botAccountId: botId,
      peerId,
      text: "請確認時間？",
      contextToken: "stable-chatflow-turn",
    };

    const usageBefore = await getUsageDayStats(db);
    const requestsBefore = usageBefore.by_bot[botId]?.requests ?? 0;
    const tokensBefore = usageBefore.by_bot[botId]?.total_tokens ?? 0;
    const first = await chat.handleInbound(request);
    const usageAfterFirst = await getUsageDayStats(db);
    const retry = await chat.handleInbound(request);
    const usageAfterRetry = await getUsageDayStats(db);

    assert.equal(first.kind, "reply");
    assert.equal(first.qualityPlan?.coveragePercent, 92);
    assert.equal(first.qualityPlan?.followUpPercent, 100);
    assert.deepEqual(first.qualityPlan?.lengthWeights, [100, 0, 0]);
    assert.equal(first.qualityPlan?.repetitionWindowAssistantTurns, 8);
    assert.equal(first.qualityPlan?.stableTurnKey, retry.qualityPlan?.stableTurnKey);
    assert.equal(first.qualityPlan?.followUp, retry.qualityPlan?.followUp);
    assert.equal(first.qualityPlan?.lengthBucket, retry.qualityPlan?.lengthBucket);
    assert.equal((usageAfterFirst.by_bot[botId]?.requests ?? 0) - requestsBefore, 1);
    assert.equal((usageAfterFirst.by_bot[botId]?.total_tokens ?? 0) - tokensBefore, 700);
    assert.equal((usageAfterRetry.by_bot[botId]?.requests ?? 0) - requestsBefore, 2);
    assert.equal((usageAfterRetry.by_bot[botId]?.total_tokens ?? 0) - tokensBefore, 1400);
    for (const call of llm.calls) {
      assert.match((call[0] as { content: string }).content, /回覆覆蓋率：92%/);
      assert.match((call[0] as { content: string }).content, /整份可見回覆 1–20 字/);
    }
  });

  it("keeps an ordinary Chatflow reply when the graph misses its short target", async (t) => {
    const db = openDatabase(redisUrl);
    t.after(() => db.close());
    try { await db.ping(); } catch { t.skip("Redis not available"); return; }
    const persona = await createPersona(db, {
      displayName: `chatflow-quality-best-effort-${process.pid}`,
      systemPrompt: "chatflow persona",
      ownerUserId: "chatflow_quality_best_effort_owner",
      visibility: "private",
      mode: "chatflow",
      graphJson: {
        version: 1,
        nodes: [
          { id: "start", type: "start" },
          { id: "llm", type: "llm", data: { system: "custom node" } },
          { id: "answer", type: "answer", data: { answer: "{{llm.text}}" } },
        ],
        edges: [
          { id: "e1", source: "start", target: "llm" },
          { id: "e2", source: "llm", target: "answer" },
        ],
      },
    });
    const botId = `chatflow_quality_best_effort_${process.pid}_${Math.random()}`;
    const peerId = "chatflow-quality-best-effort@im.wechat";
    await upsertBotAccount(db, { id: botId, ownerUserId: "chatflow_quality_best_effort_owner", displayName: "chatflow", botToken: "token" });
    await approvePeer(db, botId, peerId);
    await setAssignment(db, botId, peerId, persona.id);
    await clearMessages(db, botId, peerId);
    const graphReply = "今天路上的人確實很多但整體秩序還算不錯而且交通流動速度也比預期稍微順暢一些的狀態";
    assert.equal([...graphReply].length, 40);
    const chat = new ChatService(db, asLlm(new CapturingLlm([graphReply])), {
      memoryExtractEveryN: 999,
      stickersEnabled: false,
      multiBubbleJson: false,
      conversationQuality: { followUpPercent: 0, lengthWeights: [100, 0, 0] },
    });

    const result = await chat.handleInbound({
      botAccountId: botId,
      peerId,
      text: "今天路上很多人",
      contextToken: "chatflow-best-effort",
    });

    assert.equal(result.kind, "reply");
    assert.equal(result.text, graphReply);
    assert.deepEqual(result.qualityPlan?.protectedTopicIds, []);
  });

  it("inherits persona/global settings when the optional peer overlay is malformed", async (t) => {
    const db = openDatabase(redisUrl);
    t.after(() => db.close());
    try { await db.ping(); } catch { t.skip("Redis not available"); return; }
    const persona = await createPersona(db, {
      displayName: `malformed-peer-quality-${process.pid}`,
      systemPrompt: "reply naturally",
      ownerUserId: "malformed_quality_owner",
      visibility: "private",
      conversationQuality: { coveragePercent: 43 },
    });
    const botId = `malformed_peer_quality_${process.pid}_${Math.random()}`;
    const peerId = "malformed-quality@im.wechat";
    await upsertBotAccount(db, { id: botId, ownerUserId: "malformed_quality_owner", displayName: "malformed-quality", botToken: "token" });
    await approvePeer(db, botId, peerId);
    await setAssignment(db, botId, peerId, persona.id);
    await clearMessages(db, botId, peerId);
    await db.redis.set(K.peerQuality(botId, peerId), "{");
    const chat = new ChatService(db, asLlm(new CapturingLlm()), {
      allowUnapproved: false,
      memoryExtractEveryN: 999,
      stickersEnabled: false,
      shortHistoryLimit: 20,
      conversationQuality: { coveragePercent: 80 },
    });
    const result = await chat.handleInbound({ botAccountId: botId, peerId, text: "繼承設定", contextToken: "malformed-quality" });
    assert.equal(result.kind, "reply");
    assert.equal(result.qualityPlan?.coveragePercent, 43);
  });

  it("merges global, persona and peer fields then falls back after peer clear", async (t) => {
    const db = openDatabase(redisUrl);
    t.after(() => db.close());
    try { await db.ping(); } catch { t.skip("Redis not available"); return; }
    const persona = await createPersona(db, {
      displayName: `peer-quality-persona-${process.pid}`,
      systemPrompt: "reply naturally",
      ownerUserId: "peer_quality_owner",
      visibility: "private",
      conversationQuality: { coveragePercent: 44, emotionContinuityTurns: 6 },
    });
    const botId = `bot_peer_quality_${process.pid}_${Math.random()}`;
    const peerId = "peer-quality@im.wechat";
    await upsertBotAccount(db, { id: botId, ownerUserId: "peer_quality_owner", displayName: "peer-quality", botToken: "token" });
    await approvePeer(db, botId, peerId);
    await setAssignment(db, botId, peerId, persona.id);
    await clearMessages(db, botId, peerId);
    await setPeerConversationQuality(db, botId, peerId, {
      coveragePercent: 91,
      lengthWeights: [0, 0, 100],
      repetitionWindowAssistantTurns: 3,
    });
    const makeChat = () => new ChatService(db, asLlm(new CapturingLlm()), {
      allowUnapproved: false,
      memoryExtractEveryN: 999,
      stickersEnabled: false,
      shortHistoryLimit: 20,
      conversationQuality: { coveragePercent: 80, followUpPercent: 10, lengthWeights: [0, 100, 0], emotionContinuityTurns: 2, repetitionWindowAssistantTurns: 8 },
    });
    const overridden = await makeChat().handleInbound({ botAccountId: botId, peerId, text: "今天安排如何？", contextToken: "peer-quality" });
    assert.equal(overridden.qualityPlan?.coveragePercent, 91);
    assert.equal(overridden.qualityPlan?.followUpPercent, 10);
    assert.deepEqual(overridden.qualityPlan?.lengthWeights, [0, 0, 100]);
    assert.equal(overridden.qualityPlan?.emotionContinuityTurns, 6);
    assert.equal(overridden.qualityPlan?.repetitionWindowAssistantTurns, 3);

    await setPeerConversationQuality(db, botId, peerId, null);
    const inherited = await makeChat().handleInbound({ botAccountId: botId, peerId, text: "再確認一次", contextToken: "peer-quality-clear" });
    assert.equal(inherited.qualityPlan?.coveragePercent, 44);
    assert.deepEqual(inherited.qualityPlan?.lengthWeights, [0, 100, 0]);
    assert.equal(inherited.qualityPlan?.repetitionWindowAssistantTurns, 8);
  });

  it("merges global settings with the assigned persona patch field by field", async (t) => {
    const db = openDatabase(redisUrl);
    t.after(() => db.close());
    try {
      await db.ping();
    } catch {
      t.skip("Redis not available");
      return;
    }

    const persona = await createPersona(db, {
      displayName: `quality-persona-${process.pid}`,
      systemPrompt: "reply as the assigned persona",
      ownerUserId: "u_quality_persona",
      visibility: "private",
      conversationQuality: {
        coveragePercent: 44,
        emotionContinuityTurns: 6,
      },
    });
    const botId = `bot_quality_persona_${process.pid}`;
    const peerId = "quality_persona@im.wechat";
    await upsertBotAccount(db, {
      id: botId,
      ownerUserId: "u_quality_persona",
      displayName: "quality-persona-test",
      botToken: "test-token",
    });
    await approvePeer(db, botId, peerId);
    await setAssignment(db, botId, peerId, persona.id);
    await clearMessages(db, botId, peerId);

    const llm = new CapturingLlm();
    const chat = new ChatService(db, asLlm(llm), {
      allowUnapproved: false,
      memoryExtractEveryN: 999,
      stickersEnabled: false,
      shortHistoryLimit: 20,
      conversationQuality: {
        coveragePercent: 80,
        followUpPercent: 10,
        lengthWeights: [0, 100, 0],
        emotionContinuityTurns: 2,
        repetitionWindowAssistantTurns: 8,
      },
    });
    const result = await chat.handleInbound({
      botAccountId: botId,
      peerId,
      text: "幫我提醒帶傘",
      contextToken: "quality-persona-precedence",
    });

    assert.equal(result.kind, "reply");
    assert.equal(result.qualityPlan?.coveragePercent, 44);
    assert.equal(result.qualityPlan?.followUpPercent, 10);
    assert.deepEqual(result.qualityPlan?.lengthWeights, [0, 100, 0]);
    assert.equal(result.qualityPlan?.emotionContinuityTurns, 6);
    assert.equal(result.qualityPlan?.repetitionWindowAssistantTurns, 8);
    const system = (llm.calls[0] as Array<{ content: string }>)[0]?.content ?? "";
    assert.match(system, /回覆覆蓋率：44%/);
    assert.match(system, /追問目標：10%/);
    assert.match(system, /情緒延續：最近 6 個完成輪次/);
    assert.match(system, /重複檢查：最近 8 個 assistant 輪次/);
  });

  it("sends the shipped quality defaults and enough repetition history to the real model prompt", async (t) => {
    const db = openDatabase(redisUrl);
    t.after(() => db.close());
    try {
      await db.ping();
    } catch {
      t.skip("Redis not available");
      return;
    }

    await seedPersonas(db);
    const persona = (await getPersonaBySlug(db, "catgirl"))!;
    await updatePersonaMeta(db, persona.id, { conversationQuality: null });
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
  });

  it("hot-applies partial global settings without changing protected topics or retry decisions", async (t) => {
    const db = openDatabase(redisUrl);
    t.after(() => db.close());
    try {
      await db.ping();
    } catch {
      t.skip("Redis not available");
      return;
    }
    await seedPersonas(db);
    const persona = (await getPersonaBySlug(db, "catgirl"))!;
    await updatePersonaMeta(db, persona.id, { conversationQuality: null });
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
      text: "走吧。在嗎。請提醒我帶傘？",
      contextToken: "quality-hot-apply",
      batchItems: [
        { id: "ordinary", text: "走吧", attachments: [] },
        { id: "modal", text: "在嗎", attachments: [] },
        { id: "protected", text: "請提醒我帶傘？", attachments: [] },
      ],
      replyPlan: {
        decision: "reply" as const,
        targetPartCount: 1 as const,
        coveredItemIds: ["ordinary", "modal", "protected"],
        reason: "reply-obligation" as const,
        skipBiasPercent: 10,
        items: [
          { id: "ordinary", kind: "continuation" as const, replyObligation: true },
          {
            id: "modal",
            kind: "new-question-or-request" as const,
            replyObligation: true,
          },
          {
            id: "protected",
            kind: "new-question-or-request" as const,
            replyObligation: true,
          },
        ],
      },
    };
    const firstResult = await chat.handleInbound(request);
    assert.deepEqual(firstResult.qualityPlan?.coveredTopicIds, [
      "modal",
      "protected",
    ]);
    assert.deepEqual(firstResult.qualityPlan?.omittedTopicIds, ["ordinary"]);
    assert.match(firstResult.qualityPlan?.stableTurnKey ?? "", /^[0-9a-f]{8}$/);
    assert.ok(!firstResult.qualityPlan?.stableTurnKey.includes(peerId));
    const firstSystem = (llm.calls[0] as Array<{ content: string }>)[0]!.content;
    assert.match(firstSystem, /必須回覆的 topic ID：modal, protected/);
    assert.match(firstSystem, /可省略的 topic ID：ordinary/);
    assert.match(firstSystem, /不要追問；整份可見回覆 21–60 字/);

    chat.applyRuntimeOptions({
      conversationQuality: { lengthWeights: [0, 0, 100] },
    });
    await chat.handleInbound(request);
    const secondSystem = (llm.calls[1] as Array<{ content: string }>)[0]!.content;
    assert.match(secondSystem, /回覆覆蓋率：0%/);
    assert.match(secondSystem, /必須回覆的 topic ID：modal, protected/);
    assert.match(secondSystem, /可省略的 topic ID：ordinary/);
    assert.match(secondSystem, /不要追問；整份可見回覆 61–160 字/);
    chat.applyRuntimeOptions({
      conversationQuality: {
        emotionContinuityTurns: 4.9,
        repetitionWindowAssistantTurns: 12.5,
      },
    });

    const legacyBase = {
      botAccountId: botId,
      peerId,
      text: "同一句 legacy inbound",
    };
    const retryA1 = await chat.handleInbound({
      ...legacyBase,
      contextToken: "legacy-turn-a",
    });
    assert.equal(retryA1.qualityPlan?.emotionContinuityTurns, 5);
    assert.equal(retryA1.qualityPlan?.repetitionWindowAssistantTurns, 13);
    const retryA2 = await chat.handleInbound({
      ...legacyBase,
      contextToken: "legacy-turn-a",
    });
    const retryB = await chat.handleInbound({
      ...legacyBase,
      contextToken: "legacy-turn-b",
    });
    assert.equal(
      retryA1.qualityPlan?.stableTurnKey,
      retryA2.qualityPlan?.stableTurnKey,
    );
    assert.notEqual(
      retryA1.qualityPlan?.stableTurnKey,
      retryB.qualityPlan?.stableTurnKey,
    );
    const directModal = await chat.handleInbound({
      botAccountId: botId,
      peerId,
      text: "在嗎",
      contextToken: "legacy-direct-modal",
    });
    assert.deepEqual(directModal.qualityPlan?.protectedTopicIds, ["turn"]);
    assert.deepEqual(directModal.qualityPlan?.coveredTopicIds, ["turn"]);
    for (const [index, text] of [
      "在嗎",
      "在吗 ！",
      "你好嗎？",
      "你呢…",
      "有空吗 啊。",
      "你在做什麼",
    ].entries()) {
      const modalVariant = await chat.handleInbound({
        botAccountId: botId,
        peerId,
        text,
        contextToken: `legacy-direct-modal-${index}`,
      });
      assert.deepEqual(
        modalVariant.qualityPlan?.protectedTopicIds,
        ["turn"],
        text,
      );
    }
  });

  it("repairs a violating reply at most once before storing a single assistant turn", async (t) => {
    const db = openDatabase(redisUrl);
    t.after(() => db.close());
    try {
      await db.ping();
    } catch {
      t.skip("Redis not available");
      return;
    }
    await seedPersonas(db);
    const persona = (await getPersonaBySlug(db, "catgirl"))!;
    await updatePersonaMeta(db, persona.id, { conversationQuality: null });
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
      content: "週五下午三點在南門碰面記得帶藍色文件夾",
      contextToken: "seed",
    });

    const llm = new CapturingLlm([
      '{"messages":["週五下午三點在南門碰面記得帶藍色文件夾，另外出門以前請再次確認所有資料是否完整，若有任何變動也請立刻告訴我，並且提早十分鐘到達約定地點不要遲到？"]}',
      '{"messages":["我記住了"]}',
    ]);
    const chat = new ChatService(db, asLlm(llm), {
      memoryExtractEveryN: 999,
      stickersEnabled: false,
      conversationQuality: {
        followUpPercent: 0,
        lengthWeights: [0, 100, 0],
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
      '{"messages":["週五下午三點在南門碰面記得帶藍色文件夾，另外出門以前請再次確認所有資料是否完整，若有任何變動也請立刻告訴我，並且提早十分鐘到達約定地點不要遲到？"]}',
      '{"messages":["週五下午三點在南門碰面記得帶藍色文件夾？"]}',
    ]);
    const failingChat = new ChatService(db, asLlm(failingLlm), {
      memoryExtractEveryN: 999,
      stickersEnabled: false,
      conversationQuality: {
        followUpPercent: 0,
        lengthWeights: [0, 100, 0],
        repetitionWindowAssistantTurns: 12,
      },
    });
    const failed = await failingChat.handleInbound({
      botAccountId: botId,
      peerId,
      text: "請再說一次？",
      contextToken: "quality-repair-failed",
    });
    assert.equal(failed.kind, "reply");
    assert.deepEqual(failed.bubbles, ["週五下午三點在南門碰面記得帶藍色文件夾？"]);
    assert.deepEqual(failed.qualityPlan?.coveredTopicIds, ["turn"]);
    assert.equal(failingLlm.calls.length, 2, "repair failure never loops");
    const afterFailure = await listRecentMessages(db, botId, peerId, 20, persona.id);
    assert.equal(
      afterFailure.filter((message) => message.role === "assistant").length,
      3,
      "protected inbound stores exactly one best-effort assistant turn",
    );

    await insertMessage(db, {
      botAccountId: botId,
      peerId,
      personaId: persona.id,
      role: "assistant",
      content: "我會一直在這裡陪著你",
      contextToken: "common-reassurance-seed",
    });
    const reassuranceLlm = new CapturingLlm([
      '{"messages":["我會一直在這裡陪著你"]}',
    ]);
    const reassuranceChat = new ChatService(db, asLlm(reassuranceLlm), {
      memoryExtractEveryN: 999,
      stickersEnabled: false,
      conversationQuality: {
        followUpPercent: 0,
        lengthWeights: [0, 100, 0],
        repetitionWindowAssistantTurns: 12,
      },
    });
    const reassurance = await reassuranceChat.handleInbound({
      botAccountId: botId,
      peerId,
      text: "我真的很難過",
      contextToken: "common-reassurance",
    });
    assert.equal(reassurance.kind, "reply");
    assert.equal(
      reassuranceLlm.calls.length,
      1,
      "a short common reassurance does not trigger repetition repair",
    );

    const urlLlm = new CapturingLlm([
      '{"messages":["請看 https://example.com/search?q=雨傘"]}',
    ]);
    const urlChat = new ChatService(db, asLlm(urlLlm), {
      memoryExtractEveryN: 999,
      stickersEnabled: false,
      conversationQuality: {
        followUpPercent: 0,
        lengthWeights: [0, 100, 0],
        repetitionWindowAssistantTurns: 12,
      },
    });
    const urlReply = await urlChat.handleInbound({
      botAccountId: botId,
      peerId,
      text: "給我搜尋網址",
      contextToken: "url-query-not-question",
    });
    assert.equal(urlReply.kind, "reply");
    assert.equal(urlLlm.calls.length, 1, "a URL query is not a follow-up");

    const modalLlm = new CapturingLlm([
      '{"messages":["你現在方便嗎"]}',
      '{"messages":["稍後再聊"]}',
    ]);
    const modalChat = new ChatService(db, asLlm(modalLlm), {
      memoryExtractEveryN: 999,
      stickersEnabled: false,
      conversationQuality: {
        followUpPercent: 0,
        lengthWeights: [0, 100, 0],
        repetitionWindowAssistantTurns: 12,
      },
    });
    const modalReply = await modalChat.handleInbound({
      botAccountId: botId,
      peerId,
      text: "先說重點",
      contextToken: "modal-follow-up",
    });
    assert.equal(modalReply.kind, "reply");
    assert.deepEqual(modalReply.bubbles, ["稍後再聊"]);
    assert.equal(modalLlm.calls.length, 2, "a modal-ending question is repaired");

    const adjacentUrlLlm = new CapturingLlm([
      '{"messages":["看https://a.example/p?b=1好嗎"]}',
      '{"messages":["稍後再看"]}',
    ]);
    const adjacentUrlChat = new ChatService(db, asLlm(adjacentUrlLlm), {
      memoryExtractEveryN: 999,
      stickersEnabled: false,
      conversationQuality: {
        followUpPercent: 0,
        lengthWeights: [0, 100, 0],
        repetitionWindowAssistantTurns: 12,
      },
    });
    const adjacentUrlReply = await adjacentUrlChat.handleInbound({
      botAccountId: botId,
      peerId,
      text: "先給連結",
      contextToken: "url-followed-by-modal",
    });
    assert.equal(adjacentUrlReply.kind, "reply");
    assert.deepEqual(adjacentUrlReply.bubbles, ["稍後再看"]);
    assert.equal(
      adjacentUrlLlm.calls.length,
      2,
      "URL query is ignored while adjacent CJK modal remains a question",
    );

    const ordinaryAssistantBefore = (
      await listRecentMessages(db, botId, peerId, 100, persona.id)
    ).filter((message) => message.role === "assistant").length;
    const ordinaryLong =
      "這是一段刻意超過短回答上限而且沒有任何受保護話題需要最佳努力送出的普通回答";
    const ordinaryLlm = new CapturingLlm([
      JSON.stringify({ messages: [ordinaryLong] }),
      JSON.stringify({ messages: [ordinaryLong] }),
    ]);
    const ordinaryChat = new ChatService(db, asLlm(ordinaryLlm), {
      memoryExtractEveryN: 999,
      stickersEnabled: false,
      conversationQuality: {
        followUpPercent: 0,
        lengthWeights: [100, 0, 0],
        repetitionWindowAssistantTurns: 0,
      },
    });
    const ordinary = await ordinaryChat.handleInbound({
      botAccountId: botId,
      peerId,
      text: "今天路上很多人",
      contextToken: "ordinary-fail-closed",
    });
    assert.equal(ordinary.kind, "skip");
    assert.equal(ordinary.skipReason, "quality_check_failed");
    assert.deepEqual(ordinary.qualityPlan?.protectedTopicIds, []);
    const ordinaryAssistantAfter = (
      await listRecentMessages(db, botId, peerId, 100, persona.id)
    ).filter((message) => message.role === "assistant").length;
    assert.equal(ordinaryAssistantAfter, ordinaryAssistantBefore);
  });

  it("accounts for all four generation and filter requests while storing one reply", async (t) => {
    const db = openDatabase(redisUrl);
    t.after(() => db.close());
    try {
      await db.ping();
    } catch {
      t.skip("Redis not available");
      return;
    }
    await seedPersonas(db);
    const persona = (await getPersonaBySlug(db, "catgirl"))!;
    await updatePersonaMeta(db, persona.id, { conversationQuality: null });
    const botId = `bot_quality_usage_${process.pid}`;
    const peerId = "quality_usage@im.wechat";
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
      content: "週五下午三點在南門碰面記得帶藍色文件夾",
      contextToken: "seed",
    });

    const longReply =
      "週五下午三點在南門碰面記得帶藍色文件夾，另外出門以前請再次確認所有資料是否完整，若有任何變動也請立刻告訴我，並且提早十分鐘到達約定地點不要遲到？";
    const llm = new CapturingLlm([
      longReply,
      JSON.stringify({ messages: [longReply] }),
      "我記住了",
      JSON.stringify({ messages: ["我記住了"] }),
    ]);
    const before = await getUsageDayStats(db);
    const requestsBefore = before.by_bot[botId]?.requests ?? 0;
    const tokensBefore = before.by_bot[botId]?.total_tokens ?? 0;
    const chat = new ChatService(db, asLlm(llm), {
      memoryExtractEveryN: 999,
      stickersEnabled: false,
      replyFilterEnabled: true,
      conversationQuality: {
        followUpPercent: 0,
        lengthWeights: [0, 100, 0],
        repetitionWindowAssistantTurns: 12,
      },
    });
    const result = await chat.handleInbound({
      botAccountId: botId,
      peerId,
      text: "請再確認一次？",
      contextToken: "quality-four-calls",
    });

    assert.equal(result.kind, "reply");
    assert.deepEqual(result.bubbles, ["我記住了"]);
    assert.equal(llm.calls.length, 4);
    const after = await getUsageDayStats(db);
    assert.equal((after.by_bot[botId]?.requests ?? 0) - requestsBefore, 4);
    assert.equal((after.by_bot[botId]?.total_tokens ?? 0) - tokensBefore, 60);
    const history = await listRecentMessages(db, botId, peerId, 20, persona.id);
    assert.equal(
      history.filter((message) => message.role === "assistant").length,
      2,
      "one seeded turn plus one final assistant reply",
    );
  });
});
