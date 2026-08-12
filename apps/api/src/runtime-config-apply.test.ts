import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ChatService } from "@wechat-ai/core";
import { loadConfig } from "./config.js";
import {
  applyRuntimeConfigToServices,
  type RuntimeConfigTargets,
} from "./runtime-config-apply.js";

describe("runtime quality settings application", () => {
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
});
