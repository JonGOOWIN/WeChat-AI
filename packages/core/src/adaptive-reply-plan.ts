export type BatchItemKind =
  | "continuation"
  | "correction"
  | "filler-or-reaction"
  | "new-question-or-request"
  | "emotional-bid";

export interface AdaptiveReplyPlanItem {
  id: string;
  kind: BatchItemKind;
  replyObligation: boolean;
}

interface AdaptiveReplyPlanBase {
  coveredItemIds: string[];
  reason:
    | "no-reply-obligation"
    | "reply-obligation"
    | "conservative-no-obligation";
  /** Calibration target only; it never overrides reply obligations. */
  skipBiasPercent: number;
  items: AdaptiveReplyPlanItem[];
}

export type AdaptiveReplyPlan = AdaptiveReplyPlanBase &
  (
    | { decision: "skip"; targetPartCount: 0 }
    | { decision: "reply"; targetPartCount: 1 | 2 | 3 | 4 }
  );

export interface ReplyCountSelector {
  /** Return a zero-based bucket index for the supplied runtime weights. */
  select(weights: readonly number[], stableKey?: string): number;
}

export class WeightedReplyCountSelector implements ReplyCountSelector {
  select(weights: readonly number[], stableKey = ""): number {
    const normalized = normalizeWeights(weights);
    const total = normalized.reduce((sum, weight) => sum + weight, 0);
    let point = stableUnitInterval(stableKey) * total;
    for (let i = 0; i < normalized.length; i++) {
      point -= normalized[i]!;
      if (point < 0) return i;
    }
    return normalized.length - 1;
  }
}

export interface AdaptiveReplyPlannerOptions {
  batchId?: string;
  skipBiasPercent: number;
  replyCountWeights: readonly [number, number, number, number];
  selector?: ReplyCountSelector;
}

export function planAdaptiveReply(
  sourceItems: readonly { id: string; text: string; hasAttachments?: boolean }[],
  options: AdaptiveReplyPlannerOptions,
): AdaptiveReplyPlan {
  const items = sourceItems.map((item) => classifyItem(item));
  const coveredItemIds = items
    .filter((item) => item.replyObligation)
    .map((item) => item.id);
  const skipBiasPercent = clampPercent(options.skipBiasPercent);

  if (
    coveredItemIds.length === 0 &&
    shouldSkipNoObligation(items, skipBiasPercent)
  ) {
    return {
      decision: "skip",
      targetPartCount: 0,
      coveredItemIds,
      reason: "no-reply-obligation",
      skipBiasPercent,
      items,
    };
  }

  const stableKey = `${options.batchId ?? ""}\u0000${sourceItems
    .map((item) => item.id)
    .join("\u0000")}`;
  const selected = (options.selector ?? new WeightedReplyCountSelector()).select(
    normalizeWeights(options.replyCountWeights),
    stableKey,
  );
  const targetPartCount =
    Number.isInteger(selected) && selected >= 0 && selected <= 3
      ? ((selected + 1) as 1 | 2 | 3 | 4)
      : 1;
  return {
    decision: "reply",
    targetPartCount,
    coveredItemIds,
    reason:
      coveredItemIds.length > 0
        ? "reply-obligation"
        : "conservative-no-obligation",
    skipBiasPercent,
    items,
  };
}

function shouldSkipNoObligation(
  items: readonly AdaptiveReplyPlanItem[],
  biasPercent: number,
): boolean {
  if (biasPercent <= 0) return false;
  if (items.every((item) => item.kind === "filler-or-reaction")) return true;
  // Incomplete/uncertain continuations are only skipped at an explicitly
  // aggressive setting. This is semantic thresholding, not a per-batch die.
  return biasPercent >= 50;
}

function classifyItem(
  item: { id: string; text: string; hasAttachments?: boolean },
): AdaptiveReplyPlanItem {
  const text = item.text.trim();
  if (item.hasAttachments) {
    return {
      id: item.id,
      kind: "new-question-or-request",
      replyObligation: true,
    };
  }
  if (isFiller(text)) {
    return { id: item.id, kind: "filler-or-reaction", replyObligation: false };
  }
  if (isEmotionalBid(text)) {
    return { id: item.id, kind: "emotional-bid", replyObligation: true };
  }
  if (isQuestionOrRequest(text)) {
    return {
      id: item.id,
      kind: "new-question-or-request",
      replyObligation: true,
    };
  }
  if (isCorrection(text)) {
    return { id: item.id, kind: "correction", replyObligation: true };
  }
  return {
    id: item.id,
    kind: "continuation",
    replyObligation: !isIncompleteContinuation(text),
  };
}

function isIncompleteContinuation(text: string): boolean {
  return /^(?:对了|还有|然后|就是|那个|我想(?:问|说|补充)|等一下|先等等|稍等)[：:]?$/u.test(
    text,
  );
}

function isFiller(text: string): boolean {
  return /^(?:哈+|哈哈哈*|嗯+|哦+|噢+|好(?:的|呀|啊)?|行|收到|ok|okay|谢+|谢谢|😂+|🤣+|👍+|[.。…]+)$/iu.test(
    text,
  );
}

function isCorrection(text: string): boolean {
  return /^(?:不对|不是|改成|更正|我说错了|应该是|准确地说)/u.test(text);
}

function isQuestionOrRequest(text: string): boolean {
  return (
    /[?？]/u.test(text) ||
    /(?:请|帮我|麻烦|能不能|可以(?:帮|给|告诉|解释)|怎么|如何|为什么|什么|哪(?:里|个|些)|几(?:点|个|天)|要不要|是不是|是否)/u.test(
      text,
    )
  );
}

function isEmotionalBid(text: string): boolean {
  return /(?:难过|伤心|害怕|焦虑|崩溃|绝望|生气|孤独|想哭|撑不住|好累|很累|需要你|陪陪我)/u.test(
    text,
  );
}

function normalizeWeights(weights: readonly number[]): [number, number, number, number] {
  if (
    weights.length !== 4 ||
    weights.some((weight) => !Number.isFinite(weight) || weight < 0) ||
    weights.every((weight) => weight === 0)
  ) {
    return [50, 30, 15, 5];
  }
  return [weights[0]!, weights[1]!, weights[2]!, weights[3]!];
}

function clampPercent(value: number): number {
  return Number.isFinite(value) ? Math.min(100, Math.max(0, value)) : 10;
}

/** FNV-1a: stable across processes and retries, unlike runtime-random hash seeds. */
function stableUnitInterval(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0) / 0x1_0000_0000;
}
