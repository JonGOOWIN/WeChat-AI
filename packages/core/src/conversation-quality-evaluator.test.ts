import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { planConversationQuality } from "./conversation-quality.js";
import { evaluateConversationQualityFixture } from "./conversation-quality-evaluator.js";

describe("offline conversation quality evaluation", () => {
  it("measures all five fixture signals through one public API", () => {
    const report = evaluateConversationQualityFixture({
      id: "sad-follow-up",
      obligationTopicIds: ["schedule", "feeling"],
      coveredTopicIds: ["feeling"],
      replyText: "聽起來你今天真的很委屈，我陪著你，好嗎？",
      expectedEmotion: "sad",
      replyEmotion: "sad",
      recentAssistantTexts: ["早點休息，我一直都會陪著你。"],
    });

    assert.deepEqual(report, {
      fixtureId: "sad-follow-up",
      replyObligationCoverage: 0.5,
      followUpPresent: true,
      visibleLength: 20,
      visibleLengthBucket: "short",
      emotionalContinuity: true,
      repeatedPhrasing: false,
    });
  });

  it("flags a repeated phrase and broken emotional continuity", () => {
    const report = evaluateConversationQualityFixture({
      id: "repeat",
      obligationTopicIds: [],
      coveredTopicIds: [],
      replyText: "先別急，我知道你的感受真的很難受，我會陪你。",
      expectedEmotion: "sad",
      replyEmotion: "neutral",
      recentAssistantTexts: ["我知道你的感受真的很難受，我會陪你，慢慢說。"],
    });
    assert.equal(report.replyObligationCoverage, 1);
    assert.equal(report.emotionalContinuity, false);
    assert.equal(report.repeatedPhrasing, true);
  });

  it("uses runtime question intent rules so URL queries are not follow-ups", () => {
    const base = {
      obligationTopicIds: [],
      coveredTopicIds: [],
      expectedEmotion: null,
      replyEmotion: null,
      recentAssistantTexts: [],
    } as const;
    assert.equal(evaluateConversationQualityFixture({ ...base, id: "url", replyText: "請看 https://example.com/s?wd=test" }).followUpPresent, false);
    assert.equal(evaluateConversationQualityFixture({ ...base, id: "zh", replyText: "你現在方便嗎" }).followUpPresent, true);
  });

  it("classifies no visible reply as empty while one visible character stays short", () => {
    const base = {
      obligationTopicIds: [],
      coveredTopicIds: [],
      expectedEmotion: null,
      replyEmotion: null,
      recentAssistantTexts: [],
    } as const;
    for (const [id, replyText] of [["blank", ""], ["spaces", "  \n"], ["sticker", "[表情:smile]"]] as const) {
      const report = evaluateConversationQualityFixture({ ...base, id, replyText });
      assert.equal(report.visibleLength, 0);
      assert.equal(report.visibleLengthBucket, "empty");
    }
    assert.equal(evaluateConversationQualityFixture({ ...base, id: "one", replyText: "好" }).visibleLengthBucket, "short");
  });
});

describe("fixed-seed quality distribution", () => {
  it("tracks configured follow-up and length weights deterministically", () => {
    const counts = { followUp: 0, short: 0, normal: 0, long: 0 };
    for (let index = 0; index < 10_000; index++) {
      const plan = planConversationQuality({
        stableTurnKey: `distribution-fixture-${index}`,
        topics: [{ id: "turn", text: "普通陳述內容" }],
        settings: {
          coveragePercent: 70,
          followUpPercent: 20,
          lengthWeights: [60, 30, 10],
          emotionContinuityTurns: 4,
          repetitionWindowAssistantTurns: 12,
        },
      });
      if (plan.followUp) counts.followUp++;
      counts[plan.lengthBucket]++;
    }
    assert.ok(Math.abs(counts.followUp / 100 - 20) < 1);
    assert.ok(Math.abs(counts.short / 100 - 60) < 1);
    assert.ok(Math.abs(counts.normal / 100 - 30) < 1);
    assert.ok(Math.abs(counts.long / 100 - 10) < 1);
  });
});
