import {
  type Db,
  type StickerPromptEntry,
  clearMemories,
  ensurePeer,
  getBotAccount,
  getPublishedGraph,
  getPublishedPrompt,
  getUser,
  insertMessage,
  listStickersForOwnerPrompt,
  listMemories,
  listRecentMessages,
  recordTokenUsage,
  replaceMemories,
  resolvePersonaForPeer,
  resolvePersonaUpstream,
  touchPeerActivity,
  touchPeerActivityFrom,
  writeAudit,
} from "@wechat-ai/db";
import {
  LlmClient,
  WebSearchClient,
  type BuiltinToolName,
  type ChatCallOptions,
  type LlmUpstream,
} from "@wechat-ai/llm";
import {
  buildChatMessages,
  buildImageCaptionMessages,
  buildMemoryExtractMessages,
  buildProactiveMessages,
  describeAttachments,
  parseFactsJson,
  parseProactiveSkip,
  type PromptAttachment,
  type BatchPromptItem,
} from "./prompt.js";
import type { AdaptiveReplyPlan } from "./adaptive-reply-plan.js";
import {
  parseMultiBubbleReply,
  type ReplyPart,
} from "./reply-format.js";
import { dropDisallowedStickers, ReplyFilter } from "./reply-filter.js";
import {
  normalizeFactList,
  selectMemoriesForPrompt,
} from "./memory-retrieve.js";
import { ChatflowEngine } from "./chatflow/engine.js";
import {
  buildConversationQualityRepairInstruction,
  inspectConversationQuality,
  planConversationQuality,
  resolveConversationQualitySettings,
  type ConversationQualityPlan,
  type ConversationQualitySettings,
} from "./conversation-quality.js";

export interface ChatServiceOptions {
  shortHistoryLimit: number;
  memoryExtractEveryN: number;
  allowUnapproved: boolean;
  unapprovedReply: string;
  noPersonaReply: string;
  /** Ask model to return multi-bubble JSON (default true; ignored when replyFilterEnabled) */
  multiBubbleJson?: boolean;
  maxReplyBubbles?: number;
  /** Soft max chars per WeChat bubble when re-splitting (default 72) */
  maxChunkChars?: number;
  /** Max stickers in one reply (default 2) */
  maxStickersPerReply?: number;
  /** Inject sticker catalog into system prompt (default true) */
  stickersEnabled?: boolean;
  /**
   * Second-pass AI filter: reformat primary reply into multi-bubble JSON before send.
   * When true, primary model does not receive REPLY_FORMAT_INSTRUCTION.
   * Default false (primary model must emit multi-bubble JSON itself).
   */
  replyFilterEnabled?: boolean;
  /** Max memories injected when total exceeds fullInjectMax (default 12) */
  memoryTopK?: number;
  /** Inject all memories when count ≤ this (default 20) */
  memoryFullInjectMax?: number;
  /** Hard cap stored facts per peer+persona (default 100) */
  memoryMaxItems?: number;
  /** Allow model to call get_current_time (default true) */
  timeToolEnabled?: boolean;
  /** Default IANA timezone for get_current_time (default Asia/Shanghai) */
  timeToolTimeZone?: string;
  /**
   * Global web search switch. Persona must also have web_search_enabled.
   * Search always goes through tools gateway (never main-site DDG).
   */
  webSearchEnabled?: boolean;
  /** Default result count for the web_search tool (default 5) */
  webSearchMaxResults?: number;
  toolsBaseUrl?: string;
  toolsApiKey?: string;
  /** Wall clock for one tools-gateway search call */
  toolsTimeoutMs?: number;
  /** Decrypt user custom LLM keys; required for persona llm_provider_id */
  llmProviderSecret?: string;
  /** Host allowlist for chatflow http nodes (plus tools host) */
  chatflowHttpAllowHosts?: string[];
  chatflowMaxSteps?: number;
  chatflowMaxNodes?: number;
  /**
   * How an attached image reaches the conversation.
   *
   * `caption` (default): describe it with `visionLlm` and pass only that text on,
   * so the roleplay model needs no multimodal support. `direct`: hand the image
   * to the roleplay model itself, which must then be vision-capable.
   */
  visionMode?: "caption" | "direct";
  /**
   * Model id for the vision call. Required for either mode to do anything —
   * without it there is nothing that can read an image.
   */
  visionModel?: string;
  /** Cap on caption length */
  visionCaptionMaxTokens?: number;
  conversationQuality?: Partial<ConversationQualitySettings>;
  /** Absolute cap for history loaded to satisfy quality windows. */
  historySafetyCap?: number;
}

export interface InboundChatRequest {
  botAccountId: string;
  peerId: string;
  text: string;
  contextToken: string;
  /**
   * Media the user attached. Entries with a `dataUri` are handed to the model as
   * content parts; the rest only appear in the attachment notice so the persona
   * can say it cannot see them instead of inventing contents.
   */
  attachments?: PromptAttachment[];
  /** Ordered boundaries of an adaptive batch; omitted for legacy single turns. */
  batchItems?: BatchPromptItem[];
  replyPlan?: AdaptiveReplyPlan;
}

export interface ProactiveChatRequest {
  botAccountId: string;
  peerId: string;
  contextToken: string;
  /** Approximate idle hours for prompt (from scheduler) */
  idleHours: number;
}

export interface InboundChatResult {
  kind: "reply" | "reject" | "skip";
  /** Joined plain text (for reject or single-shot) */
  text?: string;
  /** Ordered WeChat bubbles (roleplay reply) — legacy text view */
  bubbles?: string[];
  /** Structured parts for mixed text/sticker send */
  parts?: ReplyPart[];
  /** Whether bubbles came from model JSON */
  bubblesFromJson?: boolean;
  personaId?: string;
  personaSlug?: string;
  /** Owner of the bot — saves the worker a second getBotAccount per message */
  ownerUserId?: string;
  /** Present when kind=skip (proactive model declined) */
  skipReason?: string;
  /** Effective deterministic plan for this normal prompt-mode turn. */
  qualityPlan?: ConversationQualityPlan;
}

const DEFAULTS: ChatServiceOptions = {
  shortHistoryLimit: 20,
  memoryExtractEveryN: 8,
  allowUnapproved: false,
  unapprovedReply:
    "账号尚未开通对话权限。请前往网页端批准对话权限！\n（此项目为公益免费项目！使用文档：应用网址/docs）",
  noPersonaReply: "系统尚未配置默认人设，请管理员先创建并设置默认角色。",
  multiBubbleJson: true,
  maxReplyBubbles: 5,
  maxChunkChars: 72,
  maxStickersPerReply: 2,
  stickersEnabled: true,
  replyFilterEnabled: false,
  memoryTopK: 12,
  memoryFullInjectMax: 20,
  memoryMaxItems: 100,
  timeToolEnabled: true,
  timeToolTimeZone: "Asia/Shanghai",
  webSearchEnabled: false,
  webSearchMaxResults: 5,
  visionMode: "caption",
  visionCaptionMaxTokens: 300,
  conversationQuality: {},
  historySafetyCap: 100,
};

function renderBatchHistory(items: readonly BatchPromptItem[]): string {
  return items
    .map((item, index) => {
      const content = describeAttachments(item.text, item.attachments);
      return `[消息 ${index + 1}/${items.length} · ${item.id}]\n${content}`.trimEnd();
    })
    .join("\n\n");
}

export class ChatService {
  private opts: ChatServiceOptions;
  private replyFilter: ReplyFilter;
  private webSearch: WebSearchClient | null = null;
  /** Identity of the tools config the current webSearch client was built from. */
  private webSearchKey = "";
  private chatflow: ChatflowEngine;

  constructor(
    private db: Db,
    private llm: LlmClient,
    opts: Partial<ChatServiceOptions> = {},
    /**
     * Vision endpoint for reading images. Separate client because the roleplay
     * model is usually text-only — see ChatServiceOptions.visionMode.
     */
    private visionLlm: LlmClient | null = null,
  ) {
    this.opts = { ...DEFAULTS, ...opts };
    this.replyFilter = new ReplyFilter(llm, {
      enabled: this.opts.replyFilterEnabled === true,
    });
    this.syncWebSearch();
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

  /** Cheap system-only gate so the worker can keep rejects outside batching. */
  async preflightInbound(
    req: Pick<InboundChatRequest, "botAccountId" | "peerId" | "text">,
  ): Promise<InboundChatResult | null> {
    const peer = await ensurePeer(this.db, req.botAccountId, req.peerId);
    return this.inboundGate(peer, req.text);
  }

  private inboundGate(
    peer: { approved: number },
    text: string,
  ): InboundChatResult | null {
    if (!peer.approved && !this.opts.allowUnapproved) {
      return { kind: "reject", text: this.opts.unapprovedReply };
    }
    if (/^\s*\/角色/.test(text)) {
      return {
        kind: "reply",
        text: "角色切换仅支持机器人主人在后台分配，暂不支持用户自助 /角色 命令。",
      };
    }
    return null;
  }

  /**
   * Rebuild the search client only when the tools config actually changed.
   *
   * Built lazily rather than once in the constructor so that turning
   * WEB_SEARCH on (or filling in TOOLS_BASE_URL) from the admin panel does not
   * leave a permanently search-less process behind.
   */
  private syncWebSearch(): void {
    const key =
      this.opts.webSearchEnabled && this.opts.toolsBaseUrl
        ? [
            this.opts.toolsBaseUrl,
            this.opts.toolsApiKey ?? "",
            this.opts.toolsTimeoutMs ?? "",
          ].join("|")
        : "";
    if (key === this.webSearchKey) return;
    this.webSearchKey = key;
    this.webSearch = key
      ? new WebSearchClient({
          toolsBaseUrl: this.opts.toolsBaseUrl!,
          toolsApiKey: this.opts.toolsApiKey || "",
          timeoutMs: this.opts.toolsTimeoutMs,
        })
      : null;
  }

  /**
   * Apply admin-editable settings in place (runtime settings reload).
   * Only the keys present in `patch` are touched.
   */
  applyRuntimeOptions(patch: Partial<ChatServiceOptions>): void {
    const qualityPatch = patch.conversationQuality;
    const previousQuality = this.opts.conversationQuality;
    Object.assign(this.opts, patch);
    if (qualityPatch) {
      this.opts.conversationQuality = {
        ...previousQuality,
        ...qualityPatch,
      };
    }
    if ("replyFilterEnabled" in patch) {
      this.replyFilter.setEnabled(this.opts.replyFilterEnabled === true);
    }
    this.syncWebSearch();
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

  /**
   * Resolve LLM call options for a persona:
   * - platform LLM: direct via this.llm
   * - user custom: LlmClient.forUserUpstream → HF tools only
   */
  private async resolveChatClient(params: {
    persona: { llm_provider_id?: string | null; web_search_enabled?: number };
    ownerUserId?: string | null;
  }): Promise<{
    client: LlmClient;
    callOpts: ChatCallOptions;
  }> {
    const tools: BuiltinToolName[] = [];
    if (this.opts.timeToolEnabled !== false) {
      tools.push("get_current_time");
    }
    const wantSearch =
      this.opts.webSearchEnabled === true &&
      Boolean(params.persona.web_search_enabled) &&
      this.webSearch;
    if (wantSearch) {
      tools.push("web_search");
    }

    const callOpts: ChatCallOptions = {
      tools,
      timeZone: this.opts.timeToolTimeZone || "Asia/Shanghai",
    };
    if (wantSearch && this.webSearch) {
      const ws = this.webSearch;
      const defaultMax = this.opts.webSearchMaxResults ?? 5;
      callOpts.webSearch = (query, maxResults) =>
        ws.searchAsToolResult(query, maxResults ?? defaultMax);
    }

    const secret = this.opts.llmProviderSecret || "";
    let upstream: LlmUpstream | null = null;
    if (secret && params.persona.llm_provider_id) {
      const resolved = await resolvePersonaUpstream(this.db, {
        llmProviderId: params.persona.llm_provider_id,
        ownerUserId: params.ownerUserId,
        secret,
      });
      if (resolved) {
        upstream = {
          baseUrl: resolved.baseUrl,
          apiKey: resolved.apiKey,
          model: resolved.model,
        };
      }
    }

    if (upstream) {
      if (!this.opts.toolsBaseUrl || !this.opts.toolsApiKey) {
        throw new Error(
          "User custom LLM requires TOOLS_BASE_URL and TOOLS_API_KEY (HF tools gateway)",
        );
      }
      const client = LlmClient.forUserUpstream({
        toolsBaseUrl: this.opts.toolsBaseUrl,
        toolsApiKey: this.opts.toolsApiKey,
        upstream,
      });
      return { client, callOpts };
    }

    return { client: this.llm, callOpts };
  }

  /** When filter is on, primary model should not emit send-plan JSON. */
  private primaryMultiBubbleJson(): boolean {
    if (this.opts.replyFilterEnabled === true) return false;
    return this.opts.multiBubbleJson !== false;
  }

  /**
   * Second-pass filter (or legacy parse) → structured parts for WeChat send.
   * Records filter token usage when the filter LLM ran.
   */
  /** Public deterministic seam shared by adaptive handling and contract tests. */
  async finalizeReplyParts(params: {
    rawLlmText: string;
    stickers: StickerPromptEntry[];
    botAccountId: string;
    adaptive?: boolean;
    ownerUserId?: string | null;
    ownerUsername?: string;
    botName?: string | null;
  }): Promise<{
    parts: ReplyPart[];
    bubbles: string[];
    displayText: string;
    bubblesFromJson: boolean;
  }> {
    const configuredMaxBubbles = this.opts.maxReplyBubbles ?? 5;
    const maxBubbles = params.adaptive
      ? Math.min(4, configuredMaxBubbles)
      : configuredMaxBubbles;
    const maxChunkChars = this.opts.maxChunkChars ?? 72;
    const maxStickers = this.opts.maxStickersPerReply ?? 2;
    const raw = (params.rawLlmText ?? "").trim();

    if (this.opts.replyFilterEnabled === true) {
      const filtered = await this.replyFilter.filter({
        rawText: raw,
        allowedStickerSlugs: params.stickers.map((s) => s.slug),
        maxBubbles,
        maxChunkChars,
        maxStickers,
      });
      if (filtered.promptTokens > 0 || filtered.completionTokens > 0) {
        await recordTokenUsage(this.db, {
          userId: params.ownerUserId ?? undefined,
          botId: params.botAccountId,
          promptTokens: filtered.promptTokens,
          completionTokens: filtered.completionTokens,
          username: params.ownerUsername,
          botName: params.botName ?? undefined,
        });
      }
      if (
        params.adaptive &&
        filtered.parts.length === 1 &&
        filtered.parts[0]?.kind === "text"
      ) {
        const envelope = parseMultiBubbleReply(filtered.parts[0].text, {
          maxBubbles,
          maxChunkChars,
          maxStickers,
          fallbackSplit: true,
          expandLongBubbles: true,
        });
        if (envelope.fromJson && envelope.parts.length === 0) {
          return {
            parts: [],
            bubbles: [],
            displayText: "",
            bubblesFromJson: true,
          };
        }
      }
      // ReplyFilter owns fallback parsing. An empty result can be an
      // authoritative send-plan decision, so raw primary text must not revive
      // it here.
      const parts = filtered.parts;
      const bubbles =
        filtered.bubbles.length > 0
          ? filtered.bubbles
          : parts.map((p) =>
              p.kind === "text" ? p.text : `[表情:${p.slug}]`,
            );
      const displayText = filtered.displayText || bubbles.join("\n");
      return {
        parts,
        bubbles,
        displayText,
        bubblesFromJson: filtered.fromFilterJson,
      };
    }

    const parsed = parseMultiBubbleReply(raw, {
      maxBubbles,
      maxChunkChars,
      maxStickers,
      fallbackSplit: true,
      expandLongBubbles: true,
    });
    const allowedSlugs = params.stickers.map((s) => s.slug);
    // `raw` is only a safe fallback when it was not a recognised JSON envelope.
    // Otherwise "the reply reduced to nothing" would be answered by sending
    // `{"messages":[…]}` to the user verbatim — say nothing instead.
    const rawFallback: ReplyPart[] =
      !parsed.fromJson && raw ? [{ kind: "text" as const, text: raw }] : [];
    let parts = parsed.parts.length > 0 ? parsed.parts : rawFallback;
    // Drop invented / unknown sticker slugs (same rule as ReplyFilter path)
    parts = dropDisallowedStickers(parts, allowedSlugs);
    if (!parts.length) parts = rawFallback;
    const bubbles = parts.map((p) =>
      p.kind === "text" ? p.text : `[表情:${p.slug}]`,
    );
    const displayText = bubbles.join("\n");
    return {
      parts,
      bubbles,
      displayText,
      bubblesFromJson: parsed.fromJson,
    };
  }

  /** Swap in a vision client at runtime (settings reload). */
  setVisionClient(client: LlmClient | null): void {
    this.visionLlm = client;
  }

  /**
   * Caption mode: describe each attached image with the vision endpoint and
   * hand the roleplay model text instead of bytes.
   *
   * The returned attachments carry `caption` and have `dataUri` cleared — the
   * roleplay model must not receive image parts it cannot parse. Failures
   * degrade to a notice-only attachment rather than failing the turn: a flaky
   * captioner should cost the user a description, not their reply.
   *
   * Token cost is billed to the bot owner like any other call.
   */
  private async captionAttachments(params: {
    attachments: PromptAttachment[];
    userText: string;
    botAccountId: string;
    ownerUserId?: string | null;
    ownerUsername?: string;
    botName?: string | null;
  }): Promise<PromptAttachment[]> {
    const vision = this.visionLlm;
    const model = this.opts.visionModel?.trim();
    if (!vision || !model) {
      // Nothing can read the image — drop the bytes so the prompt tells the
      // persona it cannot see it, instead of shipping an unusable data URI.
      return params.attachments.map((a) =>
        a.dataUri ? { ...a, dataUri: undefined } : a,
      );
    }

    let promptTokens = 0;
    let completionTokens = 0;
    const out = await Promise.all(
      params.attachments.map(async (a) => {
        if (!a.dataUri) return a;
        try {
          const res = await vision.chatWithUsage(
            buildImageCaptionMessages({
              dataUri: a.dataUri,
              userText: params.userText,
            }),
            {
              model,
              tools: [],
              maxToolRounds: 0,
              maxTokens: this.opts.visionCaptionMaxTokens,
            },
          );
          promptTokens += res.promptTokens;
          completionTokens += res.completionTokens;
          const caption = res.text.trim();
          return {
            ...a,
            dataUri: undefined,
            caption: caption || undefined,
          } satisfies PromptAttachment;
        } catch (err) {
          console.error(
            `[vision] caption failed bot=${params.botAccountId}: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
          return { ...a, dataUri: undefined };
        }
      }),
    );

    if (promptTokens > 0 || completionTokens > 0) {
      await recordTokenUsage(this.db, {
        userId: params.ownerUserId ?? undefined,
        botId: params.botAccountId,
        promptTokens,
        completionTokens,
        username: params.ownerUsername,
        botName: params.botName ?? undefined,
      });
    }
    return out;
  }

  async handleInbound(req: InboundChatRequest): Promise<InboundChatResult> {
    const peer = await ensurePeer(this.db, req.botAccountId, req.peerId);
    // NOTE: no upsertContextToken here — BotWorkerManager.handleJob already
    // wrote the identical key/value, and it does so *before* the rate-limit
    // early-return and the P2P intercept. Writing it again here would be a
    // duplicate RTT on every message; removing the worker's copy instead would
    // leave throttled / P2P peers with a stale token (breaking proactive and
    // P2P delivery), so the worker keeps ownership of this write.

    const gate = this.inboundGate(peer, req.text);
    if (gate) return gate;

    const persona = await resolvePersonaForPeer(
      this.db,
      req.botAccountId,
      req.peerId,
    );
    if (!persona) {
      return { kind: "reject", text: this.opts.noPersonaReply };
    }

    const qualitySettings = resolveConversationQualitySettings(
      this.opts.conversationQuality,
    );
    const qualityHistoryLimit = Math.min(
      this.opts.historySafetyCap ?? 100,
      Math.max(
        this.opts.shortHistoryLimit,
        qualitySettings.repetitionWindowAssistantTurns * 2,
      ),
    );
    // Parallelize independent Redis reads (critical on remote Redis / Upstash)
    const [systemPrompt, bot, history, memories] = await Promise.all([
      getPublishedPrompt(this.db, persona.id),
      getBotAccount(this.db, req.botAccountId),
      listRecentMessages(
        this.db,
        req.botAccountId,
        req.peerId,
        qualityHistoryLimit,
        persona.id,
      ),
      listMemories(this.db, req.botAccountId, req.peerId, persona.id),
    ]);
    if (!systemPrompt) {
      return { kind: "reject", text: this.opts.noPersonaReply };
    }

    const botName = bot?.display_name?.trim() || "助手";
    const owner = bot?.owner_user_id
      ? await getUser(this.db, bot.owner_user_id)
      : undefined;

    // Caption mode turns the image into text here, before anything else reads
    // the attachments — so history, memory retrieval and the roleplay prompt all
    // see the description rather than an opaque placeholder.
    let batchItems = req.batchItems?.map((item) => ({
      ...item,
      attachments: [...item.attachments],
    }));
    let attachments = batchItems?.length
      ? batchItems.flatMap((item) => item.attachments)
      : req.attachments ?? [];
    if (
      this.opts.visionMode !== "direct" &&
      attachments.some((a) => a.dataUri)
    ) {
      if (batchItems?.length) {
        for (const item of batchItems) {
          item.attachments = await this.captionAttachments({
            attachments: item.attachments,
            userText: item.text,
            botAccountId: req.botAccountId,
            ownerUserId: bot?.owner_user_id,
            ownerUsername: owner?.username,
            botName: bot?.display_name,
          });
        }
        attachments = batchItems.flatMap((item) => item.attachments);
      } else {
        attachments = await this.captionAttachments({
          attachments,
          userText: req.text,
          botAccountId: req.botAccountId,
          ownerUserId: bot?.owner_user_id,
          ownerUsername: owner?.username,
          botName: bot?.display_name,
        });
      }
    }
    // The media bytes are never persisted, so this described text is the only
    // trace a later turn can see.
    const historyText = batchItems?.length
      ? renderBatchHistory(batchItems)
      : describeAttachments(req.text, attachments);

    const [userMsg, , stickers] = await Promise.all([
      insertMessage(this.db, {
        botAccountId: req.botAccountId,
        peerId: req.peerId,
        personaId: persona.id,
        role: "user",
        content: historyText,
        contextToken: req.contextToken,
      }),
      // `peer` is already loaded — skip the read half of the read-modify-write
      touchPeerActivityFrom(this.db, peer),
      this.opts.stickersEnabled === false || !bot?.owner_user_id
        ? Promise.resolve([])
        : listStickersForOwnerPrompt(this.db, bot.owner_user_id),
    ]);
    // INCR reply from the insert above — no extra GET needed to decide on
    // memory extraction further down.
    const userMsgCount = userMsg.user_count ?? 0;

    const queryText = [
      historyText,
      ...history
        .slice(-4)
        .map((m) => m.content)
        .filter(Boolean),
    ].join("\n");
    const selectedMemories = selectMemoriesForPrompt(memories, queryText, {
      topK: this.opts.memoryTopK,
      fullInjectMax: this.opts.memoryFullInjectMax,
    });

    // `owner` was already resolved above the caption step (it bills the caption
    // call), so there is no second lookup here.

    let rawLlmText: string;
    let promptTokens = 0;
    let completionTokens = 0;
    let qualityPlan: ConversationQualityPlan | undefined;
    let qualityMessages: ReturnType<typeof buildChatMessages> | undefined;
    let qualityClient: LlmClient | undefined;
    let qualityCallOpts: ChatCallOptions | undefined;

    if (persona.mode === "chatflow") {
      // Chatflow MVP: proactive path still uses prompt mode elsewhere;
      // inbound uses graph. Disable proactive separately at scheduler.
      const graph = await getPublishedGraph(this.db, persona.id);
      const secret = this.opts.llmProviderSecret || "";
      let upstream: LlmUpstream | null = null;
      if (secret && persona.llm_provider_id) {
        const resolved = await resolvePersonaUpstream(this.db, {
          llmProviderId: persona.llm_provider_id,
          ownerUserId: bot?.owner_user_id,
          secret,
        });
        if (resolved) {
          upstream = {
            baseUrl: resolved.baseUrl,
            apiKey: resolved.apiKey,
            model: resolved.model,
          };
        }
      }
      const cf = await this.chatflow.run(graph, {
        // The graph engine has no multimodal node, so a chatflow persona sees
        // the `[图片]` placeholder rather than the image itself.
        userText: historyText,
        botName,
        systemPrompt,
        history: history.map((m) => ({ role: m.role, content: m.content })),
        memories: selectedMemories.map((m) => m.content),
        webSearchEnabled: Boolean(persona.web_search_enabled),
        upstream,
      });
      rawLlmText = cf.text;
      promptTokens = cf.promptTokens;
      completionTokens = cf.completionTokens;
    } else {
      const qualityTopics = batchItems?.length
        ? batchItems.map((item) => {
            const adaptiveItem = req.replyPlan?.items.find(
              (planned) => planned.id === item.id,
            );
            return {
              id: item.id,
              text: item.text,
              hasAttachments: item.attachments.length > 0,
              replyObligation: adaptiveItem?.replyObligation,
              protectedObligation:
                adaptiveItem?.kind === "new-question-or-request" ||
                adaptiveItem?.kind === "emotional-bid" ||
                adaptiveItem?.kind === "correction",
            };
          })
        : [{ id: "turn", text: req.text, hasAttachments: attachments.length > 0 }];
      const stableTurnKey = [
        req.botAccountId,
        req.peerId,
        ...qualityTopics.map((topic) => `${topic.id}:${topic.text}`),
      ].join("\u0000");
      const conversationQualityPlan = planConversationQuality({
        stableTurnKey,
        topics: qualityTopics,
        settings: qualitySettings,
      });
      const messages = buildChatMessages({
        systemPrompt,
        memories: selectedMemories,
        history,
        userText: req.text,
        botName,
        multiBubbleJson: this.primaryMultiBubbleJson(),
        stickers,
        timeToolEnabled: this.opts.timeToolEnabled !== false,
        attachments,
        batchItems,
        adaptiveReplyPlan:
          req.replyPlan?.decision === "reply"
            ? {
                targetPartCount: req.replyPlan.targetPartCount,
                coveredItemIds: req.replyPlan.coveredItemIds,
              }
            : undefined,
        conversationQualityPlan,
      });

      const { client: chatClient, callOpts } = await this.resolveChatClient({
        persona,
        ownerUserId: bot?.owner_user_id,
      });
      // Route the turn to the vision model only when the model actually gets an
      // image; text turns must keep using the persona's normal model.
      const visionModel = this.opts.visionModel?.trim();
      if (visionModel && attachments.some((a) => a.dataUri)) {
        callOpts.model = visionModel;
      }
      qualityPlan = conversationQualityPlan;
      qualityMessages = messages;
      qualityClient = chatClient;
      qualityCallOpts = callOpts;
      const usage = await chatClient.chatWithUsage(messages, callOpts);
      rawLlmText = usage.text;
      promptTokens = usage.promptTokens;
      completionTokens = usage.completionTokens;
    }

    let finalized = await this.finalizeReplyParts({
      rawLlmText,
      stickers,
      botAccountId: req.botAccountId,
      adaptive: Boolean(req.replyPlan),
      ownerUserId: bot?.owner_user_id,
      ownerUsername: owner?.username,
      botName: bot?.display_name,
    });
    if (qualityPlan && qualityMessages && qualityClient && qualityCallOpts) {
      const recentAssistantTexts = history
        .filter((message) => message.role === "assistant")
        .map((message) => message.content);
      const violations = inspectConversationQuality({
        visibleText: finalized.displayText,
        plan: qualityPlan,
        recentAssistantTexts,
      });
      if (violations.length > 0) {
        try {
          const repairUsage = await qualityClient.chatWithUsage(
            [
              ...qualityMessages,
              { role: "assistant", content: rawLlmText },
              {
                role: "user",
                content: buildConversationQualityRepairInstruction(
                  qualityPlan,
                  violations,
                ),
              },
            ],
            qualityCallOpts,
          );
          promptTokens += repairUsage.promptTokens;
          completionTokens += repairUsage.completionTokens;
          const repaired = await this.finalizeReplyParts({
            rawLlmText: repairUsage.text,
            stickers,
            botAccountId: req.botAccountId,
            adaptive: Boolean(req.replyPlan),
            ownerUserId: bot?.owner_user_id,
            ownerUsername: owner?.username,
            botName: bot?.display_name,
          });
          const repairViolations = inspectConversationQuality({
            visibleText: repaired.displayText,
            plan: qualityPlan,
            recentAssistantTexts,
          });
          if (repairViolations.length === 0) finalized = repaired;
        } catch (error) {
          console.error(
            `[quality] bounded repair failed bot=${req.botAccountId}: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      }
    }
    const { parts, bubbles, displayText, bubblesFromJson } = finalized;

    if (qualityPlan) {
      const remainingViolations = inspectConversationQuality({
        visibleText: displayText,
        plan: qualityPlan,
        recentAssistantTexts: history
          .filter((message) => message.role === "assistant")
          .map((message) => message.content),
      });
      if (remainingViolations.length > 0) {
        await recordTokenUsage(this.db, {
          userId: bot?.owner_user_id,
          botId: req.botAccountId,
          promptTokens,
          completionTokens,
          username: owner?.username,
          botName: bot?.display_name,
        });
        return {
          kind: "skip",
          skipReason: "quality_check_failed",
          personaId: persona.id,
          personaSlug: persona.slug,
          qualityPlan,
        };
      }
    }

    // Fail closed before storing or sending an assistant turn. Keep the
    // adaptive skip contract unchanged; legacy callers use the same empty
    // reason as proactive callers and still account for the primary LLM call.
    if (parts.length === 0 || !displayText.trim()) {
      if (req.replyPlan) {
        return { kind: "skip", skipReason: "invalid_reply_plan" };
      }
      await recordTokenUsage(this.db, {
        userId: bot?.owner_user_id,
        botId: req.botAccountId,
        promptTokens,
        completionTokens,
        username: owner?.username,
        botName: bot?.display_name,
      });
      return {
        kind: "skip",
        skipReason: "empty_reply",
        personaId: persona.id,
        personaSlug: persona.slug,
      };
    }

    // Everything left is independent bookkeeping — one wave, not four.
    // This runs between "model produced text" and "first bubble sent", so each
    // serialized round trip here is latency the user feels. Still awaited:
    // the next message on this peer reads history to build its prompt, so a
    // floating insertMessage would drop this turn out of context.
    await Promise.all([
      recordTokenUsage(this.db, {
        userId: bot?.owner_user_id,
        botId: req.botAccountId,
        promptTokens,
        completionTokens,
        username: owner?.username,
        botName: bot?.display_name,
      }),
      // Store plain bubbles text in history (never raw JSON wrapper)
      insertMessage(this.db, {
        botAccountId: req.botAccountId,
        peerId: req.peerId,
        personaId: persona.id,
        role: "assistant",
        content: displayText,
        contextToken: req.contextToken,
      }),
      // Re-read here, unlike the pre-LLM touch: `peer` was loaded before the
      // model call, so writing it back whole could revert an approve /
      // proactive toggle the owner made during those seconds.
      touchPeerActivity(this.db, req.botAccountId, req.peerId),
    ]);

    if (
      userMsgCount > 0 &&
      userMsgCount % this.opts.memoryExtractEveryN === 0
    ) {
      void this.extractMemory(req.botAccountId, req.peerId, persona.id).catch(
        (err) => {
          console.error("[memory] extract failed", err);
        },
      );
    }

    return {
      kind: "reply",
      text: displayText,
      bubbles,
      parts,
      bubblesFromJson,
      personaId: persona.id,
      personaSlug: persona.slug,
      ownerUserId: bot?.owner_user_id,
      qualityPlan,
    };
  }

  /**
   * Generate a proactive message when the peer has been idle.
   * Does not insert a user message. May return kind=skip if the model declines.
   */
  async handleProactive(req: ProactiveChatRequest): Promise<InboundChatResult> {
    const peer = await ensurePeer(this.db, req.botAccountId, req.peerId);
    if (!peer.approved && !this.opts.allowUnapproved) {
      return { kind: "reject", text: this.opts.unapprovedReply };
    }
    if (!peer.proactive_enabled) {
      return { kind: "skip", skipReason: "peer_off" };
    }

    const persona = await resolvePersonaForPeer(
      this.db,
      req.botAccountId,
      req.peerId,
    );
    if (!persona) {
      return { kind: "reject", text: this.opts.noPersonaReply };
    }
    // Chatflow MVP: proactive outreach only supported for classic prompt mode
    if (persona.mode === "chatflow") {
      return { kind: "skip", skipReason: "chatflow_no_proactive" };
    }

    const [systemPrompt, bot, history, memories] = await Promise.all([
      getPublishedPrompt(this.db, persona.id),
      getBotAccount(this.db, req.botAccountId),
      listRecentMessages(
        this.db,
        req.botAccountId,
        req.peerId,
        this.opts.shortHistoryLimit,
        persona.id,
      ),
      listMemories(this.db, req.botAccountId, req.peerId, persona.id),
    ]);
    if (!systemPrompt) {
      return { kind: "reject", text: this.opts.noPersonaReply };
    }

    const botName = bot?.display_name?.trim() || "助手";
    const stickers =
      this.opts.stickersEnabled === false || !bot?.owner_user_id
        ? []
        : await listStickersForOwnerPrompt(this.db, bot.owner_user_id);

    const proactiveQuery = history
      .slice(-6)
      .map((m) => m.content)
      .filter(Boolean)
      .join("\n");
    const selectedMemories = selectMemoriesForPrompt(
      memories,
      proactiveQuery || "主动联系",
      {
        topK: this.opts.memoryTopK,
        fullInjectMax: this.opts.memoryFullInjectMax,
      },
    );

    const messages = buildProactiveMessages({
      systemPrompt,
      memories: selectedMemories,
      history,
      idleHours: req.idleHours,
      botName,
      multiBubbleJson: this.primaryMultiBubbleJson(),
      stickers,
      timeToolEnabled: this.opts.timeToolEnabled !== false,
    });

    const { client: chatClient, callOpts } = await this.resolveChatClient({
      persona,
      ownerUserId: bot?.owner_user_id,
    });
    // Proactive: keep tools minimal (no web search spam)
    callOpts.tools = (callOpts.tools || []).filter((t) => t !== "web_search");
    callOpts.webSearch = undefined;
    const usage = await chatClient.chatWithUsage(messages, callOpts);

    const owner = bot?.owner_user_id
      ? await getUser(this.db, bot.owner_user_id)
      : undefined;
    await recordTokenUsage(this.db, {
      userId: bot?.owner_user_id,
      botId: req.botAccountId,
      promptTokens: usage.promptTokens,
      completionTokens: usage.completionTokens,
      username: owner?.username,
      botName: bot?.display_name,
    });

    const skip = parseProactiveSkip(usage.text);
    if (skip.skip) {
      return {
        kind: "skip",
        skipReason: skip.reason ?? "model_skip",
        personaId: persona.id,
        personaSlug: persona.slug,
      };
    }

    const finalized = await this.finalizeReplyParts({
      rawLlmText: usage.text,
      stickers,
      botAccountId: req.botAccountId,
      ownerUserId: bot?.owner_user_id,
      ownerUsername: owner?.username,
      botName: bot?.display_name,
    });
    const parts = finalized.parts;
    const bubbles = finalized.bubbles;
    const displayText = finalized.displayText.trim();
    if (!displayText) {
      return {
        kind: "skip",
        skipReason: "empty_reply",
        personaId: persona.id,
        personaSlug: persona.slug,
      };
    }

    await insertMessage(this.db, {
      botAccountId: req.botAccountId,
      peerId: req.peerId,
      personaId: persona.id,
      role: "assistant",
      content: displayText,
      contextToken: req.contextToken,
    });
    await touchPeerActivity(this.db, req.botAccountId, req.peerId);

    return {
      kind: "reply",
      text: displayText,
      bubbles,
      parts,
      bubblesFromJson: finalized.bubblesFromJson,
      personaId: persona.id,
      personaSlug: persona.slug,
    };
  }

  async extractMemory(
    botAccountId: string,
    peerId: string,
    personaId: string,
  ): Promise<void> {
    const history = await listRecentMessages(
      this.db,
      botAccountId,
      peerId,
      30,
      personaId,
    );
    const existing = await listMemories(
      this.db,
      botAccountId,
      peerId,
      personaId,
    );
    const msgs = buildMemoryExtractMessages({ history, existing });
    const raw = await this.llm.chatWithUsage(msgs);
    const parsed = parseFactsJson(raw.text);
    // Merge with existing so extraction can keep prior facts the model omitted
    const merged = normalizeFactList(
      [...existing.map((m) => m.content), ...parsed],
      this.opts.memoryMaxItems ?? 100,
    );
    const bot = await getBotAccount(this.db, botAccountId);
    await recordTokenUsage(this.db, {
      userId: bot?.owner_user_id,
      botId: botAccountId,
      promptTokens: raw.promptTokens,
      completionTokens: raw.completionTokens,
      botName: bot?.display_name,
    });
    if (merged.length) {
      await replaceMemories(this.db, botAccountId, peerId, personaId, merged, {
        maxItems: this.opts.memoryMaxItems ?? 100,
      });
      await writeAudit(this.db, "memory_extracted", "system", {
        botAccountId,
        peerId,
        personaId,
        count: merged.length,
      });
    }
  }

  async resetMemory(
    botAccountId: string,
    peerId: string,
    personaId?: string,
  ): Promise<void> {
    await clearMemories(this.db, botAccountId, peerId, personaId);
    await writeAudit(this.db, "memory_reset", "admin", {
      botAccountId,
      peerId,
      personaId,
    });
  }
}
