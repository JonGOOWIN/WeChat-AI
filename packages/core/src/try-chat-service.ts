import {
  type Db,
  type MessageRow,
  type Persona,
  appendTryChatMessages,
  createTryChatSession,
  deleteTryChatSession,
  getPersona,
  getPublishedGraph,
  getPublishedPrompt,
  getTryChatDayCount,
  getTryChatSession,
  incrTryChatDayCount,
  listTryChatMessages,
  recordTokenUsage,
  saveTryChatSession,
  userCanUsePersona,
} from "@wechat-ai/db";
import type { LlmClient } from "@wechat-ai/llm";
import { buildChatMessages } from "./prompt.js";
import { ChatflowEngine } from "./chatflow/engine.js";
import {
  parseMultiBubbleReply,
  type ReplyPart,
} from "./reply-format.js";
import { ReplyFilter } from "./reply-filter.js";
import {
  planConversationQuality,
  resolveConversationQualitySettings,
  type ConversationQualityPlan,
  type ConversationQualitySettings,
} from "./conversation-quality.js";

export interface TryChatServiceOptions {
  sessionTtlSec: number;
  maxHistory: number;
  maxUserMsgsPerDay: number;
  maxUserMsgsPerSession: number;
  multiBubbleJson?: boolean;
  maxReplyBubbles?: number;
  maxChunkChars?: number;
  /**
   * Second-pass AI filter for multi-bubble JSON (default false).
   * When true, primary model does not receive REPLY_FORMAT_INSTRUCTION.
   */
  replyFilterEnabled?: boolean;
  timeToolEnabled?: boolean;
  timeToolTimeZone?: string;
  /**
   * Chatflow personas: run the published graph in try-chat too.
   * Always platform upstream — never the author's custom provider.
   */
  toolsBaseUrl?: string;
  toolsApiKey?: string;
  /** Wall clock for one tools-gateway search call */
  toolsTimeoutMs?: number;
  webSearchEnabled?: boolean;
  /** Default result count for chatflow search nodes (default 5) */
  webSearchMaxResults?: number;
  chatflowHttpAllowHosts?: string[];
  chatflowMaxSteps?: number;
  chatflowMaxNodes?: number;
  /** Global RULE-002 defaults; persona fields override these one by one. */
  conversationQuality?: Partial<ConversationQualitySettings>;
}

export interface StartTrySessionInput {
  userId: string;
  personaId: string;
  botName?: string;
}

export interface StartTrySessionResult {
  sessionId: string;
  persona: Pick<Persona, "id" | "slug" | "display_name" | "description">;
  botName: string;
  expiresInSec: number;
  remainingToday: number;
}

export interface SendTryMessageInput {
  userId: string;
  sessionId: string;
  text: string;
  /** Optional username for usage stats */
  username?: string;
}

export interface SendTryMessageResult {
  parts: ReplyPart[];
  displayText: string;
  usage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
  remainingToday: number;
  remainingSession: number;
  /** Persona metadata for privacy-safe runtime observability. */
  personaId: string;
  personaMode: Persona["mode"];
  /** Effective deterministic plan (global → persona; try-chat has no peer). */
  qualityPlan: ConversationQualityPlan;
}

export class TryChatError extends Error {
  constructor(
    public code:
      | "disabled"
      | "not_found"
      | "forbidden"
      | "quota_day"
      | "quota_session"
      | "empty"
      | "llm"
      | "no_prompt",
    message: string,
  ) {
    super(message);
    this.name = "TryChatError";
  }
}

const DEFAULTS: TryChatServiceOptions = {
  sessionTtlSec: 3600,
  maxHistory: 40,
  maxUserMsgsPerDay: 40,
  maxUserMsgsPerSession: 20,
  multiBubbleJson: true,
  maxReplyBubbles: 5,
  maxChunkChars: 72,
  replyFilterEnabled: false,
  timeToolEnabled: true,
  timeToolTimeZone: "Asia/Shanghai",
};

export class TryChatService {
  private opts: TryChatServiceOptions;
  private replyFilter: ReplyFilter;
  private chatflow: ChatflowEngine;

  constructor(
    private db: Db,
    private llm: LlmClient,
    opts: Partial<TryChatServiceOptions> = {},
  ) {
    this.opts = { ...DEFAULTS, ...opts };
    this.replyFilter = new ReplyFilter(llm, {
      enabled: this.opts.replyFilterEnabled === true,
    });
    this.chatflow = new ChatflowEngine({
      platformLlm: llm,
      toolsBaseUrl: this.opts.toolsBaseUrl,
      toolsApiKey: this.opts.toolsApiKey,
      toolsTimeoutMs: this.opts.toolsTimeoutMs,
      webSearchEnabled: this.opts.webSearchEnabled === true,
      webSearchMaxResults: this.opts.webSearchMaxResults,
      maxSteps: this.opts.chatflowMaxSteps ?? 32,
      maxNodes: this.opts.chatflowMaxNodes ?? 40,
      httpAllowHosts: this.opts.chatflowHttpAllowHosts,
      timeZone: this.opts.timeToolTimeZone || "Asia/Shanghai",
    });
  }

  /**
   * Apply admin-editable settings in place (runtime settings reload).
   * Only the keys present in `patch` are touched.
   */
  applyRuntimeOptions(patch: Partial<TryChatServiceOptions>): void {
    const qualityPatch = patch.conversationQuality;
    const previousQuality = this.opts.conversationQuality;
    Object.assign(this.opts, patch);
    if (qualityPatch !== undefined) {
      this.opts.conversationQuality = {
        ...previousQuality,
        ...qualityPatch,
      };
    }
    if ("replyFilterEnabled" in patch) {
      this.replyFilter.setEnabled(this.opts.replyFilterEnabled === true);
    }
    this.chatflow.applyOptions({
      toolsBaseUrl: this.opts.toolsBaseUrl,
      toolsApiKey: this.opts.toolsApiKey,
      toolsTimeoutMs: this.opts.toolsTimeoutMs,
      webSearchEnabled: this.opts.webSearchEnabled === true,
      webSearchMaxResults: this.opts.webSearchMaxResults,
      maxSteps: this.opts.chatflowMaxSteps ?? 32,
      maxNodes: this.opts.chatflowMaxNodes ?? 40,
      httpAllowHosts: this.opts.chatflowHttpAllowHosts,
      timeZone: this.opts.timeToolTimeZone || "Asia/Shanghai",
    });
  }

  private primaryMultiBubbleJson(): boolean {
    if (this.opts.replyFilterEnabled === true) return false;
    return this.opts.multiBubbleJson !== false;
  }

  async startSession(
    input: StartTrySessionInput,
  ): Promise<StartTrySessionResult> {
    const persona = await getPersona(this.db, input.personaId);
    if (!persona || !persona.enabled) {
      throw new TryChatError("not_found", "人设不存在或已下架");
    }
    if (!(await userCanUsePersona(this.db, input.userId, persona.id))) {
      // Public personas are usable without library for try-chat browse UX
      if (!(persona.visibility === "public" && persona.enabled)) {
        throw new TryChatError("forbidden", "无权试聊该人设");
      }
    }
    const prompt = await getPublishedPrompt(this.db, persona.id);
    if (!prompt?.trim()) {
      throw new TryChatError("no_prompt", "人设尚未发布可用提示词");
    }

    const usedToday = await getTryChatDayCount(this.db, input.userId);
    if (usedToday >= this.opts.maxUserMsgsPerDay) {
      throw new TryChatError(
        "quota_day",
        `今日试聊次数已用完（${this.opts.maxUserMsgsPerDay} 条）`,
      );
    }

    const { sessionId, session, ttlSec } = await createTryChatSession(this.db, {
      userId: input.userId,
      personaId: persona.id,
      botName: input.botName,
      ttlSec: this.opts.sessionTtlSec,
    });

    return {
      sessionId,
      persona: {
        id: persona.id,
        slug: persona.slug,
        display_name: persona.display_name,
        description: persona.description,
      },
      botName: session.botName,
      expiresInSec: ttlSec,
      remainingToday: Math.max(0, this.opts.maxUserMsgsPerDay - usedToday),
    };
  }

  async sendMessage(
    input: SendTryMessageInput,
  ): Promise<SendTryMessageResult> {
    const text = (input.text || "").trim();
    if (!text) {
      throw new TryChatError("empty", "消息不能为空");
    }
    if (text.length > 2000) {
      throw new TryChatError("empty", "消息过长（最多 2000 字）");
    }

    const session = await getTryChatSession(this.db, input.sessionId);
    if (!session || session.userId !== input.userId) {
      throw new TryChatError("not_found", "试聊会话不存在或已过期");
    }
    if (session.msgCount >= this.opts.maxUserMsgsPerSession) {
      throw new TryChatError(
        "quota_session",
        `本会话已达上限（${this.opts.maxUserMsgsPerSession} 条），请新开试聊`,
      );
    }

    const usedToday = await getTryChatDayCount(this.db, input.userId);
    if (usedToday >= this.opts.maxUserMsgsPerDay) {
      throw new TryChatError(
        "quota_day",
        `今日试聊次数已用完（${this.opts.maxUserMsgsPerDay} 条）`,
      );
    }

    const persona = await getPersona(this.db, session.personaId);
    if (!persona || !persona.enabled) {
      throw new TryChatError("not_found", "人设不存在或已下架");
    }
    // Re-check access (takedown / private)
    if (
      persona.visibility === "private" &&
      persona.owner_user_id !== input.userId
    ) {
      throw new TryChatError("forbidden", "无权试聊该人设");
    }
    if (
      persona.visibility === "public" ||
      persona.owner_user_id === input.userId
    ) {
      // ok
    } else if (!(await userCanUsePersona(this.db, input.userId, persona.id))) {
      throw new TryChatError("forbidden", "无权试聊该人设");
    }

    const systemPrompt = await getPublishedPrompt(this.db, persona.id);
    if (!systemPrompt?.trim()) {
      throw new TryChatError("no_prompt", "人设尚未发布可用提示词");
    }

    // Reserve daily quota before LLM call
    const dayCount = await incrTryChatDayCount(this.db, input.userId);
    if (dayCount > this.opts.maxUserMsgsPerDay) {
      throw new TryChatError(
        "quota_day",
        `今日试聊次数已用完（${this.opts.maxUserMsgsPerDay} 条）`,
      );
    }

    const prior = await listTryChatMessages(
      this.db,
      input.sessionId,
      this.opts.maxHistory,
    );
    const history: MessageRow[] = prior.map((m, i) => ({
      id: `try_${i}`,
      bot_account_id: "try-chat",
      peer_id: input.userId,
      persona_id: persona.id,
      role: m.role,
      content: m.content,
      context_token: null,
      created_at: new Date().toISOString(),
    }));
    const qualitySettings = resolveConversationQualitySettings({
      ...this.opts.conversationQuality,
      ...persona.conversation_quality,
    });
    const qualityPlan = planConversationQuality({
      // A retry may create a fresh preview session. Persona + exact turn text
      // preserves the probabilistic choices without inventing a peer identity.
      stableTurnKey: [persona.id, text].join("\u0000"),
      topics: [{ id: "turn", text }],
      settings: qualitySettings,
    });

    let usage: {
      text: string;
      promptTokens: number;
      completionTokens: number;
    };
    if (persona.mode === "chatflow") {
      // Try-chat always runs on the platform upstream: never spend the
      // author's custom provider quota / leak their key.
      try {
        const graph = await getPublishedGraph(this.db, persona.id);
        const cf = await this.chatflow.run(graph, {
          userText: text,
          botName: session.botName,
          systemPrompt,
          history: history.map((m) => ({
            role: m.role,
            content: m.content,
          })),
          memories: [],
          webSearchEnabled: Boolean(persona.web_search_enabled),
          upstream: null,
          qualityPlan,
        });
        usage = {
          text: cf.text,
          promptTokens: cf.promptTokens,
          completionTokens: cf.completionTokens,
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new TryChatError("llm", `Chatflow 执行失败：${msg}`);
      }
    } else {
      const messages = buildChatMessages({
        systemPrompt,
        memories: [],
        history,
        userText: text,
        botName: session.botName,
        multiBubbleJson: this.primaryMultiBubbleJson(),
        stickers: [],
        timeToolEnabled: this.opts.timeToolEnabled !== false,
        conversationQualityPlan: qualityPlan,
      });

      try {
        usage = await this.llm.chatWithUsage(messages, {
          tools:
            this.opts.timeToolEnabled !== false ? ["get_current_time"] : [],
          timeZone: this.opts.timeToolTimeZone || "Asia/Shanghai",
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new TryChatError("llm", `模型调用失败：${msg}`);
      }
    }

    let parts: ReplyPart[];
    let displayText: string;
    let filterPromptTokens = 0;
    let filterCompletionTokens = 0;

    if (this.opts.replyFilterEnabled === true) {
      const filtered = await this.replyFilter.filter({
        rawText: usage.text,
        allowedStickerSlugs: [],
        maxBubbles: this.opts.maxReplyBubbles ?? 5,
        maxChunkChars: this.opts.maxChunkChars ?? 72,
        maxStickers: 0,
      });
      filterPromptTokens = filtered.promptTokens;
      filterCompletionTokens = filtered.completionTokens;
      parts =
        filtered.parts.length > 0
          ? filtered.parts.map((p) =>
              p.kind === "sticker"
                ? ({ kind: "text" as const, text: `[表情:${p.slug}]` })
                : p,
            )
          : [{ kind: "text" as const, text: usage.text.trim() || "……" }];
      displayText =
        filtered.displayText ||
        parts
          .filter((p): p is { kind: "text"; text: string } => p.kind === "text")
          .map((p) => p.text)
          .join("\n");
    } else {
      const parsed = parseMultiBubbleReply(usage.text, {
        maxBubbles: this.opts.maxReplyBubbles ?? 5,
        maxChunkChars: this.opts.maxChunkChars ?? 72,
        maxStickers: 0,
        fallbackSplit: true,
        expandLongBubbles: true,
      });
      parts =
        parsed.parts.length > 0
          ? parsed.parts.map((p) =>
              p.kind === "sticker"
                ? ({ kind: "text" as const, text: `[表情:${p.slug}]` })
                : p,
            )
          : [
              {
                kind: "text" as const,
                // Never echo a recognised JSON envelope back at the preview.
                text: (parsed.fromJson ? "" : usage.text.trim()) || "……",
              },
            ];
      displayText =
        parsed.displayText ||
        parts
          .filter((p): p is { kind: "text"; text: string } => p.kind === "text")
          .map((p) => p.text)
          .join("\n");
    }

    await appendTryChatMessages(
      this.db,
      input.sessionId,
      [
        { role: "user", content: text },
        { role: "assistant", content: displayText },
      ],
      {
        maxHistory: this.opts.maxHistory,
        ttlSec: this.opts.sessionTtlSec,
      },
    );

    session.msgCount = Number(session.msgCount || 0) + 1;
    await saveTryChatSession(
      this.db,
      input.sessionId,
      session,
      this.opts.sessionTtlSec,
    );

    await recordTokenUsage(this.db, {
      userId: input.userId,
      botId: "try-chat",
      botName: "网页试聊",
      username: input.username,
      promptTokens: usage.promptTokens,
      completionTokens: usage.completionTokens,
    });
    if (filterPromptTokens > 0 || filterCompletionTokens > 0) {
      await recordTokenUsage(this.db, {
        userId: input.userId,
        botId: "try-chat",
        botName: "网页试聊",
        username: input.username,
        promptTokens: filterPromptTokens,
        completionTokens: filterCompletionTokens,
      });
    }

    const totalPrompt = usage.promptTokens + filterPromptTokens;
    const totalCompletion = usage.completionTokens + filterCompletionTokens;

    return {
      parts,
      displayText,
      usage: {
        promptTokens: totalPrompt,
        completionTokens: totalCompletion,
        totalTokens: totalPrompt + totalCompletion,
      },
      remainingToday: Math.max(0, this.opts.maxUserMsgsPerDay - dayCount),
      remainingSession: Math.max(
        0,
        this.opts.maxUserMsgsPerSession - session.msgCount,
      ),
      personaId: persona.id,
      personaMode: persona.mode,
      qualityPlan,
    };
  }

  async endSession(userId: string, sessionId: string): Promise<void> {
    const session = await getTryChatSession(this.db, sessionId);
    if (!session) return;
    if (session.userId !== userId) {
      throw new TryChatError("forbidden", "无权结束该会话");
    }
    await deleteTryChatSession(this.db, sessionId);
  }
}
