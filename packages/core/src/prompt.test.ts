import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildBatchUserContent, parseFactsJson } from "./prompt.js";

describe("parseFactsJson", () => {
  it("parses plain array", () => {
    assert.deepEqual(parseFactsJson('["a","b"]'), ["a", "b"]);
  });

  it("parses fenced noise", () => {
    assert.deepEqual(
      parseFactsJson('Here:\n```json\n["喜欢猫"]\n```'),
      ["喜欢猫"],
    );
  });
});

describe("buildBatchUserContent", () => {
  it("keeps message and attachment boundaries in arrival order", () => {
    assert.deepEqual(
      buildBatchUserContent([
        {
          id: "m1",
          text: "先看这张",
          attachments: [
            { kind: "image", dataUri: "data:image/png;base64,first" },
          ],
        },
        {
          id: "m2",
          text: "再回答这个问题？",
          attachments: [],
        },
      ]),
      [
        { type: "text", text: "[消息 1/2 · m1]\n先看这张" },
        {
          type: "image_url",
          image_url: { url: "data:image/png;base64,first" },
        },
        { type: "text", text: "[消息 2/2 · m2]\n再回答这个问题？" },
      ],
    );
  });
});
