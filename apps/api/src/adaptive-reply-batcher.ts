import type { PromptAttachment } from "@wechat-ai/core";

export interface BatchClock {
  now(): number;
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

const SYSTEM_CLOCK: BatchClock = {
  now: () => Date.now(),
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export interface AdaptiveReplyBatchItem {
  id: string;
  botId: string;
  peerId: string;
  contextToken: string;
  text: string;
  attachments: PromptAttachment[];
  /** Worker-owned data carried through unchanged; never logged by the batcher. */
  payload?: unknown;
}

export interface AdaptiveReplyBatch {
  id: string;
  botId: string;
  peerId: string;
  contextToken: string;
  openedAtMs: number;
  closedAtMs: number;
  items: AdaptiveReplyBatchItem[];
}

export interface AdaptiveReplyBatcherOptions {
  silenceMs?: number;
  maxWaitMs?: number;
  clock?: BatchClock;
  onClose: (batch: AdaptiveReplyBatch) => Promise<void> | void;
  onError?: (error: unknown, batch: AdaptiveReplyBatch) => void;
  drainTimeoutMs?: number;
}

interface OpenBatch {
  id: string;
  botId: string;
  peerId: string;
  openedAtMs: number;
  lastItemAtMs: number;
  items: AdaptiveReplyBatchItem[];
  timer: unknown;
}

/** Groups ordinary inbound chat turns by bot and peer before reply planning. */
export class AdaptiveReplyBatcher {
  private readonly clock: BatchClock;
  private readonly onClose: AdaptiveReplyBatcherOptions["onClose"];
  private readonly onError: AdaptiveReplyBatcherOptions["onError"];
  private silenceMs: number;
  private maxWaitMs: number;
  private readonly drainTimeoutMs: number;
  private sequence = 0;
  private open = new Map<string, OpenBatch>();
  private deliveries = new Set<Promise<void>>();
  private stopped = false;

  constructor(options: AdaptiveReplyBatcherOptions) {
    this.clock = options.clock ?? SYSTEM_CLOCK;
    this.onClose = options.onClose;
    this.onError = options.onError;
    this.silenceMs = positiveMs(options.silenceMs, 10_000);
    this.maxWaitMs = positiveMs(options.maxWaitMs, 20_000);
    this.drainTimeoutMs = positiveMs(options.drainTimeoutMs, 5_000);
  }

  applyRuntimeOptions(options: {
    silenceMs?: number;
    maxWaitMs?: number;
  }): void {
    if (options.silenceMs !== undefined) {
      this.silenceMs = positiveMs(options.silenceMs, 10_000);
    }
    if (options.maxWaitMs !== undefined) {
      this.maxWaitMs = positiveMs(options.maxWaitMs, 20_000);
    }
    for (const [key, batch] of this.open) this.arm(key, batch);
  }

  add(item: AdaptiveReplyBatchItem): void {
    if (this.stopped) return;
    const key = batchKey(item.botId, item.peerId);
    const now = this.clock.now();
    let batch = this.open.get(key);
    if (!batch) {
      batch = {
        id: `batch_${(++this.sequence).toString(36)}`,
        botId: item.botId,
        peerId: item.peerId,
        openedAtMs: now,
        lastItemAtMs: now,
        items: [],
        timer: undefined,
      };
      this.open.set(key, batch);
    }
    batch.items.push(item);
    batch.lastItemAtMs = now;
    this.arm(key, batch);
  }

  start(): void {
    this.stopped = false;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    for (const [key, batch] of [...this.open]) {
      this.close(key, batch);
    }
    await Promise.all([...this.deliveries]);
  }

  private arm(key: string, batch: OpenBatch): void {
    if (batch.timer !== undefined) this.clock.clearTimeout(batch.timer);
    const closeAt = Math.min(
      batch.lastItemAtMs + this.silenceMs,
      batch.openedAtMs + this.maxWaitMs,
    );
    batch.timer = this.clock.setTimeout(
      () => this.close(key, batch),
      Math.max(0, closeAt - this.clock.now()),
    );
  }

  private close(key: string, expected: OpenBatch): void {
    if (this.open.get(key) !== expected) return;
    this.open.delete(key);
    if (expected.timer !== undefined) this.clock.clearTimeout(expected.timer);
    const newest = expected.items.at(-1)!;
    const closed: AdaptiveReplyBatch = {
      id: expected.id,
      botId: expected.botId,
      peerId: expected.peerId,
      contextToken: newest.contextToken,
      openedAtMs: expected.openedAtMs,
      closedAtMs: this.clock.now(),
      items: expected.items,
    };
    let callback: Promise<void>;
    try {
      callback = Promise.resolve(this.onClose(closed));
    } catch (error) {
      this.onError?.(error, closed);
      return;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<void>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`batch drain timed out after ${this.drainTimeoutMs}ms`)),
        this.drainTimeoutMs,
      );
      timer.unref?.();
    });
    const delivery = Promise.race([callback, timeout])
      .catch((error) => {
        this.onError?.(error, closed);
      })
      .finally(() => {
        if (timer) clearTimeout(timer);
        this.deliveries.delete(delivery);
      });
    this.deliveries.add(delivery);
  }
}

function positiveMs(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && value! > 0 ? Math.floor(value!) : fallback;
}

function batchKey(botId: string, peerId: string): string {
  return `${botId.length}:${botId}${peerId}`;
}
