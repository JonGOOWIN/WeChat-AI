import {
  LlmClient,
  WebSearchClient,
  type LlmUpstream,
} from "@wechat-ai/llm";
import { createDefaultChatflowGraph } from "./default-graph.js";
import {
  ChatflowError,
  type ChatflowGraph,
  type ChatflowNodeBase,
  type ChatflowRunInput,
  type ChatflowRunResult,
} from "./types.js";
import {
  evalCondition,
  renderTemplate,
  validateChatflowGraph,
} from "./validate.js";
import {
  ALLOW_ANY_HOST,
  allowsAnyHost,
  blockedHostReason,
  blockedResolvedReason,
  normalizeHost,
} from "./http-guard.js";
import { buildConversationQualityBlock } from "../prompt.js";

/** Wall clock for one http node. Tools gateway calls are the only sanctioned target. */
const HTTP_NODE_TIMEOUT_MS = Number(
  process.env.CHATFLOW_HTTP_TIMEOUT_MS ?? "15000",
);

/** Redirect hops an http node may take. Every hop is re-checked by the guard. */
const HTTP_NODE_MAX_REDIRECTS = 3;

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export interface ChatflowEngineOptions {
  /** Platform LLM client (admin path; also used when no upstream). */
  platformLlm: LlmClient;
  toolsBaseUrl?: string;
  toolsApiKey?: string;
  webSearchEnabled?: boolean;
  webSearchMaxResults?: number;
  /** Wall clock for one tools-gateway search call */
  toolsTimeoutMs?: number;
  maxSteps?: number;
  maxNodes?: number;
  /**
   * Hostnames allowed for http nodes (default: host of toolsBaseUrl only).
   * Prevents bypass of AI gateway via arbitrary HTTP.
   */
  httpAllowHosts?: string[];
  timeZone?: string;
}

export class ChatflowEngine {
  private opts: Required<
    Pick<
      ChatflowEngineOptions,
      | "maxSteps"
      | "maxNodes"
      | "webSearchEnabled"
      | "webSearchMaxResults"
      | "timeZone"
    >
  > &
    ChatflowEngineOptions;

  constructor(opts: ChatflowEngineOptions) {
    this.opts = {
      ...opts,
      maxSteps: opts.maxSteps ?? 32,
      maxNodes: opts.maxNodes ?? 40,
      webSearchEnabled: opts.webSearchEnabled === true,
      webSearchMaxResults: opts.webSearchMaxResults ?? 5,
      timeZone: opts.timeZone || "Asia/Shanghai",
    };
  }

  /**
   * Merge admin-editable options in place (runtime settings reload).
   * `platformLlm` is intentionally not settable here — swap it via the
   * owning service so every holder is updated together.
   */
  applyOptions(patch: Partial<Omit<ChatflowEngineOptions, "platformLlm">>): void {
    if (patch.toolsBaseUrl !== undefined) this.opts.toolsBaseUrl = patch.toolsBaseUrl;
    if (patch.toolsApiKey !== undefined) this.opts.toolsApiKey = patch.toolsApiKey;
    if (patch.toolsTimeoutMs !== undefined) {
      this.opts.toolsTimeoutMs = patch.toolsTimeoutMs;
    }
    if (patch.webSearchEnabled !== undefined) {
      this.opts.webSearchEnabled = patch.webSearchEnabled === true;
    }
    if (patch.webSearchMaxResults !== undefined) {
      this.opts.webSearchMaxResults = patch.webSearchMaxResults;
    }
    if (patch.maxSteps !== undefined) this.opts.maxSteps = patch.maxSteps;
    if (patch.maxNodes !== undefined) this.opts.maxNodes = patch.maxNodes;
    if (patch.httpAllowHosts !== undefined) {
      this.opts.httpAllowHosts = patch.httpAllowHosts;
    }
    if (patch.timeZone !== undefined) {
      this.opts.timeZone = patch.timeZone || "Asia/Shanghai";
    }
  }

  async run(
    graphRaw: unknown | null | undefined,
    input: ChatflowRunInput,
  ): Promise<ChatflowRunResult> {
    const graph =
      graphRaw && typeof graphRaw === "object"
        ? (graphRaw as ChatflowGraph)
        : createDefaultChatflowGraph();
    const validated = validateChatflowGraph(graph, {
      maxNodes: this.opts.maxNodes,
    });
    const { graph: g, startId } = validated;
    const byId = new Map(g.nodes.map((n) => [n.id, n]));

    const historyText = (input.history || [])
      .map((m) => `${m.role}: ${m.content}`)
      .join("\n")
      .slice(0, 12_000);
    const memoriesText = (input.memories || []).join("\n") || "(无)";

    const vars: Record<string, unknown> = {
      query: input.userText,
      user_input: input.userText,
      bot_name: input.botName,
      system_prompt: input.systemPrompt,
      history: historyText,
      memories: memoriesText,
    };

    let promptTokens = 0;
    let completionTokens = 0;
    const trace: string[] = [];
    let steps = 0;
    let current: string | null = startId;
    let finalAnswer: string | null = null;

    const outgoing = (nodeId: string, handle?: string | null) => {
      const edges = g.edges.filter((e) => e.source === nodeId);
      if (handle) {
        const hit = edges.find(
          (e) => (e.sourceHandle || "true") === handle,
        );
        if (hit) return hit.target;
      }
      const def = edges.find((e) => !e.sourceHandle || e.sourceHandle === "default");
      if (def) return def.target;
      return edges[0]?.target ?? null;
    };

    while (current) {
      steps += 1;
      if (steps > this.opts.maxSteps) {
        throw new ChatflowError(
          "max_steps",
          `chatflow exceeded max steps (${this.opts.maxSteps})`,
        );
      }
      const node = byId.get(current);
      if (!node) {
        throw new ChatflowError("node", `missing node ${current}`);
      }
      trace.push(`enter:${node.type}:${node.id}`);

      if (node.type === "start") {
        current = outgoing(node.id);
        continue;
      }

      if (node.type === "memory") {
        // Re-expose memories (already selected by caller); optional kind filter later
        vars[node.id] = { text: memoriesText, items: input.memories };
        vars.memories = memoriesText;
        current = outgoing(node.id);
        continue;
      }

      if (node.type === "if-else") {
        const cond = String(
          (node.data?.condition as string) ||
            (node.data?.expr as string) ||
            "",
        );
        const ok = evalCondition(renderTemplate(cond, vars), vars);
        vars[node.id] = { result: ok };
        current = outgoing(node.id, ok ? "true" : "false");
        if (!current) {
          current = outgoing(node.id, ok ? "false" : "true");
        }
        continue;
      }

      if (node.type === "search") {
        const q = renderTemplate(
          String((node.data?.query as string) || "{{query}}"),
          vars,
        );
        if (!this.opts.webSearchEnabled || !input.webSearchEnabled) {
          throw new ChatflowError(
            "search_disabled",
            "web search disabled (persona or WEB_SEARCH_ENABLED)",
          );
        }
        if (!this.opts.toolsBaseUrl) {
          throw new ChatflowError(
            "search_disabled",
            "TOOLS_BASE_URL required for search node",
          );
        }
        const client = new WebSearchClient({
          toolsBaseUrl: this.opts.toolsBaseUrl,
          toolsApiKey: this.opts.toolsApiKey || "",
          timeoutMs: this.opts.toolsTimeoutMs,
        });
        const maxR = Number(
          node.data?.max_results ?? this.opts.webSearchMaxResults,
        );
        const hits = await client.search(q, maxR);
        const text = hits
          .map(
            (h, i) =>
              `${i + 1}. ${h.title}\n${h.url}\n${h.snippet}`,
          )
          .join("\n\n");
        vars[node.id] = { text, hits, query: q };
        vars.search = text;
        current = outgoing(node.id);
        continue;
      }

      if (node.type === "http") {
        const urlTpl = String((node.data?.url as string) || "");
        const url = renderTemplate(urlTpl, vars).trim();
        await this.assertHttpAllowed(url);
        const method = String(
          (node.data?.method as string) || "POST",
        ).toUpperCase();
        const headersRaw = (node.data?.headers as Record<string, string>) || {};
        const headers: Record<string, string> = {
          "Content-Type": "application/json",
          "User-Agent": "WeChat-AI-Chatflow/1.0",
        };
        for (const [k, v] of Object.entries(headersRaw)) {
          headers[k] = renderTemplate(String(v), vars);
        }
        if (this.opts.toolsApiKey && !headers.Authorization) {
          // Only inject when targeting the tools gateway itself — host AND
          // port, so a different service on the same machine never sees the key.
          try {
            const host = new URL(url).host.toLowerCase();
            const toolsHostPort = this.toolsHostPort();
            if (toolsHostPort && host === toolsHostPort) {
              headers.Authorization = `Bearer ${this.opts.toolsApiKey}`;
            }
          } catch {
            /* ignore */
          }
        }
        let body: string | undefined;
        if (method !== "GET" && method !== "HEAD") {
          const bodyTpl =
            (node.data?.body as string) ||
            JSON.stringify({ query: "{{query}}" });
          body = renderTemplate(bodyTpl, vars);
        }
        // Bounded: an unresponsive endpoint here would otherwise hold the
        // reply-consumer slot and the bot:peer chain open indefinitely.
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), HTTP_NODE_TIMEOUT_MS);
        let resp: Response;
        let respText: string;
        try {
          resp = await this.fetchHttpNode(
            url,
            { method, headers, body },
            ctrl.signal,
          );
          respText = await resp.text();
        } catch (err: unknown) {
          // A guard rejection — a redirect into internal space, say — is a hard
          // stop. Letting it fall through to http_error would turn a blocked
          // SSRF attempt into a branch the flow can quietly carry on from.
          if (err instanceof ChatflowError) throw err;
          const message = ctrl.signal.aborted
            ? `timeout after ${HTTP_NODE_TIMEOUT_MS}ms`
            : err instanceof Error
              ? err.message
              : String(err);
          vars[node.id] = { status: 0, text: `http_error: ${message}`, json: null };
          trace.push(`http_error:${message}`);
          current = outgoing(node.id);
          continue;
        } finally {
          clearTimeout(timer);
        }
        let json: unknown = null;
        try {
          json = JSON.parse(respText);
        } catch {
          json = null;
        }
        vars[node.id] = {
          status: resp.status,
          text: respText.slice(0, 50_000),
          json,
        };
        if (!resp.ok) {
          trace.push(`http_error:${resp.status}`);
        }
        current = outgoing(node.id);
        continue;
      }

      if (node.type === "llm") {
        const nodeSystem = renderTemplate(
          String(
            (node.data?.system as string) ||
              (node.data?.system_prompt as string) ||
              "{{system_prompt}}",
          ),
          vars,
        );
        const system = [
          nodeSystem,
          input.qualityPlan
            ? buildConversationQualityBlock(input.qualityPlan)
            : "",
        ]
          .filter(Boolean)
          .join("\n\n");
        const prompt = renderTemplate(
          String(
            (node.data?.prompt as string) ||
              (node.data?.user as string) ||
              "{{query}}",
          ),
          vars,
        );
        const temperature =
          typeof node.data?.temperature === "number"
            ? node.data.temperature
            : 0.8;
        const client = this.resolveLlmClient(input.upstream ?? null);
        const messages = [
          { role: "system" as const, content: system },
          { role: "user" as const, content: prompt },
        ];
        const usage = await client.chatWithUsage(messages, {
          tools: [],
          timeZone: this.opts.timeZone,
          // force temperature via... LlmClient uses constructor temp; ok for MVP
        });
        // Note: LlmClient temperature is fixed at construct; forUserUpstream uses defaults.
        void temperature;
        promptTokens += usage.promptTokens;
        completionTokens += usage.completionTokens;
        const text = usage.text.trim();
        vars[node.id] = { text, model: usage.model };
        vars.llm_text = text;
        current = outgoing(node.id);
        continue;
      }

      if (node.type === "answer") {
        const ans = renderTemplate(
          String(
            (node.data?.answer as string) ||
              (node.data?.text as string) ||
              "{{llm_text}}",
          ),
          vars,
        ).trim();
        finalAnswer = ans || finalAnswer;
        vars[node.id] = { text: ans };
        // Prefer first non-empty answer; stop graph
        if (ans) break;
        current = outgoing(node.id);
        continue;
      }

      throw new ChatflowError("node", `unsupported node type ${node.type}`);
    }

    if (!finalAnswer?.trim()) {
      throw new ChatflowError("no_answer", "chatflow produced no answer");
    }

    return {
      text: finalAnswer.trim(),
      trace,
      steps,
      promptTokens,
      completionTokens,
    };
  }

  private resolveLlmClient(upstream: LlmUpstream | null): LlmClient {
    if (upstream) {
      if (!this.opts.toolsBaseUrl || !this.opts.toolsApiKey) {
        throw new ChatflowError(
          "node",
          "User custom LLM requires TOOLS_BASE_URL and TOOLS_API_KEY",
        );
      }
      return LlmClient.forUserUpstream({
        toolsBaseUrl: this.opts.toolsBaseUrl,
        toolsApiKey: this.opts.toolsApiKey,
        upstream,
      });
    }
    return this.opts.platformLlm;
  }

  private toolsHost(): string | null {
    const base = (this.opts.toolsBaseUrl || "").trim();
    if (!base) return null;
    try {
      return new URL(base).hostname.toLowerCase();
    } catch {
      return null;
    }
  }

  /**
   * Tools gateway host *including port*, for the checks where the port is the
   * whole point.
   *
   * The internal-space exemption and the Authorization injection must both
   * match on host+port, not hostname. A local tools container is normally
   * TOOLS_BASE_URL=http://127.0.0.1:7860; matching on hostname alone would
   * exempt every other port on loopback too — this service's own API among
   * them — and would hand the tools key to whatever is listening there.
   */
  private toolsHostPort(): string | null {
    const base = (this.opts.toolsBaseUrl || "").trim();
    if (!base) return null;
    try {
      return new URL(base).host.toLowerCase();
    } catch {
      return null;
    }
  }

  private async assertHttpAllowed(url: string): Promise<void> {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new ChatflowError("http_blocked", "invalid http node URL");
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new ChatflowError("http_blocked", "http node only allows http(s)");
    }
    // parsed.hostname already drops userinfo and normalises IP encodings, so
    // http://allowed@169.254.169.254/ is judged on the address, not the label.
    const host = normalizeHost(parsed.hostname);
    const entries = (this.opts.httpAllowHosts || [])
      .map((h) => h.trim().toLowerCase())
      .filter(Boolean);
    const anyHost = allowsAnyHost(entries);
    const allow = new Set(
      entries.filter((h) => h !== ALLOW_ANY_HOST).map((h) => normalizeHost(h)),
    );
    const toolsHost = this.toolsHost();
    if (toolsHost) allow.add(toolsHost);
    if (!anyHost) {
      // Always allow loopback tools during local dev if tools points there
      if (!allow.size) {
        throw new ChatflowError(
          "http_blocked",
          "http node blocked: no TOOLS_BASE_URL / CHATFLOW_HTTP_ALLOWLIST",
        );
      }
      if (!allow.has(host)) {
        throw new ChatflowError(
          "http_blocked",
          `http node host not allowlisted: ${host}`,
        );
      }
    }
    // The tools container is a deliberate config, loopback or not — but only
    // that exact host:port, not every port on the same machine.
    const toolsHostPort = this.toolsHostPort();
    if (toolsHostPort && parsed.host.toLowerCase() === toolsHostPort) return;
    // Internal space stays blocked on both paths. With `*` this is the only
    // barrier left, so it is a range check rather than a list of spellings,
    // followed by a look at what the name actually resolves to.
    const reason =
      blockedHostReason(host) ?? (await blockedResolvedReason(host));
    if (reason) {
      throw new ChatflowError(
        "http_blocked",
        `http node private host blocked: ${host} (${reason})`,
      );
    }
  }

  /**
   * Fetch an http node's URL, re-checking every redirect hop.
   *
   * `fetch` defaults to redirect: "follow", which would let an allowlisted
   * host bounce the request to 169.254.169.254 — the guard only ever sees the
   * first URL. So hops are taken manually and each one goes back through
   * assertHttpAllowed.
   */
  private async fetchHttpNode(
    startUrl: string,
    init: { method: string; headers: Record<string, string>; body?: string },
    signal: AbortSignal,
  ): Promise<Response> {
    let url = startUrl;
    let method = init.method;
    let body = init.body;
    let headers = { ...init.headers };

    for (let hop = 0; ; hop++) {
      await this.assertHttpAllowed(url);
      const resp = await fetch(url, {
        method,
        headers,
        body,
        signal,
        redirect: "manual",
      });
      if (!REDIRECT_STATUSES.has(resp.status)) return resp;

      const location = resp.headers.get("location");
      if (!location) return resp;
      if (hop >= HTTP_NODE_MAX_REDIRECTS) {
        throw new ChatflowError(
          "http_blocked",
          `http node exceeded ${HTTP_NODE_MAX_REDIRECTS} redirects`,
        );
      }

      let next: URL;
      try {
        next = new URL(location, url);
      } catch {
        throw new ChatflowError(
          "http_blocked",
          `http node redirect to invalid URL: ${location}`,
        );
      }
      // Never carry credentials across an origin change — the Authorization
      // header is only ever injected for the tools host.
      if (next.host !== new URL(url).host) delete headers.Authorization;
      // Mirror fetch's own method rewriting: 303 always downgrades to GET,
      // and 301/302 do so for anything that had a body.
      if (resp.status === 303 || (body !== undefined && resp.status !== 307 && resp.status !== 308)) {
        method = "GET";
        body = undefined;
        const { "Content-Type": _ct, ...rest } = headers;
        headers = rest;
      }
      url = next.toString();
    }
  }
}

export function isChatflowGraph(raw: unknown): raw is ChatflowGraph {
  try {
    validateChatflowGraph(raw);
    return true;
  } catch {
    return false;
  }
}

export function summarizeGraph(graph: ChatflowGraph | null | undefined): {
  nodeCount: number;
  types: string[];
} {
  if (!graph?.nodes?.length) return { nodeCount: 0, types: [] };
  const types = [...new Set(graph.nodes.map((n: ChatflowNodeBase) => n.type))];
  return { nodeCount: graph.nodes.length, types };
}
