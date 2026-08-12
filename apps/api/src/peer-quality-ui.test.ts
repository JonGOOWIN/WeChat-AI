import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

const html = fs.readFileSync(path.resolve(import.meta.dirname, "../public/app.html"), "utf8");

describe("owner peer conversation-style modal", () => {
  it("exposes all partial controls with explicit inheritance", () => {
    assert.match(html, /id="peerQualityModal"/);
    assert.match(html, /联络人对话风格/);
    for (const suffix of ["Coverage", "FollowUp", "Length", "Emotion", "Repetition"]) {
      assert.match(html, new RegExp(`id="peerQ${suffix}Inherit"`));
    }
    assert.match(html, /继承人设与全局/);
  });

  it("serializes null clears and the length tuple atomically", () => {
    assert.match(html, /const conversationQuality = readPersonaQualityControls\("peerQ"\)/);
    assert.match(
      html,
      /body:\s*\{ botAccountId, peerId, conversationQuality: submittedQuality \}/,
    );
    assert.match(html, /data-peer-quality-bot=/);
    assert.match(html, /data-peer-quality-peer=/);
  });

  it("keeps the inline scripts syntactically valid", () => {
    for (const match of html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)) {
      assert.doesNotThrow(() => new Function(match[1] ?? ""));
    }
  });

  it("keeps a successful clear in local state when the follow-up list reload fails", async () => {
    const start = html.indexOf("    function normalizePeerConversationQuality");
    const end = html.indexOf("    function bindPeerActions", start);
    assert.ok(start >= 0 && end > start, "peer quality state behavior seam missing");
    const source = html.slice(start, end);
    const state = { peers: [{ bot_account_id: "bot", peer_id: "peer", conversationQuality: { coveragePercent: 48 } }] };
    let openedWith: unknown;
    const elements = new Map<string, Record<string, unknown>>();
    const $ = (id: string) => {
      if (!elements.has(id)) elements.set(id, { classList: { add() {}, remove() {} }, style: {}, focus() {} });
      return elements.get(id)!;
    };
    const behavior = new Function(
      "state", "$", "toast", "setTimeout", "setPersonaQualityControls", "document", "console", "api", "loadPeers", "validatePersonaQualityControls", "readPersonaQualityControls",
      `${source}; return { openPeerQualityModal, persistPeerQualitySave };`,
    )(
      state,
      $,
      () => {},
      (fn: () => void) => fn(),
      (_prefix: string, quality: unknown) => { openedWith = quality; },
      { body: { style: {} } },
      { warn() {} },
      async () => ({ conversationQuality: {} }),
      async () => { throw new Error("GET failed"); },
      () => {},
      () => ({}),
    );
    await behavior.persistPeerQualitySave("bot", "peer", {
      coveragePercent: null,
      followUpPercent: null,
      lengthWeights: null,
      emotionContinuityTurns: null,
      repetitionWindowAssistantTurns: null,
    });
    behavior.openPeerQualityModal("bot", "peer");
    assert.deepEqual(openedWith, {});
    assert.deepEqual(state.peers[0]?.conversationQuality, {});
  });
});
