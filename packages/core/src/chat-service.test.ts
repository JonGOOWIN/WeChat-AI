import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  approvePeer,
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

function asLlm(fake: FakeLlm): LlmClient {
  return fake as unknown as LlmClient;
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
      {} as never,
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
    const chat = new ChatService({} as never, failingFilter, {
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
    const chat = new ChatService({} as never, unknownStickerFilter, {
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
