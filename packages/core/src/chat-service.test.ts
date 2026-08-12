import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  approvePeer,
  clearMessages,
  getUsageDayStats,
  listMemories,
  listRecentMessages,
  openDatabase,
  replaceMemories,
  seedPersonas,
  setAssignment,
  setPeerProactiveEnabled,
  getPersonaBySlug,
  upsertBotAccount,
} from "@wechat-ai/db";
import type { LlmClient } from "@wechat-ai/llm";
import { ChatService } from "./chat-service.js";

const redisUrl = process.env.REDIS_URL ?? "redis://127.0.0.1:6379";

class FakeLlm implements Pick<LlmClient, "chat" | "chatWithUsage"> {
  calls = 0;
  constructor(private reply: string | string[]) {}
  private next(): string {
    this.calls++;
    if (typeof this.reply === "string") return this.reply;
    const i = Math.min(this.calls - 1, this.reply.length - 1);
    return this.reply[i] ?? "";
  }
  async chat(): Promise<string> {
    return this.next();
  }
  async chatWithUsage(_messages?: unknown, _opts?: unknown) {
    return {
      text: this.next(),
      promptTokens: 10,
      completionTokens: 5,
      totalTokens: 15,
      model: "fake",
    };
  }
}

class ScriptedLlm implements Pick<LlmClient, "chat" | "chatWithUsage"> {
  calls = 0;
  constructor(private readonly replies: Array<string | Error>) {}

  private next(): string {
    const reply = this.replies[this.calls] ?? this.replies.at(-1) ?? "";
    this.calls++;
    if (reply instanceof Error) throw reply;
    return reply;
  }

  async chat(): Promise<string> {
    return this.next();
  }

  async chatWithUsage() {
    return {
      text: this.next(),
      promptTokens: 10,
      completionTokens: 5,
      totalTokens: 15,
      model: "fake",
    };
  }
}

function asLlm(
  fake: Pick<LlmClient, "chat" | "chatWithUsage">,
): LlmClient {
  return fake as unknown as LlmClient;
}

function noOpUsageDb(): never {
  const pipeline = {
    hincrby() {
      return pipeline;
    },
    expire() {
      return pipeline;
    },
    hset() {
      return pipeline;
    },
    sadd() {
      return pipeline;
    },
    async exec() {
      return [];
    },
  };
  return { redis: { pipeline: () => pipeline } } as never;
}

describe("ChatService multi-user isolation (Redis)", () => {
  it("keeps separate memories per peer", async (t) => {
    let db;
    try {
      db = openDatabase(redisUrl);
      await Promise.race([
        db.ping(),
        new Promise((_, rej) =>
          setTimeout(() => rej(new Error("timeout")), 2500),
        ),
      ]);
    } catch {
      try {
        await db?.close();
      } catch {
        /* ignore */
      }
      t.skip("Redis not available");
      return;
    }
    await seedPersonas(db);
    const cat = (await getPersonaBySlug(db, "catgirl"))!;
    const botId = `bot_test_${Date.now()}`;
    await upsertBotAccount(db, {
      id: botId,
      ownerUserId: "u_test",
      displayName: "test",
      botToken: "test-token",
    });

    await approvePeer(db, botId, "user_a@im.wechat");
    await approvePeer(db, botId, "user_b@im.wechat");
    await setAssignment(db, botId, "user_a@im.wechat", cat.id);
    await setAssignment(db, botId, "user_b@im.wechat", cat.id);
    await replaceMemories(db, botId, "user_a@im.wechat", cat.id, ["A 喜欢草莓"]);
    await replaceMemories(db, botId, "user_b@im.wechat", cat.id, ["B 喜欢蓝莓"]);

    const memA = await listMemories(db, botId, "user_a@im.wechat", cat.id);
    const memB = await listMemories(db, botId, "user_b@im.wechat", cat.id);
    assert.equal(memA[0]?.content, "A 喜欢草莓");
    assert.equal(memB[0]?.content, "B 喜欢蓝莓");

    const chat = new ChatService(db, asLlm(new FakeLlm("喵～你好")), {
      allowUnapproved: false,
      memoryExtractEveryN: 999,
      // Keep isolation test free of second-pass filter coupling
      replyFilterEnabled: false,
    });
    const r1 = await chat.handleInbound({
      botAccountId: botId,
      peerId: "user_a@im.wechat",
      text: "嗨",
      contextToken: "tok-a",
    });
    assert.equal(r1.kind, "reply");
    await db.close();
  });

  it("handleInbound uses reply filter second LLM pass", async (t) => {
    let db;
    try {
      db = openDatabase(redisUrl);
      await Promise.race([
        db.ping(),
        new Promise((_, rej) =>
          setTimeout(() => rej(new Error("timeout")), 2500),
        ),
      ]);
    } catch {
      try {
        await db?.close();
      } catch {
        /* ignore */
      }
      t.skip("Redis not available");
      return;
    }
    await seedPersonas(db);
    const cat = (await getPersonaBySlug(db, "catgirl"))!;
    const botId = `bot_filter_${Date.now()}`;
    await upsertBotAccount(db, {
      id: botId,
      ownerUserId: "u_test",
      displayName: "test",
      botToken: "test-token",
    });
    await approvePeer(db, botId, "user_f@im.wechat");
    await setAssignment(db, botId, "user_f@im.wechat", cat.id);

    const fake = new FakeLlm([
      "好呀～想你了 下次见哦",
      JSON.stringify({ messages: ["好呀～", "想你了", "下次见哦"] }),
    ]);
    const chat = new ChatService(db, asLlm(fake), {
      allowUnapproved: false,
      memoryExtractEveryN: 999,
      replyFilterEnabled: true,
      stickersEnabled: false,
    });
    const r = await chat.handleInbound({
      botAccountId: botId,
      peerId: "user_f@im.wechat",
      text: "嗨",
      contextToken: "tok-f",
    });
    assert.equal(r.kind, "reply");
    assert.equal(fake.calls, 2, "primary + filter LLM");
    assert.ok(r.parts && r.parts.length >= 2, JSON.stringify(r.parts));
    assert.equal(r.bubblesFromJson, true);
    await db.close();
  });

  it("handleProactive skips without writing user message", async (t) => {
    let db;
    try {
      db = openDatabase(redisUrl);
      await Promise.race([
        db.ping(),
        new Promise((_, rej) =>
          setTimeout(() => rej(new Error("timeout")), 2500),
        ),
      ]);
    } catch {
      try {
        await db?.close();
      } catch {
        /* ignore */
      }
      t.skip("Redis not available");
      return;
    }
    await seedPersonas(db);
    const cat = (await getPersonaBySlug(db, "catgirl"))!;
    const botId = `bot_proactive_${Date.now()}`;
    await upsertBotAccount(db, {
      id: botId,
      ownerUserId: "u_test",
      displayName: "test",
      botToken: "test-token",
    });
    await approvePeer(db, botId, "user_p@im.wechat");
    await setAssignment(db, botId, "user_p@im.wechat", cat.id);
    await setPeerProactiveEnabled(db, botId, "user_p@im.wechat", true);

    const chat = new ChatService(
      db,
      asLlm(new FakeLlm('{"skip":true,"reason":"quiet"}')),
      {
        allowUnapproved: false,
        memoryExtractEveryN: 999,
        replyFilterEnabled: true,
      },
    );
    const r = await chat.handleProactive({
      botAccountId: botId,
      peerId: "user_p@im.wechat",
      contextToken: "tok-p",
      idleHours: 14,
    });
    assert.equal(r.kind, "skip");
    const hist = await listRecentMessages(db, botId, "user_p@im.wechat", 20);
    assert.equal(hist.length, 0);
    await db.close();
  });

  it("handleProactive stores assistant reply", async (t) => {
    let db;
    try {
      db = openDatabase(redisUrl);
      await Promise.race([
        db.ping(),
        new Promise((_, rej) =>
          setTimeout(() => rej(new Error("timeout")), 2500),
        ),
      ]);
    } catch {
      try {
        await db?.close();
      } catch {
        /* ignore */
      }
      t.skip("Redis not available");
      return;
    }
    await seedPersonas(db);
    const cat = (await getPersonaBySlug(db, "catgirl"))!;
    const botId = `bot_proactive2_${Date.now()}`;
    await upsertBotAccount(db, {
      id: botId,
      ownerUserId: "u_test",
      displayName: "test",
      botToken: "test-token",
    });
    await approvePeer(db, botId, "user_q@im.wechat");
    await setAssignment(db, botId, "user_q@im.wechat", cat.id);
    await setPeerProactiveEnabled(db, botId, "user_q@im.wechat", true);

    const fake = new FakeLlm([
      "想你啦 在干嘛喵",
      JSON.stringify({ messages: ["想你啦", "在干嘛喵"] }),
    ]);
    const chat = new ChatService(db, asLlm(fake), {
      allowUnapproved: false,
      memoryExtractEveryN: 999,
      replyFilterEnabled: true,
      stickersEnabled: false,
    });
    const r = await chat.handleProactive({
      botAccountId: botId,
      peerId: "user_q@im.wechat",
      contextToken: "tok-q",
      idleHours: 15,
    });
    assert.equal(r.kind, "reply");
    assert.equal(fake.calls, 2);
    assert.ok(r.parts && r.parts.length >= 1);
    const hist = await listRecentMessages(db, botId, "user_q@im.wechat", 20);
    assert.equal(hist.length, 1);
    assert.equal(hist[0]?.role, "assistant");
    await db.close();
  });

  it("handleInbound single-pass parses primary multi-bubble JSON (filter off)", async (t) => {
    let db;
    try {
      db = openDatabase(redisUrl);
      await Promise.race([
        db.ping(),
        new Promise((_, rej) =>
          setTimeout(() => rej(new Error("timeout")), 2500),
        ),
      ]);
    } catch {
      try {
        await db?.close();
      } catch {
        /* ignore */
      }
      t.skip("Redis not available");
      return;
    }
    await seedPersonas(db);
    const cat = (await getPersonaBySlug(db, "catgirl"))!;
    const botId = `bot_single_${Date.now()}`;
    await upsertBotAccount(db, {
      id: botId,
      ownerUserId: "u_test",
      displayName: "test",
      botToken: "test-token",
    });
    await approvePeer(db, botId, "user_s@im.wechat");
    await setAssignment(db, botId, "user_s@im.wechat", cat.id);

    const fake = new FakeLlm(
      JSON.stringify({
        messages: [
          "给你看～",
          { type: "sticker", slug: "wave" },
          "喜欢吗",
        ],
      }),
    );
    const chat = new ChatService(db, asLlm(fake), {
      allowUnapproved: false,
      memoryExtractEveryN: 999,
      // default path: no second-pass filter
      replyFilterEnabled: false,
      stickersEnabled: false,
      conversationQuality: { followUpPercent: 100 },
    });
    const r = await chat.handleInbound({
      botAccountId: botId,
      peerId: "user_s@im.wechat",
      text: "嗨",
      contextToken: "tok-s",
    });
    assert.equal(r.kind, "reply");
    assert.equal(fake.calls, 1, "primary LLM only");
    assert.equal(r.bubblesFromJson, true);
    // stickersEnabled false → no catalog; dropDisallowedStickers drops unknown stickers
    assert.ok(r.parts && r.parts.length >= 2, JSON.stringify(r.parts));
    assert.ok(
      r.parts!.every((p) => p.kind === "text"),
      "without sticker catalog, stickers must be dropped",
    );
    assert.ok(
      !JSON.stringify(r.parts).includes('"type":"sticker"') ||
        r.parts!.some((p) => p.kind === "text" && p.text.includes("给你看")),
    );
    await db.close();
  });
});

describe("ChatService legacy reply-filter fail-closed behavior (Redis)", () => {
  it("skips an authoritative-empty inbound reply without assistant history", async (t) => {
    const db = openDatabase(redisUrl);
    t.after(() => db.close());
    await db.ping();
    await seedPersonas(db);
    const persona = (await getPersonaBySlug(db, "catgirl"))!;
    const botId = "bot_issue13_inbound_authoritative_empty";
    const peerId = "issue13-inbound-empty@im.wechat";
    await upsertBotAccount(db, {
      id: botId,
      ownerUserId: "u_test",
      displayName: "issue13",
      botToken: "test-token",
    });
    await approvePeer(db, botId, peerId);
    await setAssignment(db, botId, peerId, persona.id);
    await clearMessages(db, botId, peerId);

    const llm = new ScriptedLlm([
      "primary reply",
      '{"messages":[]}',
    ]);
    const before = await getUsageDayStats(db);
    const requestsBefore = before.by_bot[botId]?.requests ?? 0;
    const chat = new ChatService(db, asLlm(llm), {
      allowUnapproved: false,
      memoryExtractEveryN: 999,
      replyFilterEnabled: true,
      stickersEnabled: false,
    });

    const result = await chat.handleInbound({
      botAccountId: botId,
      peerId,
      text: "请回答？",
      contextToken: "issue13-inbound-empty-token",
    });

    assert.equal(result.kind, "skip");
    assert.equal(result.skipReason, "empty_reply");
    assert.equal(llm.calls, 2, "primary + filter LLM");
    const history = await listRecentMessages(db, botId, peerId, 20);
    assert.equal(
      history.filter((message) => message.role === "assistant").length,
      0,
    );
    const after = await getUsageDayStats(db);
    assert.equal((after.by_bot[botId]?.requests ?? 0) - requestsBefore, 2);
  });

  it("skips an unknown-sticker-only proactive reply without assistant history", async (t) => {
    const db = openDatabase(redisUrl);
    t.after(() => db.close());
    await db.ping();
    await seedPersonas(db);
    const persona = (await getPersonaBySlug(db, "catgirl"))!;
    const botId = "bot_issue13_proactive_unknown_sticker";
    const peerId = "issue13-proactive-sticker@im.wechat";
    await upsertBotAccount(db, {
      id: botId,
      ownerUserId: "u_test",
      displayName: "issue13",
      botToken: "test-token",
    });
    await approvePeer(db, botId, peerId);
    await setAssignment(db, botId, peerId, persona.id);
    await setPeerProactiveEnabled(db, botId, peerId, true);
    await clearMessages(db, botId, peerId);

    const llm = new ScriptedLlm([
      "primary proactive reply",
      '{"messages":[{"type":"sticker","slug":"ghost"}]}',
    ]);
    const before = await getUsageDayStats(db);
    const requestsBefore = before.by_bot[botId]?.requests ?? 0;
    const chat = new ChatService(db, asLlm(llm), {
      allowUnapproved: false,
      memoryExtractEveryN: 999,
      replyFilterEnabled: true,
      stickersEnabled: false,
    });

    const result = await chat.handleProactive({
      botAccountId: botId,
      peerId,
      contextToken: "issue13-proactive-sticker-token",
      idleHours: 12,
    });

    assert.equal(result.kind, "skip");
    assert.equal(result.skipReason, "empty_reply");
    assert.equal(llm.calls, 2, "primary + filter LLM");
    const history = await listRecentMessages(db, botId, peerId, 20);
    assert.equal(history.length, 0);
    assert.equal(JSON.stringify(history).includes("ghost"), false);
    const after = await getUsageDayStats(db);
    assert.equal((after.by_bot[botId]?.requests ?? 0) - requestsBefore, 2);
  });

  it("does not leak a sticker-only primary wrapper when the inbound filter fails", async (t) => {
    const db = openDatabase(redisUrl);
    t.after(() => db.close());
    await db.ping();
    await seedPersonas(db);
    const persona = (await getPersonaBySlug(db, "catgirl"))!;
    const botId = "bot_issue13_primary_wrapper";
    const peerId = "issue13-primary-wrapper@im.wechat";
    await upsertBotAccount(db, {
      id: botId,
      ownerUserId: "u_test",
      displayName: "issue13",
      botToken: "test-token",
    });
    await approvePeer(db, botId, peerId);
    await setAssignment(db, botId, peerId, persona.id);
    await clearMessages(db, botId, peerId);

    const llm = new ScriptedLlm([
      '{"messages":[{"type":"sticker","slug":"ghost"}]}',
      new Error("filter unavailable"),
    ]);
    const before = await getUsageDayStats(db);
    const requestsBefore = before.by_bot[botId]?.requests ?? 0;
    const chat = new ChatService(db, asLlm(llm), {
      allowUnapproved: false,
      memoryExtractEveryN: 999,
      replyFilterEnabled: true,
      stickersEnabled: false,
    });

    const result = await chat.handleInbound({
      botAccountId: botId,
      peerId,
      text: "请回答？",
      contextToken: "issue13-primary-wrapper-token",
    });

    assert.equal(result.kind, "skip");
    assert.equal(result.skipReason, "empty_reply");
    assert.equal(llm.calls, 2, "primary + failed filter LLM");
    const history = await listRecentMessages(db, botId, peerId, 20);
    assert.equal(
      history.filter((message) => message.role === "assistant").length,
      0,
    );
    assert.equal(JSON.stringify(history).includes("ghost"), false);
    const after = await getUsageDayStats(db);
    assert.equal((after.by_bot[botId]?.requests ?? 0) - requestsBefore, 2);
  });

  it("uses safely parsed primary parts when the proactive filter fails", async (t) => {
    const db = openDatabase(redisUrl);
    t.after(() => db.close());
    await db.ping();
    await seedPersonas(db);
    const persona = (await getPersonaBySlug(db, "catgirl"))!;
    const botId = "bot_issue13_proactive_primary_fallback";
    const peerId = "issue13-proactive-fallback@im.wechat";
    await upsertBotAccount(db, {
      id: botId,
      ownerUserId: "u_test",
      displayName: "issue13",
      botToken: "test-token",
    });
    await approvePeer(db, botId, peerId);
    await setAssignment(db, botId, peerId, persona.id);
    await setPeerProactiveEnabled(db, botId, peerId, true);
    await clearMessages(db, botId, peerId);

    const llm = new ScriptedLlm([
      '{"messages":["第一条","第二条"]}',
      new Error("filter unavailable"),
    ]);
    const before = await getUsageDayStats(db);
    const requestsBefore = before.by_bot[botId]?.requests ?? 0;
    const chat = new ChatService(db, asLlm(llm), {
      allowUnapproved: false,
      memoryExtractEveryN: 999,
      replyFilterEnabled: true,
      stickersEnabled: false,
    });

    const result = await chat.handleProactive({
      botAccountId: botId,
      peerId,
      contextToken: "issue13-proactive-fallback-token",
      idleHours: 12,
    });

    assert.equal(result.kind, "reply");
    assert.deepEqual(
      result.parts?.map((part) =>
        part.kind === "text" ? part.text : part.slug,
      ),
      ["第一条", "第二条"],
    );
    assert.equal(result.text, "第一条\n第二条");
    assert.equal(llm.calls, 2, "primary + failed filter LLM");
    const history = await listRecentMessages(db, botId, peerId, 20);
    assert.deepEqual(
      history.map((message) => [message.role, message.content]),
      [["assistant", "第一条\n第二条"]],
    );
    const after = await getUsageDayStats(db);
    assert.equal((after.by_bot[botId]?.requests ?? 0) - requestsBefore, 2);
  });

  it("keeps valid text and drops an invalid sticker from an inbound filter", async (t) => {
    const db = openDatabase(redisUrl);
    t.after(() => db.close());
    await db.ping();
    await seedPersonas(db);
    const persona = (await getPersonaBySlug(db, "catgirl"))!;
    const botId = "bot_issue13_inbound_mixed_filter";
    const peerId = "issue13-inbound-mixed@im.wechat";
    await upsertBotAccount(db, {
      id: botId,
      ownerUserId: "u_test",
      displayName: "issue13",
      botToken: "test-token",
    });
    await approvePeer(db, botId, peerId);
    await setAssignment(db, botId, peerId, persona.id);
    await clearMessages(db, botId, peerId);

    const llm = new ScriptedLlm([
      "primary reply",
      '{"messages":["保留文字",{"type":"sticker","slug":"ghost"}]}',
    ]);
    const before = await getUsageDayStats(db);
    const requestsBefore = before.by_bot[botId]?.requests ?? 0;
    const chat = new ChatService(db, asLlm(llm), {
      allowUnapproved: false,
      memoryExtractEveryN: 999,
      replyFilterEnabled: true,
      stickersEnabled: false,
    });

    const result = await chat.handleInbound({
      botAccountId: botId,
      peerId,
      text: "请回答？",
      contextToken: "issue13-inbound-mixed-token",
    });

    assert.equal(result.kind, "reply");
    assert.deepEqual(result.parts, [{ kind: "text", text: "保留文字" }]);
    assert.equal(result.text, "保留文字");
    assert.equal(JSON.stringify(result).includes("ghost"), false);
    const history = await listRecentMessages(db, botId, peerId, 20);
    assert.equal(
      history.find((message) => message.role === "assistant")?.content,
      "保留文字",
    );
    const after = await getUsageDayStats(db);
    assert.equal((after.by_bot[botId]?.requests ?? 0) - requestsBefore, 2);
  });

  it("does not render a primary sticker-only wrapper when the filter is off", async (t) => {
    const db = openDatabase(redisUrl);
    t.after(() => db.close());
    await db.ping();
    await seedPersonas(db);
    const persona = (await getPersonaBySlug(db, "catgirl"))!;
    const botId = "bot_issue13_primary_wrapper_filter_off";
    const peerId = "issue13-primary-filter-off@im.wechat";
    await upsertBotAccount(db, {
      id: botId,
      ownerUserId: "u_test",
      displayName: "issue13",
      botToken: "test-token",
    });
    await approvePeer(db, botId, peerId);
    await setAssignment(db, botId, peerId, persona.id);
    await clearMessages(db, botId, peerId);

    const llm = new ScriptedLlm([
      '{"messages":[{"type":"sticker","slug":"ghost"}]}',
    ]);
    const before = await getUsageDayStats(db);
    const requestsBefore = before.by_bot[botId]?.requests ?? 0;
    const chat = new ChatService(db, asLlm(llm), {
      allowUnapproved: false,
      memoryExtractEveryN: 999,
      replyFilterEnabled: false,
      stickersEnabled: false,
    });

    const result = await chat.handleInbound({
      botAccountId: botId,
      peerId,
      text: "请回答？",
      contextToken: "issue13-primary-filter-off-token",
    });

    assert.equal(result.kind, "skip");
    assert.equal(result.skipReason, "empty_reply");
    assert.equal(llm.calls, 1, "primary LLM only");
    const history = await listRecentMessages(db, botId, peerId, 20);
    assert.equal(
      history.filter((message) => message.role === "assistant").length,
      0,
    );
    assert.equal(JSON.stringify(history).includes("ghost"), false);
    const after = await getUsageDayStats(db);
    assert.equal((after.by_bot[botId]?.requests ?? 0) - requestsBefore, 1);

    const finalized = await chat.finalizeReplyParts({
      rawLlmText: '{"messages":[{"type":"sticker","slug":"ghost"}]}',
      stickers: [],
      botAccountId: botId,
    });
    assert.deepEqual(finalized.parts, []);
    assert.deepEqual(finalized.bubbles, []);
    assert.equal(finalized.displayText, "");
  });
});

describe("ChatService adaptive reply finalization seam", () => {
  const params = (rawLlmText: string) => ({
    rawLlmText,
    stickers: [],
    botAccountId: "bot-adaptive",
    adaptive: true,
  });

  it("does not turn an empty filter envelope back into raw wrapper text", async () => {
    const emptyFilter = {
      async chat() {
        return '{"messages":[]}';
      },
      async chatWithUsage() {
        return {
          text: '{"messages":[]}',
          promptTokens: 0,
          completionTokens: 0,
          totalTokens: 0,
          model: "fake",
        };
      },
    } as unknown as LlmClient;
    const chat = new ChatService(
      noOpUsageDb(),
      emptyFilter,
      { replyFilterEnabled: true },
    );
    const result = await chat.finalizeReplyParts(
      params('{"messages":["ignored primary"]}'),
    );
    assert.deepEqual(result.parts, []);
    assert.equal(result.displayText, "");
  });

  it("keeps an adaptive empty-text envelope empty", async () => {
    const chat = new ChatService({} as never, asLlm(new FakeLlm("unused")), {
      replyFilterEnabled: false,
    });
    const result = await chat.finalizeReplyParts(
      params('{"messages":["   "]}'),
    );
    assert.deepEqual(result.parts, []);
    assert.equal(result.displayText, "");
  });

  it("truncates a valid five-part adaptive reply to four parts", async () => {
    const chat = new ChatService({} as never, asLlm(new FakeLlm("unused")), {
      replyFilterEnabled: false,
      maxReplyBubbles: 5,
    });
    const result = await chat.finalizeReplyParts(
      params('{"messages":["一","二","三","四","五"]}'),
    );
    assert.deepEqual(
      result.parts.map((part) => (part.kind === "text" ? part.text : part.slug)),
      ["一", "二", "三", "四"],
    );
  });

  it("keeps valid primary JSON parts when the reply filter fails", async () => {
    const failingFilter = {
      async chat() {
        throw new Error("filter unavailable");
      },
      async chatWithUsage() {
        throw new Error("filter unavailable");
      },
    } as unknown as LlmClient;
    const chat = new ChatService(noOpUsageDb(), failingFilter, {
      replyFilterEnabled: true,
    });
    const result = await chat.finalizeReplyParts(
      params('{"messages":["第一条","第二条"]}'),
    );
    assert.deepEqual(
      result.parts.map((part) => (part.kind === "text" ? part.text : part.slug)),
      ["第一条", "第二条"],
    );
  });

  it("drops an unknown sticker-only filter envelope without raw JSON fallback", async () => {
    const unknownStickerFilter = {
      async chat() {
        return '{"messages":[{"type":"sticker","slug":"ghost"}]}';
      },
      async chatWithUsage() {
        return {
          text: '{"messages":[{"type":"sticker","slug":"ghost"}]}',
          promptTokens: 0,
          completionTokens: 0,
          totalTokens: 0,
          model: "fake",
        };
      },
    } as unknown as LlmClient;
    const chat = new ChatService(noOpUsageDb(), unknownStickerFilter, {
      replyFilterEnabled: true,
    });
    const result = await chat.finalizeReplyParts(
      params('{"messages":["primary reply"]}'),
    );
    assert.deepEqual(result.parts, []);
    assert.equal(result.displayText, "");
    assert.equal(JSON.stringify(result).includes("ghost"), false);
  });
});

describe("ChatService adaptive reply public seam", () => {
  it("skips empty outputs without assistant history and truncates five parts", async (t) => {
    let db;
    try {
      db = openDatabase(redisUrl);
      await Promise.race([
        db.ping(),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("timeout")), 2500),
        ),
      ]);
    } catch {
      try {
        await db?.close();
      } catch {
        /* ignore */
      }
      t.skip("Redis not available");
      return;
    }

    await seedPersonas(db);
    const persona = (await getPersonaBySlug(db, "catgirl"))!;
    const botId = `bot_adaptive_public_${Date.now()}`;
    await upsertBotAccount(db, {
      id: botId,
      ownerUserId: "u_test",
      displayName: "test",
      botToken: "test-token",
    });
    const peers = ["empty-envelope", "empty-text", "five-parts"].map(
      (name) => `${name}_${Date.now()}@im.wechat`,
    );
    for (const peerId of peers) {
      await approvePeer(db, botId, peerId);
      await setAssignment(db, botId, peerId, persona.id);
    }

    const chat = new ChatService(
      db,
      asLlm(
        new FakeLlm([
          '{"messages":[]}',
          '{"messages":["   "]}',
          '{"messages":["一","二","三","四","五"]}',
        ]),
      ),
      {
        allowUnapproved: false,
        memoryExtractEveryN: 999,
        replyFilterEnabled: false,
        maxReplyBubbles: 5,
      },
    );
    const plan = {
      decision: "reply" as const,
      targetPartCount: 2 as const,
      coveredItemIds: ["m1"],
      reason: "reply-obligation" as const,
      skipBiasPercent: 10,
      items: [
        {
          id: "m1",
          kind: "new-question-or-request" as const,
          replyObligation: true,
        },
      ],
    };
    const results = [];
    for (const peerId of peers) {
      results.push(
        await chat.handleInbound({
          botAccountId: botId,
          peerId,
          text: "请回答？",
          contextToken: `token-${peerId}`,
          batchItems: [{ id: "m1", text: "请回答？", attachments: [] }],
          replyPlan: plan,
        }),
      );
    }

    assert.equal(results[0]!.kind, "skip");
    assert.equal(results[1]!.kind, "skip");
    assert.equal(results[2]!.kind, "reply");
    assert.equal(results[2]!.parts?.length, 4);
    for (const peerId of peers.slice(0, 2)) {
      const history = await listRecentMessages(db, botId, peerId, 20);
      assert.equal(
        history.filter((message) => message.role === "assistant").length,
        0,
      );
    }
    const fiveHistory = await listRecentMessages(db, botId, peers[2]!, 20);
    assert.equal(
      fiveHistory.filter((message) => message.role === "assistant").length,
      1,
    );
    await db.close();
  });

  it("preserves valid primary fallback and never stores unknown sticker JSON", async (t) => {
    let db;
    try {
      db = openDatabase(redisUrl);
      await Promise.race([
        db.ping(),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("timeout")), 2500),
        ),
      ]);
    } catch {
      try {
        await db?.close();
      } catch {
        /* ignore */
      }
      t.skip("Redis not available");
      return;
    }

    await seedPersonas(db);
    const persona = (await getPersonaBySlug(db, "catgirl"))!;
    const botId = `bot_adaptive_filter_${Date.now()}`;
    await upsertBotAccount(db, {
      id: botId,
      ownerUserId: "u_test",
      displayName: "test",
      botToken: "test-token",
    });
    const fallbackPeer = `fallback_${Date.now()}@im.wechat`;
    const stickerPeer = `sticker_${Date.now()}@im.wechat`;
    for (const peerId of [fallbackPeer, stickerPeer]) {
      await approvePeer(db, botId, peerId);
      await setAssignment(db, botId, peerId, persona.id);
    }

    let call = 0;
    const scripted = {
      async chat() {
        throw new Error("unexpected chat call");
      },
      async chatWithUsage() {
        call++;
        if (call === 1) {
          return {
            text: '{"messages":["第一条","第二条"]}',
            promptTokens: 1,
            completionTokens: 1,
            totalTokens: 2,
            model: "fake",
          };
        }
        if (call === 2) throw new Error("filter unavailable");
        if (call === 3) {
          return {
            text: '{"messages":["primary reply"]}',
            promptTokens: 1,
            completionTokens: 1,
            totalTokens: 2,
            model: "fake",
          };
        }
        return {
          text: '{"messages":[{"type":"sticker","slug":"ghost"}]}',
          promptTokens: 0,
          completionTokens: 0,
          totalTokens: 0,
          model: "fake",
        };
      },
    } as unknown as LlmClient;
    const chat = new ChatService(db, scripted, {
      allowUnapproved: false,
      memoryExtractEveryN: 999,
      replyFilterEnabled: true,
      stickersEnabled: false,
    });
    const plan = {
      decision: "reply" as const,
      targetPartCount: 2 as const,
      coveredItemIds: ["m1"],
      reason: "reply-obligation" as const,
      skipBiasPercent: 10,
      items: [
        {
          id: "m1",
          kind: "new-question-or-request" as const,
          replyObligation: true,
        },
      ],
    };
    const request = (peerId: string) => ({
      botAccountId: botId,
      peerId,
      text: "请回答？",
      contextToken: `token-${peerId}`,
      batchItems: [{ id: "m1", text: "请回答？", attachments: [] }],
      replyPlan: plan,
    });

    const fallbackResult = await chat.handleInbound(request(fallbackPeer));
    const stickerResult = await chat.handleInbound(request(stickerPeer));
    assert.equal(fallbackResult.kind, "reply");
    assert.deepEqual(
      fallbackResult.parts?.map((part) =>
        part.kind === "text" ? part.text : part.slug,
      ),
      ["第一条", "第二条"],
    );
    assert.equal(stickerResult.kind, "skip");

    const fallbackHistory = await listRecentMessages(
      db,
      botId,
      fallbackPeer,
      20,
    );
    assert.equal(
      fallbackHistory.filter((message) => message.role === "assistant").length,
      1,
    );
    const stickerHistory = await listRecentMessages(db, botId, stickerPeer, 20);
    assert.equal(
      stickerHistory.filter((message) => message.role === "assistant").length,
      0,
    );
    assert.equal(JSON.stringify(stickerHistory).includes("ghost"), false);
    await db.close();
  });
});
