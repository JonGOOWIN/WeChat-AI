export type ReplyLengthBucket = "short" | "normal" | "long";

export interface ConversationQualitySettings {
  coveragePercent: number;
  followUpPercent: number;
  lengthWeights: readonly [number, number, number];
  emotionContinuityTurns: number;
  repetitionWindowAssistantTurns: number;
}

export interface ConversationQualityPlan extends ConversationQualitySettings {
  stableTurnKey: string;
  coveredTopicIds: string[];
  omittedTopicIds: string[];
  protectedTopicIds: string[];
  followUp: boolean;
  lengthBucket: ReplyLengthBucket;
  lengthMinChars: number;
  lengthMaxChars: number;
}

export type ConversationQualityViolation = "length" | "follow-up" | "repetition";

export interface ConversationQualityRuntimeSummary {
  profile: ConversationQualitySettings;
  reasonCodes: string[];
}

/** Privacy-safe activity payload: decisions and numeric profile, never turn data. */
export function summarizeConversationQualityPlan(
  plan: ConversationQualityPlan,
): ConversationQualityRuntimeSummary {
  return {
    profile: {
      coveragePercent: plan.coveragePercent,
      followUpPercent: plan.followUpPercent,
      lengthWeights: [...plan.lengthWeights] as [number, number, number],
      emotionContinuityTurns: plan.emotionContinuityTurns,
      repetitionWindowAssistantTurns: plan.repetitionWindowAssistantTurns,
    },
    reasonCodes: [
      ...(plan.protectedTopicIds.length > 0 ? ["protected-obligation"] : []),
      plan.omittedTopicIds.length > 0 ? "coverage-limited" : "coverage-complete",
      plan.followUp ? "follow-up-selected" : "follow-up-not-selected",
      `length-${plan.lengthBucket}`,
    ],
  };
}

export function scoreConversationQualityViolations(
  violations: readonly ConversationQualityViolation[],
): number {
  return violations.reduce((score, violation) => {
    if (violation === "length") return score + 3;
    if (violation === "follow-up") return score + 2;
    return score + 1;
  }, 0);
}

export function inspectConversationQuality(params: {
  visibleText: string;
  plan: ConversationQualityPlan;
  recentAssistantTexts: readonly string[];
}): ConversationQualityViolation[] {
  const violations: ConversationQualityViolation[] = [];
  const visibleLength = [...params.visibleText.replace(/\s|\[表情:[^\]]+\]/gu, "")].length;
  // Buckets are generation targets. Post-generation enforcement is deliberately
  // one-sided: an overly long answer defeats the selected style, while a
  // naturally concise answer should not be padded just to hit a quota.
  if (visibleLength > params.plan.lengthMaxChars) {
    violations.push("length");
  }
  const questionCount = countConversationQuestionIntents(params.visibleText);
  if ((!params.plan.followUp && questionCount > 0) || questionCount > 1) {
    violations.push("follow-up");
  }
  const recent = params.plan.repetitionWindowAssistantTurns > 0
    ? params.recentAssistantTexts.slice(
        -params.plan.repetitionWindowAssistantTurns,
      )
    : [];
  if (hasRepeatedConversationPhrase(params.visibleText, recent)) {
    violations.push("repetition");
  }
  return violations;
}

/** Same deterministic repetition signal used by runtime checks and fixtures. */
export function hasRepeatedConversationPhrase(
  visibleText: string,
  recentAssistantTexts: readonly string[],
): boolean {
  const current = normalizePhrase(visibleText);
  return (
    current.length >= 16 &&
    recentAssistantTexts
      .map(normalizePhrase)
      .filter((text) => text.length >= 16)
      .some((previous) => {
        if (current.includes(previous) || previous.includes(current)) {
          return Math.min(current.length, previous.length) >= 16;
        }
        const commonLength = longestCommonSubstringLength(current, previous);
        return (
          commonLength >= 16 &&
          commonLength / Math.min(current.length, previous.length) >= 0.7
        );
      })
  );
}

export function buildConversationQualityRepairInstruction(
  plan: ConversationQualityPlan,
  violations: readonly ConversationQualityViolation[],
): string {
  return [
    "（系統）上一版回覆未通過本輪品質檢查，請只重寫一次，不要解釋檢查過程。",
    `問題：${violations.join(", ")}`,
    `整份可見文字必須為 ${plan.lengthMinChars}–${plan.lengthMaxChars} 字。`,
    plan.followUp ? "最多保留一個自然追問。" : "不要使用問號或追加追問。",
    "不要重用近期 assistant 回覆的相同套話或顯著片語。",
    "仍須遵守 system prompt 的 topic 覆蓋與輸出格式。",
  ].join("\n");
}

export const DEFAULT_CONVERSATION_QUALITY: ConversationQualitySettings = {
  coveragePercent: 70,
  followUpPercent: 20,
  lengthWeights: [60, 30, 10],
  emotionContinuityTurns: 4,
  repetitionWindowAssistantTurns: 12,
};

export function resolveConversationQualitySettings(
  patch: Partial<ConversationQualitySettings> = {},
): ConversationQualitySettings {
  return {
    coveragePercent: clampPercent(
      patch.coveragePercent ?? DEFAULT_CONVERSATION_QUALITY.coveragePercent,
    ),
    followUpPercent: clampPercent(
      patch.followUpPercent ?? DEFAULT_CONVERSATION_QUALITY.followUpPercent,
    ),
    lengthWeights: normalizeWeights(
      patch.lengthWeights ?? DEFAULT_CONVERSATION_QUALITY.lengthWeights,
    ),
    emotionContinuityTurns: clampInteger(
      patch.emotionContinuityTurns,
      DEFAULT_CONVERSATION_QUALITY.emotionContinuityTurns,
      0,
      20,
    ),
    repetitionWindowAssistantTurns: clampInteger(
      patch.repetitionWindowAssistantTurns,
      DEFAULT_CONVERSATION_QUALITY.repetitionWindowAssistantTurns,
      0,
      50,
    ),
  };
}

export function planConversationQuality(params: {
  stableTurnKey: string;
  topics: readonly {
    id: string;
    text: string;
    hasAttachments?: boolean;
    replyObligation?: boolean;
    protectedObligation?: boolean;
  }[];
  settings: ConversationQualitySettings;
}): ConversationQualityPlan {
  const stableTurnKey = stableHash(params.stableTurnKey);
  const protectedIds: string[] = [];
  const ordinaryIds: string[] = [];
  for (const topic of params.topics) {
    if (
      topic.protectedObligation === true ||
      isProtectedReplyObligation(topic.text, topic.hasAttachments === true)
    ) {
      protectedIds.push(topic.id);
    } else if (
      topic.replyObligation === true ||
      (topic.replyObligation !== false &&
        isReplyObligation(topic.text, topic.hasAttachments === true))
    ) {
      ordinaryIds.push(topic.id);
    }
  }
  const ordinaryTarget = Math.ceil(
    (ordinaryIds.length * params.settings.coveragePercent) / 100,
  );
  const selectedOrdinary = [...ordinaryIds]
    .sort(
      (a, b) =>
        stableUnit(`${stableTurnKey}\u0000coverage\u0000${a}`) -
        stableUnit(`${stableTurnKey}\u0000coverage\u0000${b}`),
    )
    .slice(0, ordinaryTarget);
  const coveredTopicIds = [...protectedIds, ...selectedOrdinary];
  const covered = new Set(coveredTopicIds);
  const omittedTopicIds = ordinaryIds.filter((id) => !covered.has(id));
  const followUp =
    stableUnit(`${stableTurnKey}\u0000follow-up`) <
    params.settings.followUpPercent / 100;
  const lengthIndex = selectWeight(
    params.settings.lengthWeights,
    stableUnit(`${stableTurnKey}\u0000length`),
  );
  const lengths = [
    { lengthBucket: "short", lengthMinChars: 1, lengthMaxChars: 20 },
    { lengthBucket: "normal", lengthMinChars: 21, lengthMaxChars: 60 },
    { lengthBucket: "long", lengthMinChars: 61, lengthMaxChars: 160 },
  ] as const;
  return {
    ...params.settings,
    stableTurnKey,
    coveredTopicIds,
    omittedTopicIds,
    protectedTopicIds: protectedIds,
    followUp,
    ...lengths[lengthIndex]!,
  };
}

function isProtectedReplyObligation(text: string, hasAttachments: boolean): boolean {
  if (hasAttachments) return true;
  const value = text.trim();
  return (
    containsQuestionIntent(value) ||
    /(?:請|请|幫|帮|麻煩|麻烦|拜託|拜托|記得|记得|提醒|告訴|告诉|給我|给我|需要你|決定|决定|確認|确认|同意|選|选|定案|敲定|就定|拍板)/.test(value) ||
    /(?:難過|难过|傷心|伤心|生氣|生气|害怕|焦慮|焦虑|委屈|想你|愛你|爱你|開心|开心|崩潰|崩溃)/.test(value)
  );
}

/** Shared runtime/evaluator question-intent seam; URL query strings are ignored. */
export function countConversationQuestionIntents(value: string): number {
  const withoutUrls = stripUrls(value);
  const punctuationCount = (withoutUrls.match(/[?？]/g) ?? []).length;
  return punctuationCount > 0
    ? punctuationCount
    : containsQuestionIntent(withoutUrls)
      ? 1
      : 0;
}

function containsQuestionIntent(value: string): boolean {
  const text = stripUrls(value).trim();
  if (/[?？]/u.test(text)) return true;
  if (/[嗎吗]\s*[啊呀嘛吧]?\s*[.!！。…~～]*$/u.test(text)) return true;
  if (
    /(?:你)?在(?:做(?:什麼|什么)|幹嘛|干嘛)\s*[.!！。…~～]*$/u.test(text)
  ) {
    return true;
  }
  return /(?:你|那你|所以|然後|然后|怎麼|怎么|為什麼|为什么|哪裡|哪里|在|有空|方便|可以|行|好|對|对|是|要|能|會|会|知道|明白|看見|看见|收到)呢\s*[.!！。…~～]*$/u.test(
    text,
  );
}

function stripUrls(value: string): string {
  // Keep adjacent CJK text: URL bodies are ASCII or percent-encoded, so a
  // non-ASCII code point ends the URL. Bare domains are limited to common
  // public TLDs so ordinary dotted prose is not swallowed as a URL.
  return value.replace(
    /(?:https?:\/\/|www\.)[\x21-\x7e]+|(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:com|org|net|edu|gov|io|ai|co|cn|tw|hk|jp|kr|uk|de|fr|app|dev|me|info|biz|xyz)(?::\d{1,5})?(?:\/[\x21-\x7e]*)?(?:\?[\x21-\x7e]*)?/giu,
    "",
  );
}

function isReplyObligation(text: string, hasAttachments: boolean): boolean {
  if (hasAttachments) return true;
  const value = text.trim();
  return value.length >= 4 && !/^(?:嗯+|哦+|喔+|哈+|哈哈+|好吧|行吧|收到)[～~.!！。…]*$/.test(value);
}

function stableUnit(key: string): number {
  return Number.parseInt(stableHash(key), 16) / 0x1_0000_0000;
}

function stableHash(key: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < key.length; index++) {
    hash ^= key.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function normalizePhrase(value: string): string {
  return value.slice(0, 512).toLowerCase().replace(/[\s\p{P}\p{S}]/gu, "");
}

function longestCommonSubstringLength(a: string, b: string): number {
  const previous = new Array<number>(b.length + 1).fill(0);
  let longest = 0;
  for (let left = 1; left <= a.length; left++) {
    let diagonal = 0;
    for (let right = 1; right <= b.length; right++) {
      const above = previous[right]!;
      previous[right] = a[left - 1] === b[right - 1] ? diagonal + 1 : 0;
      longest = Math.max(longest, previous[right]!);
      diagonal = above;
    }
  }
  return longest;
}

function selectWeight(weights: readonly number[], point: number): number {
  const total = weights.reduce((sum, value) => sum + value, 0);
  let cursor = point * total;
  for (let index = 0; index < weights.length; index++) {
    cursor -= weights[index]!;
    if (cursor < 0) return index;
  }
  return weights.length - 1;
}

function normalizeWeights(values: readonly number[]): [number, number, number] {
  const normalized = [0, 1, 2].map((index) => {
    const value = Number(values[index]);
    return Number.isFinite(value) && value >= 0 ? value : 0;
  }) as [number, number, number];
  return normalized.some((value) => value > 0) ? normalized : [60, 30, 10];
}

function clampPercent(value: number): number {
  return Number.isFinite(value) ? Math.min(100, Math.max(0, value)) : 0;
}

function clampInteger(value: number | undefined, fallback: number, min: number, max: number): number {
  return Number.isFinite(value)
    ? Math.min(max, Math.max(min, Math.round(value!)))
    : fallback;
}
