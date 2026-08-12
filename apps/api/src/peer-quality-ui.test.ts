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
    assert.match(html, /body:\s*\{ botAccountId, peerId, conversationQuality \}/);
    assert.match(html, /data-peer-quality-bot=/);
    assert.match(html, /data-peer-quality-peer=/);
  });

  it("keeps the inline scripts syntactically valid", () => {
    for (const match of html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)) {
      assert.doesNotThrow(() => new Function(match[1] ?? ""));
    }
  });
});
