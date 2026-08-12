import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  inspectConversationQuality,
  planConversationQuality,
  resolveConversationQualitySettings,
  summarizeConversationQualityPlan,
} from "./conversation-quality.js";

const settings = resolveConversationQualitySettings({
  coveragePercent: 100,
  followUpPercent: 0,
  lengthWeights: [0, 100, 0],
  repetitionWindowAssistantTurns: 0,
});

describe("conversation question intent", () => {
  it("distinguishes Chinese statements from explicit direct questions", () => {
    const cases = [
      ["我不知道該說什麼", false],
      ["沒什麼。", false],
      ["就這麼做", false],
      ["你在做什麼", true],
      ["你在干嘛", true],
      ["在嗎", true],
    ] as const;

    for (const [text, expectedProtected] of cases) {
      const plan = planConversationQuality({
        stableTurnKey: text,
        topics: [{ id: "turn", text }],
        settings,
      });
      assert.equal(
        plan.protectedTopicIds.includes("turn"),
        expectedProtected,
        text,
      );
    }
  });

  it("ignores URL queries for supported URL forms without swallowing real questions", () => {
    const plan = planConversationQuality({
      stableTurnKey: "url-question-check",
      topics: [],
      settings,
    });
    const cases = [
      ["請看 https://example.com/s?wd=test", false],
      ["請看 www.example.com/s?wd=test", false],
      ["請看 example.com/a?b=1", false],
      ["真的?", true],
      ["example.com/a?b=1 真的?", true],
      ["www.example.com/s?wd=test真的?", true],
    ] as const;

    for (const [visibleText, expectedFollowUpViolation] of cases) {
      const violations = inspectConversationQuality({
        visibleText,
        plan,
        recentAssistantTexts: [],
      });
      assert.equal(
        violations.includes("follow-up"),
        expectedFollowUpViolation,
        visibleText,
      );
    }
  });
});

describe("conversation quality runtime summary", () => {
  it("exposes the selected profile and reason codes without turn content or identifiers", () => {
    const plan = planConversationQuality({
      stableTurnKey: "secret-peer-and-turn",
      topics: [{ id: "private-topic-id", text: "請幫我確認時間？" }],
      settings,
    });
    const summary = summarizeConversationQualityPlan(plan);

    assert.deepEqual(summary.profile, {
      coveragePercent: 100,
      followUpPercent: 0,
      lengthWeights: [0, 100, 0],
      emotionContinuityTurns: 4,
      repetitionWindowAssistantTurns: 0,
    });
    assert.deepEqual(summary.reasonCodes, [
      "protected-obligation",
      "coverage-complete",
      "follow-up-not-selected",
      "length-normal",
    ]);
    assert.doesNotMatch(JSON.stringify(summary), /secret-peer|private-topic/);
  });
});
