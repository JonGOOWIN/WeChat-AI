import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  planAdaptiveReply,
  type ReplyCountSelector,
} from "./adaptive-reply-plan.js";

class LastWeightedSelector implements ReplyCountSelector {
  select(weights: readonly number[]): number {
    return weights.length - 1;
  }
}

describe("planAdaptiveReply", () => {
  it("chooses a stable reply count for the same batch and weights", () => {
    const makePlan = () =>
      planAdaptiveReply([{ id: "m1", text: "请给我建议？" }], {
        batchId: "batch-stable",
        skipBiasPercent: 10,
        replyCountWeights: [25, 25, 25, 25],
      });

    const first = makePlan();
    for (let attempt = 0; attempt < 20; attempt++) {
      assert.equal(makePlan().targetPartCount, first.targetPartCount);
    }
  });

  it("never skips a direct question even when the skip bias is 100 percent", () => {
    const plan = planAdaptiveReply(
      [
        { id: "m1", text: "对了" },
        { id: "m2", text: "明天几点出发？" },
      ],
      {
        skipBiasPercent: 100,
        replyCountWeights: [50, 30, 15, 5],
        selector: new LastWeightedSelector(),
      },
    );

    assert.equal(plan.decision, "reply");
    assert.equal(plan.targetPartCount, 4);
    assert.deepEqual(plan.coveredItemIds, ["m2"]);
    assert.equal(plan.items[0]!.kind, "continuation");
    assert.equal(plan.items[0]!.replyObligation, false);
    assert.equal(plan.items[1]!.kind, "new-question-or-request");
    assert.equal(plan.items[1]!.replyObligation, true);
    assert.equal(plan.reason, "reply-obligation");
  });

  it("skips only when the entire batch has no reply obligation", () => {
    const plan = planAdaptiveReply(
      [
        { id: "m1", text: "哈哈" },
        { id: "m2", text: "嗯嗯" },
      ],
      {
        skipBiasPercent: 10,
        replyCountWeights: [50, 30, 15, 5],
        selector: new LastWeightedSelector(),
      },
    );

    assert.equal(plan.decision, "skip");
    assert.equal(plan.targetPartCount, 0);
    assert.deepEqual(plan.coveredItemIds, []);
    assert.deepEqual(
      plan.items.map((item) => item.kind),
      ["filler-or-reaction", "filler-or-reaction"],
    );
    assert.equal(plan.reason, "no-reply-obligation");
  });

  it("keeps an attachment-only item reply-obligated", () => {
    const plan = planAdaptiveReply(
      [{ id: "m1", text: "", hasAttachments: true }],
      {
        skipBiasPercent: 100,
        replyCountWeights: [50, 30, 15, 5],
        selector: { select: () => 0 },
      },
    );

    assert.equal(plan.decision, "reply");
    assert.deepEqual(plan.coveredItemIds, ["m1"]);
  });

  it("keeps a complete substantive statement reply-obligated", () => {
    const plan = planAdaptiveReply(
      [{ id: "m1", text: "今天终于把项目做完了。" }],
      {
        skipBiasPercent: 100,
        replyCountWeights: [50, 30, 15, 5],
        selector: { select: () => 0 },
      },
    );

    assert.equal(plan.decision, "reply");
    assert.equal(plan.items[0]!.kind, "continuation");
    assert.deepEqual(plan.coveredItemIds, ["m1"]);
  });

  it("does not skip a correction that changes the requested decision", () => {
    const plan = planAdaptiveReply(
      [{ id: "m1", text: "不对，改成周四出发" }],
      {
        skipBiasPercent: 100,
        replyCountWeights: [50, 30, 15, 5],
        selector: { select: () => 0 },
      },
    );
    assert.equal(plan.decision, "reply");
    assert.equal(plan.items[0]!.kind, "correction");
    assert.deepEqual(plan.coveredItemIds, ["m1"]);
  });

  it("uses zero skip bias conservatively for a no-obligation filler batch", () => {
    const plan = planAdaptiveReply([{ id: "m1", text: "嗯嗯" }], {
      skipBiasPercent: 0,
      replyCountWeights: [50, 30, 15, 5],
      selector: { select: () => 0 },
    });
    assert.equal(plan.decision, "reply");
    assert.equal(plan.reason, "conservative-no-obligation");
    assert.deepEqual(plan.coveredItemIds, []);
  });
});
