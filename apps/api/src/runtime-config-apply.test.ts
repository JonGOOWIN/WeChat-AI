import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ChatService, TryChatService } from "@wechat-ai/core";
import { loadConfig } from "./config.js";
import {
  applyRuntimeConfigToServices,
  type RuntimeConfigTargets,
} from "./runtime-config-apply.js";

describe("runtime quality settings application", () => {
  it("hot-applies batching controls to the active worker", () => {
    const patches: Array<Record<string, unknown>> = [];
    const cfg = loadConfig({
      REPLY_BATCH_ENABLED: "false",
      REPLY_BATCH_SILENCE_MS: "3000",
      REPLY_BATCH_MAX_WAIT_MS: "9000",
      REPLY_SKIP_BIAS_PERCENT: "25",
      REPLY_COUNT_WEIGHTS: "40,30,20,10",
    } as NodeJS.ProcessEnv);
    const targets = {
      chat: { applyRuntimeOptions() {} },
      tryChat: { applyRuntimeOptions() {} },
      worker: { applyRuntimeConfig: (patch: Record<string, unknown>) => patches.push(patch) },
      activityBus: { applyRuntimeOptions() {} },
    } as unknown as RuntimeConfigTargets;

    applyRuntimeConfigToServices(new Set(["replyBatchEnabled"]), cfg, targets);

    assert.equal(patches[0]?.replyBatchEnabled, false);
    assert.equal(patches[0]?.replyBatchSilenceMs, 3000);
    assert.equal(patches[0]?.replyBatchMaxWaitMs, 9000);
    assert.equal(patches[0]?.replySkipBiasPercent, 25);
    assert.deepEqual(patches[0]?.replyCountWeights, [40, 30, 20, 10]);
  });

  it("hot-applies the effective global quality settings to ChatService", () => {
    const patches: Array<Parameters<ChatService["applyRuntimeOptions"]>[0]> = [];
    const cfg = loadConfig({
      REPLY_COVERAGE_PERCENT: "44",
      REPLY_FOLLOW_UP_PERCENT: "11",
      REPLY_LENGTH_WEIGHT_SHORT: "10",
      REPLY_LENGTH_WEIGHT_NORMAL: "20",
      REPLY_LENGTH_WEIGHT_LONG: "70",
      EMOTION_CONTINUITY_TURNS: "5",
      REPETITION_WINDOW_ASSISTANT_TURNS: "16",
    } as NodeJS.ProcessEnv);
    const targets = {
      chat: { applyRuntimeOptions: (patch: (typeof patches)[number]) => patches.push(patch) },
      tryChat: { applyRuntimeOptions() {} },
      worker: { applyRuntimeConfig() {} },
      activityBus: { applyRuntimeOptions() {} },
    } as unknown as RuntimeConfigTargets;

    applyRuntimeConfigToServices(
      new Set(["replyCoveragePercent"]),
      cfg,
      targets,
    );

    assert.deepEqual(patches[0]?.conversationQuality, {
      coveragePercent: 44,
      followUpPercent: 11,
      lengthWeights: [10, 20, 70],
      emotionContinuityTurns: 5,
      repetitionWindowAssistantTurns: 16,
    });
  });

  it("hot-applies the same global quality settings to try-chat", () => {
    const patches: Array<Parameters<TryChatService["applyRuntimeOptions"]>[0]> = [];
    const cfg = loadConfig({ REPLY_COVERAGE_PERCENT: "46" } as NodeJS.ProcessEnv);
    const targets = {
      chat: { applyRuntimeOptions() {} },
      tryChat: { applyRuntimeOptions: (patch: (typeof patches)[number]) => patches.push(patch) },
      worker: { applyRuntimeConfig() {} },
      activityBus: { applyRuntimeOptions() {} },
    } as unknown as RuntimeConfigTargets;

    applyRuntimeConfigToServices(new Set(["replyCoveragePercent"]), cfg, targets);

    assert.equal(patches.length, 1);
    assert.equal(patches[0]?.conversationQuality?.coveragePercent, 46);
  });
});
