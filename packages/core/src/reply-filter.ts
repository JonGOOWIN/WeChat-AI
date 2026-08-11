import type { ChatMessage, LlmClient } from "@wechat-ai/llm";
import {
  parseMultiBubbleReply,
  type ReplyPart,
} from "./reply-format.js";

/** Core rules for the second-pass send-plan formatter. */
export const REPLY_FILTER_SYSTEM_PROMPT = `
## 角色
你是微信消息**发送格式化器**，不是角色扮演者。

输入是角色已经写好的回复（可能是自然语言，也可能是杂乱 JSON）。你的任务：
- **只拆条、抽表情、去格式噪声**
- **禁止**新增剧情、禁止大幅改写口吻、禁止编造原文没有的内容
- 若原文已是 JSON，先理解语义再规范化；**不要**把 JSON 字面量当作用户可见文字发出

## 输出（系统强制）
你必须**只**输出一个 JSON 对象，不要 markdown 代码块、不要前后解释：

{"messages":["给你看～",{"type":"sticker","slug":"示例slug"},"喜欢吗"]}

硬性规则：
1. messages 是数组；**每一个元素 = 微信里单独发出的一条消息**
2. **微信不能「图文同条」**：一条消息只能是「纯文字」或「纯图片」
3. 元素只能是：
   - 字符串 → 只发文字
   - 对象 {"type":"sticker","slug":"..."} → 只发图片（不能带任何文字）
4. **禁止**把 sticker 的 JSON 写进字符串里；禁止在 sticker 对象里塞 text/caption
5. 正常闲聊拆成 2～4 条；极短附和可用 1 条；每条文字尽量短
6. 除该 JSON 外不要输出任何字符
`.trim();

export interface ReplyFilterInput {
  /** Primary model raw output (trimmed by caller or here) */
  rawText: string;
  /** Allowed sticker slugs; empty / omit → no sticker objects */
  allowedStickerSlugs?: string[];
  maxBubbles?: number;
  /** Soft max chars per bubble (hint for the filter model) */
  maxChunkChars?: number;
  /** Cap stickers per reply (try-chat should pass 0) */
  maxStickers?: number;
}

export interface ReplyFilterResult {
  parts: ReplyPart[];
  bubbles: string[];
  displayText: string;
  /** Whether filter LLM produced parseable multi-bubble JSON */
  fromFilterJson: boolean;
  /** True when rule-based fallback on primary raw was used */
  usedFallback: boolean;
  promptTokens: number;
  completionTokens: number;
}

export interface ReplyFilterOptions {
  /** When false, skip LLM and only run parseMultiBubbleReply (default true) */
  enabled?: boolean;
}

function emptyResult(): ReplyFilterResult {
  return {
    parts: [],
    bubbles: [],
    displayText: "",
    fromFilterJson: false,
    usedFallback: false,
    promptTokens: 0,
    completionTokens: 0,
  };
}

function toAllowedSet(
  slugs: string[] | Set<string> | undefined,
): Set<string> {
  if (!slugs) return new Set();
  if (slugs instanceof Set) {
    return new Set([...slugs].map((s) => s.trim().toLowerCase()).filter(Boolean));
  }
  return new Set(
    slugs.map((s) => s.trim().toLowerCase()).filter(Boolean),
  );
}

/**
 * Drop sticker parts whose slug is not in the allow-list.
 * When allow-list is empty, all stickers are dropped.
 */
export function dropDisallowedStickers(
  parts: ReplyPart[],
  allowed: Set<string> | string[],
): ReplyPart[] {
  const set = toAllowedSet(allowed);
  const out: ReplyPart[] = [];
  for (const p of parts) {
    if (p.kind === "text") {
      if (p.text.trim()) out.push({ kind: "text", text: p.text.trim() });
      continue;
    }
    const slug = p.slug.trim().toLowerCase();
    if (slug && set.has(slug)) {
      out.push({ kind: "sticker", slug });
    }
  }
  return out;
}

/** Build chat messages for the filter LLM (pure, testable). */
export function buildReplyFilterMessages(
  input: ReplyFilterInput,
): ChatMessage[] {
  const maxBubbles = input.maxBubbles ?? 5;
  const maxChunkChars = input.maxChunkChars ?? 72;
  const maxStickers = input.maxStickers ?? 2;
  const allowed = (input.allowedStickerSlugs ?? [])
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const uniqueAllowed = [...new Set(allowed)];

  const constraints: string[] = [
    REPLY_FILTER_SYSTEM_PROMPT,
    "",
    "## 本轮约束",
    `- messages 最多 ${maxBubbles} 个元素`,
    `- 每条文字尽量 ≤${Math.min(40, maxChunkChars)} 字（软限制，总长可再拆）`,
    `- sticker 最多 ${maxStickers} 个`,
  ];

  if (maxStickers <= 0 || uniqueAllowed.length === 0) {
    constraints.push(
      "- **禁止**输出任何 sticker 对象；messages 只能是字符串数组",
    );
  } else {
    constraints.push(
      `- 可用 sticker slug（禁止编造）：${uniqueAllowed.map((s) => `\`${s}\``).join(", ")}`,
    );
  }

  const system = constraints.join("\n");
  const raw = (input.rawText ?? "").trim();
  const user = [
    "## 待格式化的角色回复原文",
    "请转换为规定的 messages JSON：",
    "",
    raw,
  ].join("\n");

  return [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
}

function parseToResult(
  raw: string,
  opts: {
    maxBubbles: number;
    maxChunkChars: number;
    maxStickers: number;
    allowed: Set<string>;
    fromFilterJson: boolean;
    usedFallback: boolean;
    promptTokens: number;
    completionTokens: number;
  },
): ReplyFilterResult {
  // When maxStickers is 0 we still want to detect sticker objects and turn them
  // into text placeholders rather than silently dropping them.
  const parseMaxStickers =
    opts.maxStickers <= 0 ? 2 : opts.maxStickers;

  const parsed = parseMultiBubbleReply(raw, {
    maxBubbles: opts.maxBubbles,
    maxChunkChars: opts.maxChunkChars,
    maxStickers: parseMaxStickers,
    fallbackSplit: true,
    expandLongBubbles: true,
  });

  // A recognised JSON envelope is authoritative even when it is empty. Raw
  // fallback is only safe for non-JSON text; otherwise an empty/filtered send
  // plan can leak its wrapper to the user as a literal chat bubble.
  let parts =
    parsed.parts.length > 0
      ? parsed.parts
      : !parsed.fromJson && raw.trim()
        ? [{ kind: "text" as const, text: raw.trim() }]
        : [];

  if (opts.maxStickers <= 0) {
    parts = parts.map((p) =>
      p.kind === "sticker"
        ? ({ kind: "text" as const, text: `[表情:${p.slug}]` })
        : p,
    );
  } else {
    parts = dropDisallowedStickers(parts, opts.allowed);
  }

  if (!parts.length && raw.trim() && !parsed.fromJson) {
    const fallback = parseMultiBubbleReply(raw, {
      maxBubbles: opts.maxBubbles,
      maxChunkChars: opts.maxChunkChars,
      maxStickers: 0,
      fallbackSplit: true,
      expandLongBubbles: true,
    });
    parts = fallback.parts.length
      ? fallback.parts
      : [{ kind: "text", text: raw.trim() }];
  }

  const bubbles = parts.map((p) =>
    p.kind === "text" ? p.text : `[表情:${p.slug}]`,
  );
  const displayText = bubbles.join("\n");

  return {
    parts,
    bubbles,
    displayText,
    fromFilterJson: opts.fromFilterJson && parsed.fromJson,
    usedFallback: opts.usedFallback,
    promptTokens: opts.promptTokens,
    completionTokens: opts.completionTokens,
  };
}

/**
 * Second-pass AI filter: convert primary roleplay text into a WeChat send plan.
 * On LLM failure or empty parseable output, falls back to rule-based parse of primary raw.
 */
export class ReplyFilter {
  private enabled: boolean;

  constructor(
    private llm: LlmClient,
    opts: ReplyFilterOptions = {},
  ) {
    this.enabled = opts.enabled !== false;
  }

  /** Runtime settings reload. */
  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  async filter(input: ReplyFilterInput): Promise<ReplyFilterResult> {
    const rawText = (input.rawText ?? "").trim();
    if (!rawText) return emptyResult();

    const maxBubbles = input.maxBubbles ?? 5;
    const maxChunkChars = input.maxChunkChars ?? 72;
    const maxStickers = input.maxStickers ?? 2;
    const allowed = toAllowedSet(input.allowedStickerSlugs);

    if (!this.enabled) {
      return parseToResult(rawText, {
        maxBubbles,
        maxChunkChars,
        maxStickers,
        allowed,
        fromFilterJson: false,
        usedFallback: true,
        promptTokens: 0,
        completionTokens: 0,
      });
    }

    try {
      const messages = buildReplyFilterMessages({
        ...input,
        rawText,
        maxBubbles,
        maxChunkChars,
        maxStickers,
        allowedStickerSlugs: [...allowed],
      });
      // No tools — format only
      const usage = await this.llm.chatWithUsage(messages);
      const filteredRaw = (usage.text ?? "").trim();
      if (!filteredRaw) {
        return parseToResult(rawText, {
          maxBubbles,
          maxChunkChars,
          maxStickers,
          allowed,
          fromFilterJson: false,
          usedFallback: true,
          promptTokens: usage.promptTokens,
          completionTokens: usage.completionTokens,
        });
      }

      const result = parseToResult(filteredRaw, {
        maxBubbles,
        maxChunkChars,
        maxStickers,
        allowed,
        fromFilterJson: true,
        usedFallback: false,
        promptTokens: usage.promptTokens,
        completionTokens: usage.completionTokens,
      });

      // Only an unparseable filter response falls back to the primary output.
      // A valid envelope that becomes empty after allowlist filtering is an
      // authoritative empty send plan, not permission to re-inject raw JSON.
      if (!result.fromFilterJson) {
        return parseToResult(rawText, {
          maxBubbles,
          maxChunkChars,
          maxStickers,
          allowed,
          fromFilterJson: false,
          usedFallback: true,
          promptTokens: usage.promptTokens,
          completionTokens: usage.completionTokens,
        });
      }

      return result;
    } catch {
      return parseToResult(rawText, {
        maxBubbles,
        maxChunkChars,
        maxStickers,
        allowed,
        fromFilterJson: false,
        usedFallback: true,
        promptTokens: 0,
        completionTokens: 0,
      });
    }
  }
}
