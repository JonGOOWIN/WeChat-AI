/** Chatflow graph types (Dify-like MVP). */

import type { ConversationQualityPlan } from "../conversation-quality.js";

export type ChatflowNodeType =
  | "start"
  | "llm"
  | "answer"
  | "if-else"
  | "http"
  | "memory"
  | "search";

export interface ChatflowNodeBase {
  id: string;
  type: ChatflowNodeType;
  /** Display label in UI */
  label?: string;
  data?: Record<string, unknown>;
}

export interface ChatflowEdge {
  id: string;
  source: string;
  target: string;
  /** For if-else: "true" | "false" | omit for default */
  sourceHandle?: string | null;
}

export interface ChatflowGraph {
  version: 1;
  nodes: ChatflowNodeBase[];
  edges: ChatflowEdge[];
}

export interface ChatflowRunInput {
  userText: string;
  botName: string;
  systemPrompt: string;
  /** Recent history as role/content pairs */
  history: Array<{ role: string; content: string }>;
  /** Memory facts already selected for this turn */
  memories: string[];
  /** Effective RULE-002 plan. Appended to every LLM node system prompt. */
  qualityPlan?: ConversationQualityPlan;
  /**
   * When true, persona allows search nodes / search tools.
   * Still requires global webSearch + tools gateway on engine deps.
   */
  webSearchEnabled?: boolean;
  /** Persona llm_provider_id resolved upstream (via tools only). */
  upstream?: {
    baseUrl: string;
    apiKey: string;
    model: string;
  } | null;
}

export interface ChatflowRunResult {
  text: string;
  /** Ordered intermediate logs for debugging (not sent to WeChat) */
  trace: string[];
  steps: number;
  promptTokens: number;
  completionTokens: number;
}

export class ChatflowError extends Error {
  constructor(
    public code:
      | "invalid_graph"
      | "max_steps"
      | "no_answer"
      | "http_blocked"
      | "search_disabled"
      | "node"
      | "timeout",
    message: string,
  ) {
    super(message);
    this.name = "ChatflowError";
  }
}
