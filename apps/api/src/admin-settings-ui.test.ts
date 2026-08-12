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
      /item\.step != null \? item\.step \/ divisor : \(item\.type === "int" \? 1 : 0\.01\) \/ divisor/,
    );
    assert.match(
      html,
      /@media \(max-width: 1040px\)[\s\S]*?\.conversation-flow \{ grid-template-columns: 1fr; \}/,
    );
  });

  it("updates planning summaries in place while numeric fields are edited", () => {
    assert.match(html, /data-conversation-summary="\$\{stage\}"/);
    assert.match(html, /function settingsRefreshConversationSummaries\(\)/);
    assert.match(
      html,
      /settingsState\.dirty\.set\(item\.key, next\);[\s\S]*?settingsRefreshConversationSummaries\(\);[\s\S]*?settingsSyncDirtyUi\(\);/,
    );
    assert.doesNotMatch(
      html,
      /settingsState\.dirty\.set\(item\.key, next\);[\s\S]{0,160}?renderSettings\(\)/,
    );

    const body = html.match(
      /function settingsConversationSummary\(stage\) \{([\s\S]*?)\n    \}\n\n    function settingsRefreshConversationSummaries/,
    )?.[1];
    assert.ok(body, "summary function is available at the public UI seam");
    const items = [50, 30, 15, 5].map((value, index) => ({
      key: `replyCountWeight${index + 1}`,
      value,
    }));
    const dirty = new Map<string, number>();
    const summarize = new Function(
      "settingsState",
      "settingsDisplayValue",
      "settingsPendingValue",
      `return function settingsConversationSummary(stage) {${body}}`,
    )(
      { items },
      (_item: unknown, value: number) => value,
      (item: { key: string; value: number }) => dirty.get(item.key) ?? item.value,
    ) as (stage: string) => string;

    assert.match(summarize("reply"), /条数 100%/);

    const onChangeBody = html.match(
      /const onChange = \(\) => \{([\s\S]*?)\n        \};\n        el\.onchange = onChange;/,
    )?.[1];
    assert.ok(onChangeBody, "numeric input handler is available at the public UI seam");
    const el = { value: "51", checked: false };
    const item = { ...items[0]!, type: "float", stage: "reply" };
    const summaries: string[] = [];
    const pendingCounts: number[] = [];
    const onChange = new Function(
      "el",
      "item",
      "settingsState",
      "settingsRefreshConversationSummaries",
      "settingsSyncDirtyUi",
      "renderSettings",
      `return () => {${onChangeBody}}`,
    )(
      el,
      item,
      { dirty, resets: new Set<string>() },
      () => summaries.push(summarize("reply")),
      () => pendingCounts.push(dirty.size),
      () => assert.fail("numeric input must not rerender the settings page"),
    ) as () => void;

    onChange();
    assert.equal(summaries.at(-1), "条数 101% · 长度 NaN%");
    assert.equal(pendingCounts.at(-1), 1);

    el.value = "";
    onChange();
    assert.equal(summaries.at(-1), "条数 100% · 长度 NaN%");
    assert.equal(pendingCounts.at(-1), 0, "blank input withdraws the pending save");
  });

  it("contains syntactically valid inline scripts", () => {
    const scripts = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map(
      (match) => match[1] ?? "",
    );
    assert.ok(scripts.length >= 2);
    for (const script of scripts) assert.doesNotThrow(() => new Function(script));
  });
});
