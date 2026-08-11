import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  AdaptiveReplyBatcher,
  type AdaptiveReplyBatch,
  type BatchClock,
} from "./adaptive-reply-batcher.js";

class FakeClock implements BatchClock {
  private nowMs = 0;
  private nextId = 1;
  private timers = new Map<number, { at: number; callback: () => void }>();

  now(): number {
    return this.nowMs;
  }

  setTimeout(callback: () => void, delayMs: number): number {
    const id = this.nextId++;
    this.timers.set(id, { at: this.nowMs + delayMs, callback });
    return id;
  }

  clearTimeout(id: unknown): void {
    this.timers.delete(id as number);
  }

  async advance(ms: number): Promise<void> {
    const target = this.nowMs + ms;
    while (true) {
      const due = [...this.timers.entries()]
        .filter(([, timer]) => timer.at <= target)
        .sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
      if (!due) break;
      this.nowMs = due[1].at;
      this.timers.delete(due[0]);
      due[1].callback();
      await Promise.resolve();
    }
    this.nowMs = target;
    await Promise.resolve();
  }

  fireDueSynchronously(ms: number): void {
    this.nowMs += ms;
    const due = [...this.timers.entries()]
      .filter(([, timer]) => timer.at <= this.nowMs)
      .sort((a, b) => a[1].at - b[1].at || a[0] - b[0]);
    for (const [id, timer] of due) {
      this.timers.delete(id);
      timer.callback();
    }
  }
}

describe("AdaptiveReplyBatcher", () => {
  it("closes one ordered batch after silence with the newest context token", async () => {
    const clock = new FakeClock();
    const closed: AdaptiveReplyBatch[] = [];
    const batcher = new AdaptiveReplyBatcher({
      silenceMs: 10_000,
      maxWaitMs: 20_000,
      clock,
      onClose: async (batch) => {
        closed.push(batch);
      },
    });

    batcher.add({
      id: "m1",
      botId: "bot-a",
      peerId: "peer-a",
      contextToken: "token-old",
      text: "我想问",
      attachments: [{ kind: "image", fileName: "first.png" }],
    });
    await clock.advance(6_000);
    batcher.add({
      id: "m2",
      botId: "bot-a",
      peerId: "peer-a",
      contextToken: "token-new",
      text: "明天几点出发？",
      attachments: [],
    });

    await clock.advance(9_999);
    assert.equal(closed.length, 0);
    await clock.advance(1);

    assert.equal(closed.length, 1);
    assert.equal(closed[0]!.contextToken, "token-new");
    assert.deepEqual(
      closed[0]!.items.map((item) => ({
        id: item.id,
        text: item.text,
        attachments: item.attachments,
      })),
      [
        {
          id: "m1",
          text: "我想问",
          attachments: [{ kind: "image", fileName: "first.png" }],
        },
        { id: "m2", text: "明天几点出发？", attachments: [] },
      ],
    );

    await clock.advance(20_000);
    assert.equal(closed.length, 1, "a closed batch must not fire twice");
  });

  it("hot-applies timing to an already open batch", async () => {
    const clock = new FakeClock();
    const closed: AdaptiveReplyBatch[] = [];
    const batcher = new AdaptiveReplyBatcher({
      silenceMs: 10_000,
      maxWaitMs: 20_000,
      clock,
      onClose: (batch) => {
        closed.push(batch);
      },
    });
    batcher.add({
      id: "m1",
      botId: "bot-a",
      peerId: "peer-a",
      contextToken: "token",
      text: "在吗？",
      attachments: [],
    });
    await clock.advance(1_000);

    batcher.applyRuntimeOptions({ silenceMs: 2_000, maxWaitMs: 5_000 });
    await clock.advance(999);
    assert.equal(closed.length, 0);
    await clock.advance(1);
    assert.equal(closed.length, 1);
  });

  it("flushes a quiet pending batch exactly once on stop", async () => {
    const clock = new FakeClock();
    const closed: AdaptiveReplyBatch[] = [];
    const batcher = new AdaptiveReplyBatcher({
      clock,
      onClose: (batch) => {
        closed.push(batch);
      },
    });
    batcher.add({
      id: "m1",
      botId: "bot-a",
      peerId: "peer-a",
      contextToken: "token",
      text: "还在吗？",
      attachments: [],
    });

    await batcher.stop();
    await clock.advance(30_000);

    assert.equal(closed.length, 1);
    assert.deepEqual(closed[0]!.items.map((item) => item.id), ["m1"]);
  });

  it("delivers a timer-close callback even when stop follows before a microtask", async () => {
    const clock = new FakeClock();
    let delivered = 0;
    let workerStopped = false;
    const batcher = new AdaptiveReplyBatcher({
      silenceMs: 1,
      clock,
      onClose: () => {
        if (!workerStopped) delivered++;
      },
    });
    batcher.add({
      id: "m1",
      botId: "bot-a",
      peerId: "peer-a",
      contextToken: "token",
      text: "问题？",
      attachments: [],
    });

    clock.fireDueSynchronously(1);
    workerStopped = true;
    const stopping = batcher.stop();
    await stopping;

    assert.equal(delivered, 1);
  });

  it("honours the hard deadline despite continued arrivals", async () => {
    const clock = new FakeClock();
    const closed: AdaptiveReplyBatch[] = [];
    const batcher = new AdaptiveReplyBatcher({
      clock,
      onClose: (batch) => {
        closed.push(batch);
      },
    });
    const add = (id: string) =>
      batcher.add({
        id,
        botId: "bot-a",
        peerId: "peer-a",
        contextToken: id,
        text: id,
        attachments: [],
      });
    add("m1");
    await clock.advance(9_000);
    add("m2");
    await clock.advance(9_000);
    add("m3");
    await clock.advance(1_999);
    assert.equal(closed.length, 0);
    await clock.advance(1);
    assert.deepEqual(closed[0]!.items.map((item) => item.id), ["m1", "m2", "m3"]);
    assert.equal(closed[0]!.closedAtMs, 20_000);
  });

  it("isolates timers and content across every bot-peer key", async () => {
    const clock = new FakeClock();
    const closed: AdaptiveReplyBatch[] = [];
    const batcher = new AdaptiveReplyBatcher({
      clock,
      onClose: (batch) => {
        closed.push(batch);
      },
    });
    for (const [id, botId, peerId] of [
      ["a", "bot-1", "peer-1"],
      ["b", "bot-1", "peer-2"],
      ["c", "bot-2", "peer-1"],
    ] as const) {
      batcher.add({
        id,
        botId,
        peerId,
        contextToken: `token-${id}`,
        text: id,
        attachments: [],
      });
    }
    await clock.advance(10_000);
    assert.deepEqual(
      closed
        .map((batch) => `${batch.botId}/${batch.peerId}:${batch.items[0]!.id}`)
        .sort(),
      ["bot-1/peer-1:a", "bot-1/peer-2:b", "bot-2/peer-1:c"],
    );
  });

  it("reports a synchronous close failure once without reopening the batch", async () => {
    const clock = new FakeClock();
    const errors: unknown[] = [];
    const batcher = new AdaptiveReplyBatcher({
      clock,
      onClose: () => {
        throw new Error("conversation failed");
      },
      onError: (error) => errors.push(error),
    });
    batcher.add({
      id: "m1",
      botId: "bot-a",
      peerId: "peer-a",
      contextToken: "token",
      text: "问题？",
      attachments: [],
    });

    await clock.advance(10_000);
    await clock.advance(20_000);

    assert.equal(errors.length, 1);
    assert.match(String(errors[0]), /conversation failed/);
  });

  it("accepts fresh batches after an explicit restart", async () => {
    const clock = new FakeClock();
    const ids: string[] = [];
    const batcher = new AdaptiveReplyBatcher({
      clock,
      onClose: (batch) => {
        ids.push(batch.id);
      },
    });
    batcher.stop();
    batcher.start();
    batcher.add({
      id: "m1",
      botId: "bot-a",
      peerId: "peer-a",
      contextToken: "token",
      text: "重启后的问题？",
      attachments: [],
    });
    await clock.advance(10_000);
    assert.equal(ids.length, 1);
  });
});
