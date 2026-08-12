import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { LlmClient } from "@wechat-ai/llm";
import { planConversationQuality } from "../conversation-quality.js";
import { ChatflowEngine } from "./engine.js";
import type { ChatflowGraph } from "./types.js";

describe("Chatflow conversation quality", () => {
  it("injects the effective quality block into every LLM node with a custom system prompt", async () => {
    const calls: Array<Array<{ role: string; content: string }>> = [];
    const llm = {
      async chatWithUsage(messages: Array<{ role: string; content: string }>) {
        calls.push(messages);
        return {
          text: calls.length === 1 ? "draft" : "final",
          promptTokens: 1,
          completionTokens: 1,
          totalTokens: 2,
          model: "fixture",
        };
      },
    } as LlmClient;
    const graph: ChatflowGraph = {
      version: 1,
      nodes: [
        { id: "start", type: "start" },
        { id: "first", type: "llm", data: { system: "first custom" } },
        { id: "second", type: "llm", data: { system: "second custom", prompt: "{{first.text}}" } },
        { id: "answer", type: "answer", data: { answer: "{{second.text}}" } },
      ],
      edges: [
        { id: "e1", source: "start", target: "first" },
        { id: "e2", source: "first", target: "second" },
        { id: "e3", source: "second", target: "answer" },
      ],
    };
    const qualityPlan = planConversationQuality({
      stableTurnKey: "chatflow-turn",
      topics: [{ id: "turn", text: "請幫我確認時間" }],
      settings: {
        coveragePercent: 83,
        followUpPercent: 0,
        lengthWeights: [0, 100, 0],
        emotionContinuityTurns: 7,
        repetitionWindowAssistantTurns: 9,
      },
    });

    await new ChatflowEngine({ platformLlm: llm }).run(graph, {
      userText: "請幫我確認時間",
      botName: "bot",
      systemPrompt: "persona",
      history: [],
      memories: [],
      qualityPlan,
    });

    assert.equal(calls.length, 2);
    for (const [index, call] of calls.entries()) {
      const system = call[0]?.content ?? "";
      assert.match(system, new RegExp(`${index === 0 ? "first" : "second"} custom`));
      assert.match(system, /本輪對話品質計畫/);
      assert.match(system, /回覆覆蓋率：83%/);
      assert.match(system, /整份可見回覆 21–60 字/);
      assert.doesNotMatch(system, /persona/);
    }
  });
});
