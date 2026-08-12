import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

const html = fs.readFileSync(
  path.resolve(import.meta.dirname, "../public/admin.html"),
  "utf8",
);

describe("Admin conversation settings document", () => {
  it("keeps the generic renderer and exposes the three visible planning stages", () => {
    assert.match(html, /id="settingsGroups"/);
    assert.match(html, /data-conversation-stage="\$\{stage\}"/);
    assert.match(html, /batch: "批次", decide: "判断", reply: "回复"/);
    assert.match(html, /aria-label="批次、判断、回复参数"/);
  });

  it("converts displayed seconds back to the API value and stacks on narrow screens", () => {
    assert.match(html, /n \* \(item\.displayDivisor \|\| 1\)/);
    assert.match(
      html,
      /@media \(max-width: 1040px\)[\s\S]*?\.conversation-flow \{ grid-template-columns: 1fr; \}/,
    );
  });

  it("contains syntactically valid inline scripts", () => {
    const scripts = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map(
      (match) => match[1] ?? "",
    );
    assert.ok(scripts.length >= 2);
    for (const script of scripts) assert.doesNotThrow(() => new Function(script));
  });
});
