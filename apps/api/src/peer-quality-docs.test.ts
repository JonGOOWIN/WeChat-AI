import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

const userHelp = fs.readFileSync(
  path.resolve(import.meta.dirname, "../public/docs.html"),
  "utf8",
);
const adminHelp = fs.readFileSync(
  path.resolve(import.meta.dirname, "../../../docs/admin-api.md"),
  "utf8",
);

describe("peer quality help contract", () => {
  it("documents the available owner control and full inheritance deletion", () => {
    assert.doesNotMatch(userHelp, /联系人专属覆盖尚未提供/);
    assert.match(userHelp, /用户中心.*单个联系人.*逐项覆盖/);
    assert.match(userHelp, /全部继承.*删除.*专属覆盖/);
  });

  it("keeps runtime admin guidance aligned with the RULE-002 peer section", () => {
    assert.doesNotMatch(adminHelp, /联系人覆盖尚未提供/);
    assert.match(adminHelp, /详见下方「联络人对话风格（RULE-002）」/);
    assert.match(adminHelp, /# 联络人对话风格（RULE-002）/);
  });
});
