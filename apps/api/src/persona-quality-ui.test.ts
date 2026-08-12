import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

const appHtml = fs.readFileSync(
  path.resolve(import.meta.dirname, "../public/app.html"),
  "utf8",
);
const adminHtml = fs.readFileSync(
  path.resolve(import.meta.dirname, "../public/admin.html"),
  "utf8",
);

function assertQualityEditor(html: string, prefix: "pubQ" | "pQ") {
  assert.match(html, /进阶对话风格/);
  for (const suffix of [
    "Coverage",
    "FollowUp",
    "Length",
    "LengthShort",
    "LengthNormal",
    "LengthLong",
    "Emotion",
    "Repetition",
  ]) {
    assert.match(html, new RegExp(`id="${prefix}${suffix}`));
  }
  assert.match(html, new RegExp(`id="${prefix}CoverageInherit"`));
  assert.match(html, new RegExp(`id="${prefix}FollowUpInherit"`));
  assert.match(html, new RegExp(`id="${prefix}LengthInherit"`));
  assert.match(html, new RegExp(`id="${prefix}EmotionInherit"`));
  assert.match(html, new RegExp(`id="${prefix}RepetitionInherit"`));
  assert.match(html, /继承全局/);
}

describe("persona quality editor documents", () => {
  it("shows explicit global inheritance in the user persona editor", () => {
    assertQualityEditor(appHtml, "pubQ");
    assert.match(appHtml, /readPersonaQualityControls\("pubQ"\)/);
    assert.match(appHtml, /setPersonaQualityControls\("pubQ", p\.conversationQuality/);
  });

  it("shows the same partial-override contract in the Admin official editor", () => {
    assertQualityEditor(adminHtml, "pQ");
    assert.match(adminHtml, /readPersonaQualityControls\("pQ"\)/);
    assert.match(adminHtml, /setPersonaQualityControls\("pQ", p\.conversationQuality/);
  });

  it("serializes inherited fields as explicit null and length weights atomically", () => {
    for (const html of [appHtml, adminHtml]) {
      assert.match(
        html,
        /coveragePercent:\s*inherited\("Coverage"\)\s*\?\s*null\s*:\s*number\("Coverage"\)/,
      );
      assert.match(
        html,
        /lengthWeights:\s*inherited\("Length"\)\s*\?\s*null\s*:\s*\[\s*number\("LengthShort"\),\s*number\("LengthNormal"\),\s*number\("LengthLong"\),?\s*\]/,
      );
    }
  });

  it("keeps both documents' inline scripts syntactically valid", () => {
    for (const html of [appHtml, adminHtml]) {
      const scripts = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map(
        (match) => match[1] ?? "",
      );
      assert.ok(scripts.length >= 2);
      for (const script of scripts) assert.doesNotThrow(() => new Function(script));
    }
  });
});
