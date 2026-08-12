import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ChatService } from "@wechat-ai/core";
import type { Db } from "@wechat-ai/db";
import type { ILinkClient, WeixinMessage } from "@wechat-ai/ilink";
import { BotWorkerManager } from "./worker.js";
import type { BatchClock } from "./adaptive-reply-batcher.js";
import { initActivityBus, type StreamEvent } from "./activity-stream.js";

class FakeClock implements BatchClock {
  private current = 0;
  private id = 0;
  private timers = new Map<number, { at: number; callback: () => void }>();
  now(): number {
    return this.current;
  }
  setTimeout(callback: () => void, delayMs: number): number {
    const id = ++this.id;
    this.timers.set(id, { at: this.current + delayMs, callback });
    return id;
  }
  clearTimeout(handle: unknown): void {
    this.timers.delete(handle as number);
  }
  async advance(ms: number): Promise<void> {
    const target = this.current + ms;
    while (true) {
      const due = [...this.timers.entries()]
        .filter(([, timer]) => timer.at <= target)
        .sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      this.current = due[1].at;
      this.timers.delete(due[0]);
      due[1].callback();
      await Promise.resolve();
    }
    this.current = target;
    await Promise.resolve();
  }
}

function inbound(text: string, token: string, at: number): WeixinMessage {
  return {
    message_type: 1,
    from_user_id: "peer-a",
    context_token: token,
    create_time_ms: at,
    item_list: [{ type: 1, text_item: { text } }],
  };
}

describe("BotWorkerManager adaptive reply seam", () => {
  it("hot-disables aggregation so the next ordinary message is ready immediately", async () => {
    const clock = new FakeClock();
    const conversations: Array<Record<string, unknown>> = [];
    const worker = new BotWorkerManager({
      db: { redis: { set: async () => "OK" } } as unknown as Db,
      chat: {
        async handleInbound(request: Record<string, unknown>) {
          conversations.push(request);
          return { kind: "reply" as const, text: "收到" };
        },
      } as unknown as ChatService,
      p2pEnabled: false,
      replyBatchClock: clock,
    });
    const client = {
      async startTyping() {},
      async stopTyping() {},
      async sendText() {},
    } as unknown as ILinkClient;

    worker.applyRuntimeConfig({ replyBatchEnabled: false });
    await worker.acceptInboundMessage(
      "bot-a",
      client,
      inbound("现在回复", "token", 1),
    );

    assert.equal(await worker.processNextReply(), true);
    assert.equal(conversations.length, 1);
    assert.deepEqual(
      (conversations[0]?.batchItems as Array<{ text: string }>).map(
        (item) => item.text,
      ),
      ["现在回复"],
    );
  });

  it("flushes the older pending batch before hot-disabling aggregation", async () => {
    const clock = new FakeClock();
    const conversations: string[][] = [];
    const worker = new BotWorkerManager({
      db: { redis: { set: async () => "OK" } } as unknown as Db,
      chat: {
        async handleInbound(request: Record<string, unknown>) {
          conversations.push(
            (request.batchItems as Array<{ text: string }>).map((item) => item.text),
          );
          return { kind: "reply" as const, text: "收到" };
        },
      } as unknown as ChatService,
      p2pEnabled: false,
      replyBatchClock: clock,
    });
    const client = {
      async startTyping() {},
      async stopTyping() {},
      async sendText() {},
    } as unknown as ILinkClient;

    await worker.acceptInboundMessage("bot-a", client, inbound("较早", "old", 1));
    worker.applyRuntimeConfig({ replyBatchEnabled: false });
    await worker.acceptInboundMessage("bot-a", client, inbound("较新", "new", 2));

    assert.equal(await worker.processNextReply(), true);
    assert.equal(await worker.processNextReply(), true);
    assert.deepEqual(conversations, [["较早"], ["较新"]]);
  });

  it("turns same-peer inbound events into one conversation and ordered sends", async (t) => {
    const clock = new FakeClock();
    const conversations: Array<Record<string, unknown>> = [];
    const events: Array<{ type: string; token: string; text?: string }> = [];
    const db = {
      redis: {
        async set(): Promise<string> {
          return "OK";
        },
      },
    } as unknown as Db;
    const activity = initActivityBus({ db, enabled: true });
    t.after(() => activity.stop());
    const activityEvents: StreamEvent[] = [];
    activity.subscribe((event) => activityEvents.push(event));
    const chat = {
      async handleInbound(request: Record<string, unknown>) {
        conversations.push(request);
        return {
          kind: "reply" as const,
          parts: [
            { kind: "text" as const, text: "第一条" },
            { kind: "text" as const, text: "第二条" },
          ],
          qualityPlan: {
            coveredTopicIds: ["quality-covered"],
            omittedTopicIds: ["quality-omitted"],
          },
        };
      },
    } as unknown as ChatService;
    const client = {
      async startTyping(input: { contextToken: string }) {
        events.push({ type: "typing-start", token: input.contextToken });
      },
      async stopTyping(input: { contextToken: string }) {
        events.push({ type: "typing-stop", token: input.contextToken });
      },
      async sendText(input: { contextToken: string; text: string }) {
        events.push({
          type: "send",
          token: input.contextToken,
          text: input.text,
        });
      },
    } as unknown as ILinkClient;
    const worker = new BotWorkerManager({
      db,
      chat,
      p2pEnabled: false,
      splitReply: true,
      replyDelay: {
        msPerChar: 0,
        minMs: 0,
        maxMs: 0,
        firstMinMs: 0,
        firstMaxMs: 0,
        thinkExtraMs: 0,
      },
      replyBatchClock: clock,
      replyCountSelector: { select: () => 1 },
    });

    await worker.acceptInboundMessage(
      "bot-a",
      client,
      inbound("我想问", "old-token", 1),
    );
    await clock.advance(6_000);
    await worker.acceptInboundMessage(
      "bot-a",
      client,
      inbound("明天几点出发？", "new-token", 2),
    );
    await clock.advance(9_999);
    assert.deepEqual(events, [], "typing must not start before batch closure");
    assert.equal(conversations.length, 0);

    await clock.advance(1);
    assert.equal(await worker.processNextReply(), true);

    assert.equal(conversations.length, 1);
    const request = conversations[0]!;
    assert.equal(request.contextToken, "new-token");
    assert.deepEqual(
      (request.batchItems as Array<{ text: string }>).map((item) => item.text),
      ["我想问", "明天几点出发？"],
    );
    assert.deepEqual(events, [
      { type: "typing-start", token: "new-token" },
      { type: "typing-start", token: "new-token" },
      { type: "send", token: "new-token", text: "第一条" },
      { type: "typing-start", token: "new-token" },
      { type: "send", token: "new-token", text: "第二条" },
      { type: "typing-stop", token: "new-token" },
    ]);
    for (const type of ["message.out", "llm.usage"]) {
      const event = activityEvents.find((candidate) => candidate.type === type);
      assert.deepEqual(event?.data?.coveredItemIds, ["quality-covered"]);
      assert.deepEqual(event?.data?.omittedTopicIds, ["quality-omitted"]);
    }
    assert.equal(await worker.processNextReply(), false);
  });

  it("skips a filler-only batch without conversation, typing start or sends", async () => {
    const clock = new FakeClock();
    let conversations = 0;
    const events: string[] = [];
    const worker = new BotWorkerManager({
      db: {
        redis: { set: async () => "OK" },
      } as unknown as Db,
      chat: {
        async handleInbound() {
          conversations++;
          return { kind: "reply" as const, text: "不该调用" };
        },
      } as unknown as ChatService,
      p2pEnabled: false,
      replyBatchClock: clock,
    });
    const client = {
      async startTyping() {
        events.push("typing-start");
      },
      async stopTyping() {
        events.push("typing-stop");
      },
      async sendText() {
        events.push("send");
      },
    } as unknown as ILinkClient;

    await worker.acceptInboundMessage(
      "bot-a",
      client,
      inbound("哈哈", "token", 1),
    );
    await clock.advance(10_000);
    assert.equal(await worker.processNextReply(), true);

    assert.equal(conversations, 0);
    assert.equal(events.includes("typing-start"), false);
    assert.equal(events.includes("send"), false);
  });

  it("fails closed when conversation returns more than four parts", async () => {
    const clock = new FakeClock();
    const events: string[] = [];
    const worker = new BotWorkerManager({
      db: {
        redis: { set: async () => "OK" },
      } as unknown as Db,
      chat: {
        async handleInbound() {
          return {
            kind: "reply" as const,
            parts: Array.from({ length: 5 }, (_, index) => ({
              kind: "text" as const,
              text: `part-${index + 1}`,
            })),
          };
        },
      } as unknown as ChatService,
      p2pEnabled: false,
      replyBatchClock: clock,
    });
    const client = {
      async startTyping() {
        events.push("typing-start");
      },
      async stopTyping() {
        events.push("typing-stop");
      },
      async sendText() {
        events.push("send");
      },
    } as unknown as ILinkClient;

    await worker.acceptInboundMessage(
      "bot-a",
      client,
      inbound("请回答这个问题？", "token", 1),
    );
    await clock.advance(10_000);
    assert.equal(await worker.processNextReply(), true);

    assert.equal(events.filter((event) => event === "send").length, 0);
    assert.equal(events.at(-1), "typing-stop");
  });

  it("keeps per-message rate-limit rejection outside batching", async () => {
    const clock = new FakeClock();
    let conversations = 0;
    const sent: string[] = [];
    const worker = new BotWorkerManager({
      db: {
        redis: { set: async () => "OK" },
      } as unknown as Db,
      chat: {
        async handleInbound() {
          conversations++;
          return { kind: "reply" as const, text: "AI" };
        },
      } as unknown as ChatService,
      p2pEnabled: false,
      peerRatePerMinute: 1,
      replyBatchClock: clock,
    });
    const client = {
      async startTyping() {},
      async stopTyping() {},
      async sendText(input: { text: string }) {
        sent.push(input.text);
      },
    } as unknown as ILinkClient;

    await worker.acceptInboundMessage(
      "bot-a",
      client,
      inbound("第一个问题？", "token-1", 1),
    );
    await worker.acceptInboundMessage(
      "bot-a",
      client,
      inbound("第二个问题？", "token-2", 2),
    );

    assert.equal(await worker.processNextReply(), true);
    assert.equal(conversations, 0);
    assert.deepEqual(sent, ["你发得太快啦，请稍等一会儿再聊～"]);
  });

  it("keeps system approval rejection outside batching", async () => {
    const clock = new FakeClock();
    const sent: string[] = [];
    const worker = new BotWorkerManager({
      db: {
        redis: { set: async () => "OK" },
      } as unknown as Db,
      chat: {
        async preflightInbound() {
          return { kind: "reject" as const, text: "尚未批准" };
        },
        async handleInbound() {
          throw new Error("preflight rejection must not reach conversation");
        },
      } as unknown as ChatService,
      p2pEnabled: false,
      replyBatchClock: clock,
    });
    const client = {
      async startTyping() {},
      async stopTyping() {},
      async sendText(input: { text: string }) {
        sent.push(input.text);
      },
    } as unknown as ILinkClient;

    await worker.acceptInboundMessage(
      "bot-a",
      client,
      inbound("你好", "token", 1),
    );

    assert.equal(await worker.processNextReply(), true);
    assert.deepEqual(sent, ["尚未批准"]);
  });

  it("clears typing when an immediate preflight job is dropped by a full inbox", async () => {
    const clock = new FakeClock();
    let starts = 0;
    let stops = 0;
    const worker = new BotWorkerManager({
      db: {
        redis: { set: async () => "OK" },
      } as unknown as Db,
      chat: {
        async preflightInbound() {
          return { kind: "reject" as const, text: "尚未批准" };
        },
      } as unknown as ChatService,
      p2pEnabled: false,
      peerRatePerMinute: 1_000,
      inboxMaxLen: 100,
      replyBatchClock: clock,
    });
    const client = {
      async startTyping() {
        starts++;
      },
      async stopTyping() {
        stops++;
      },
    } as unknown as ILinkClient;

    for (let index = 0; index < 101; index++) {
      await worker.acceptInboundMessage(
        "bot-a",
        client,
        inbound(`消息-${index}`, `token-${index}`, index + 1),
      );
    }

    assert.equal(
      starts - stops,
      100,
      "only the 100 queued jobs may leave typing active",
    );
  });
});
