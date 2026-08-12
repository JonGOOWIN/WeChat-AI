import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import type { Db } from "@wechat-ai/db";
import { loadConfig, type AppConfig } from "./config.js";
import {
  RuntimeConfigManager,
  RuntimeSettingsUnavailableError,
  SECRET_CLEAR,
  SECRET_MASK,
} from "./runtime-config.js";
import type { RuntimeSettingKey } from "./runtime-settings-spec.js";
import {
  coerceSetting,
  SETTING_SPECS,
  SETTING_SPEC_BY_KEY,
} from "./runtime-settings-spec.js";

/**
 * Minimal in-memory stand-in for the Redis surface the manager touches:
 * one JSON doc plus the SET NX lock guarding its read-modify-write.
 */
function fakeDb(): Db & { store: Map<string, unknown>; strings: Map<string, string> } {
  const store = new Map<string, unknown>();
  const strings = new Map<string, string>();
  return {
    store,
    strings,
    async getJson<T>(key: string): Promise<T | null> {
      return (store.get(key) as T) ?? null;
    },
    async setJson(key: string, value: unknown): Promise<void> {
      store.set(key, JSON.parse(JSON.stringify(value)));
    },
    async del(...keys: string[]): Promise<void> {
      for (const k of keys) {
        store.delete(k);
        strings.delete(k);
      }
    },
    redis: {
      async set(
        key: string,
        value: string,
        _ex?: string,
        _ttl?: number,
        nx?: string,
      ): Promise<string | null> {
        if (nx === "NX" && strings.has(key)) return null;
        strings.set(key, value);
        return "OK";
      },
      async get(key: string): Promise<string | null> {
        return strings.get(key) ?? null;
      },
    },
  } as unknown as Db & { store: Map<string, unknown>; strings: Map<string, string> };
}

function baseConfig(env: Record<string, string> = {}): AppConfig {
  return loadConfig({
    REDIS_URL: "redis://127.0.0.1:6379",
    ...env,
  } as NodeJS.ProcessEnv);
}

describe("runtime settings spec", () => {
  it("every spec key exists on AppConfig", () => {
    const cfg = baseConfig() as unknown as Record<string, unknown>;
    for (const spec of SETTING_SPECS) {
      assert.ok(
        spec.key in cfg,
        `${spec.key} is declared in the registry but missing from AppConfig`,
      );
    }
  });

  it("excludes bootstrap-critical config", () => {
    const forbidden = [
      "redisUrl",
      "llmBaseUrl",
      "llmApiKey",
      "llmModel",
      "llmProviderSecret",
      "sessionCookieName",
      "cookieSecure",
      "publicBaseUrl",
      "corsOrigins",
      "host",
      "port",
      "token",
      "adminIds",
      "repoRoot",
      "appVersion",
    ];
    for (const k of forbidden) {
      assert.ok(
        !SETTING_SPEC_BY_KEY.has(k as RuntimeSettingKey),
        `${k} must stay env-only`,
      );
    }
  });

  /**
   * Guard rail: every AppConfig field must be a deliberate decision — either
   * admin-editable or explicitly listed as env-only. Adding a new config field
   * fails this test until it is classified, which is what keeps the panel from
   * silently drifting out of date.
   */
  it("classifies every AppConfig field as editable or env-only", () => {
    const ENV_ONLY = new Set([
      // bootstrap / connection
      "redisUrl",
      "host",
      "port",
      "repoRoot",
      // platform LLM credentials
      "llmBaseUrl",
      "llmApiKey",
      "llmModel",
      // vision endpoint credentials — same trust level as the platform LLM
      "visionBaseUrl",
      "visionApiKey",
      // vision endpoint credentials — dialed directly like the platform LLM,
      // and they fall back to it when empty, so same rule applies
      "visionBaseUrl",
      "visionApiKey",
      // secrets whose rotation breaks stored data or locks admins out
      "llmProviderSecret",
      "token",
      "adminIds",
      // cookie / URL surface
      "sessionCookieName",
      "cookieSecure",
      "publicBaseUrl",
      "corsOrigins",
      // derived, not directly settable
      "appVersion",
      "uploadBodyLimit",
      // no consumer: the default persona comes from the DB is_default flag
      "defaultPersonaSlug",
    ]);
    /**
     * Consumer not written yet. Exposing one of these would give the operator
     * a control that reports success and changes nothing — the same defect we
     * removed DEFAULT_PERSONA_SLUG for. Move to SETTING_SPECS once the read
     * site lands.
     */
    const PENDING_CONSUMER = new Set([
      // declared on ChatServiceOptions, but nothing reads this.opts.visionMode
      "visionMode",
    ]);
    const cfg = baseConfig() as unknown as Record<string, unknown>;
    const unclassified = Object.keys(cfg).filter(
      (k) =>
        !ENV_ONLY.has(k) &&
        !PENDING_CONSUMER.has(k) &&
        !SETTING_SPEC_BY_KEY.has(k as RuntimeSettingKey),
    );
    assert.deepEqual(
      unclassified,
      [],
      `add these to SETTING_SPECS or to the ENV_ONLY list: ${unclassified.join(", ")}`,
    );
  });

  it("has no duplicate keys or env names", () => {
    const keys = new Set<string>();
    const envs = new Set<string>();
    for (const spec of SETTING_SPECS) {
      assert.ok(!keys.has(spec.key), `duplicate key ${spec.key}`);
      assert.ok(!envs.has(spec.env), `duplicate env ${spec.env}`);
      keys.add(spec.key);
      envs.add(spec.env);
    }
  });

  it("clamps numbers into range and parses booleans/csv", () => {
    const steps = SETTING_SPEC_BY_KEY.get("chatflowMaxSteps")!;
    assert.equal(coerceSetting(steps, 9999), 200);
    assert.equal(coerceSetting(steps, -5), 1);
    assert.equal(coerceSetting(steps, "12"), 12);
    assert.equal(coerceSetting(steps, "abc"), null);

    const bool = SETTING_SPEC_BY_KEY.get("webSearchEnabled")!;
    assert.equal(coerceSetting(bool, "true"), true);
    assert.equal(coerceSetting(bool, "0"), false);

    const csv = SETTING_SPEC_BY_KEY.get("chatflowHttpAllowlist")!;
    assert.equal(coerceSetting(csv, " a.com , ,b.com "), "a.com,b.com");
  });
});

describe("RuntimeConfigManager", () => {
  let db: ReturnType<typeof fakeDb>;
  let cfg: AppConfig;
  let applied: Array<Set<RuntimeSettingKey>>;
  let appliedConfigs: AppConfig[];
  let applyError: Error | null;
  let mgr: RuntimeConfigManager;

  beforeEach(async () => {
    db = fakeDb();
    cfg = baseConfig({ WEB_SEARCH_ENABLED: "false", CHATFLOW_MAX_STEPS: "32" });
    applied = [];
    appliedConfigs = [];
    applyError = null;
    mgr = new RuntimeConfigManager(
      db,
      cfg,
      (changed, live) => {
        if (applyError) throw applyError;
        applied.push(new Set(changed));
        appliedConfigs.push(structuredClone(live));
      },
      () => {},
    );
    await mgr.init();
  });

  it("starts from env with no overrides", () => {
    const v = mgr.view();
    assert.equal(v.overriddenCount, 0);
    assert.equal(cfg.chatflowMaxSteps, 32);
    assert.equal(applied.length, 0);
  });

  it("mutates the live cfg object in place and reports the diff", async () => {
    const r = await mgr.patch({
      patch: { chatflowMaxSteps: 64, webSearchEnabled: true },
      actor: "tester",
    });
    assert.deepEqual(r.changed.sort(), ["chatflowMaxSteps", "webSearchEnabled"]);
    assert.equal(cfg.chatflowMaxSteps, 64);
    assert.equal(cfg.webSearchEnabled, true);
    assert.equal(applied.length, 1);
    assert.ok(applied[0]!.has("chatflowMaxSteps"));
  });

  it("clamps out-of-range input instead of storing it", async () => {
    await mgr.patch({ patch: { chatflowMaxSteps: 100000 }, actor: "t" });
    assert.equal(cfg.chatflowMaxSteps, 200);
  });

  it("rejects an all-zero reply-count patch before persisting or applying it", async () => {
    await assert.rejects(
      mgr.patch({
        patch: {
          replyCountWeight1: 0,
          replyCountWeight2: 0,
          replyCountWeight3: 0,
          replyCountWeight4: 0,
        },
        actor: "tester",
      }),
      /reply count weights/i,
    );
    assert.deepEqual(
      [
        cfg.replyCountWeight1,
        cfg.replyCountWeight2,
        cfg.replyCountWeight3,
        cfg.replyCountWeight4,
      ],
      [50, 30, 15, 5],
    );
    assert.equal(db.store.size, 0);
    assert.equal(applied.length, 0);
  });

  it("rejects an all-zero reply-length patch before persisting or applying it", async () => {
    await assert.rejects(
      mgr.patch({
        patch: {
          replyLengthWeightShort: 0,
          replyLengthWeightNormal: 0,
          replyLengthWeightLong: 0,
        },
        actor: "tester",
      }),
      /reply length weights/i,
    );
    assert.deepEqual(
      [
        cfg.replyLengthWeightShort,
        cfg.replyLengthWeightNormal,
        cfg.replyLengthWeightLong,
      ],
      [60, 30, 10],
    );
    assert.equal(db.store.size, 0);
    assert.equal(applied.length, 0);
  });

  it("keeps the last good UI and worker config when stored weights are all zero", async () => {
    db.store.set("wa:settings:runtime", {
      values: {
        replyCountWeight1: 0,
        replyCountWeight2: 0,
        replyCountWeight3: 0,
        replyCountWeight4: 0,
      },
      updatedAt: new Date().toISOString(),
      updatedBy: "old-node",
    });

    assert.equal(await mgr.refresh(), false);
    assert.deepEqual(
      [
        cfg.replyCountWeight1,
        cfg.replyCountWeight2,
        cfg.replyCountWeight3,
        cfg.replyCountWeight4,
      ],
      [50, 30, 15, 5],
    );
    const shown = mgr
      .view()
      .items.filter((item) => item.key.startsWith("replyCountWeight"))
      .map((item) => item.value);
    assert.deepEqual(shown, [50, 30, 15, 5]);
    assert.equal(applied.length, 0);
  });

  it("drops the override when a value is set back to the env default", async () => {
    await mgr.patch({ patch: { chatflowMaxSteps: 64 }, actor: "t" });
    assert.equal(mgr.view().overriddenCount, 1);
    await mgr.patch({ patch: { chatflowMaxSteps: 32 }, actor: "t" });
    assert.equal(mgr.view().overriddenCount, 0);
    assert.equal(cfg.chatflowMaxSteps, 32);
  });

  it("reset restores the env default", async () => {
    await mgr.patch({ patch: { chatflowMaxSteps: 64 }, actor: "t" });
    const r = await mgr.patch({ reset: ["chatflowMaxSteps"], actor: "t" });
    assert.deepEqual(r.changed, ["chatflowMaxSteps"]);
    assert.equal(cfg.chatflowMaxSteps, 32);
  });

  it("resetAll clears every override", async () => {
    await mgr.patch({
      patch: { chatflowMaxSteps: 64, memoryTopK: 33 },
      actor: "t",
    });
    await mgr.patch({ resetAll: true, actor: "t" });
    assert.equal(mgr.view().overriddenCount, 0);
    assert.equal(cfg.chatflowMaxSteps, 32);
    assert.equal(cfg.memoryTopK, 12);
  });

  it("csv settings round-trip into a string array on cfg", async () => {
    await mgr.patch({
      patch: { chatflowHttpAllowlist: "a.com, b.com" },
      actor: "t",
    });
    assert.deepEqual(cfg.chatflowHttpAllowlist, ["a.com", "b.com"]);
  });

  it("never leaks a secret and treats blank as no-change", async () => {
    await mgr.patch({ patch: { toolsApiKey: "sk-real" }, actor: "t" });
    assert.equal(cfg.toolsApiKey, "sk-real");
    const item = mgr.view().items.find((i) => i.key === "toolsApiKey")!;
    assert.equal(item.value, SECRET_MASK);

    // A blank submit must not wipe the stored key…
    await mgr.patch({ patch: { toolsApiKey: "" }, actor: "t" });
    assert.equal(cfg.toolsApiKey, "sk-real");
    // …and echoing the mask back must not become the literal value.
    await mgr.patch({ patch: { toolsApiKey: SECRET_MASK }, actor: "t" });
    assert.equal(cfg.toolsApiKey, "sk-real");
    // Explicit clear.
    await mgr.patch({ patch: { toolsApiKey: SECRET_CLEAR }, actor: "t" });
    assert.equal(cfg.toolsApiKey, "");
  });

  it("ignores unknown keys", async () => {
    const r = await mgr.patch({
      patch: { redisUrl: "redis://evil", notAKey: 1 },
      actor: "t",
    });
    assert.deepEqual(r.changed, []);
    assert.equal(cfg.redisUrl, "redis://127.0.0.1:6379");
  });

  it("picks up a peer node's write on the next refresh", async () => {
    const peerDb = db;
    const peerCfg = baseConfig({ CHATFLOW_MAX_STEPS: "32" });
    const peer = new RuntimeConfigManager(peerDb, peerCfg, () => {}, () => {});
    await peer.init();

    await mgr.patch({ patch: { chatflowMaxSteps: 77 }, actor: "node-a" });
    assert.equal(peerCfg.chatflowMaxSteps, 32, "not yet refreshed");

    const changed = await peer.refresh();
    assert.equal(changed, true);
    assert.equal(peerCfg.chatflowMaxSteps, 77);
    assert.equal(await peer.refresh(), false, "second refresh is a no-op");
  });

  it("surfaces cross-field warnings without rewriting input", async () => {
    await mgr.patch({
      patch: { leaseTtlSec: 20, leaseRenewSec: 30 },
      actor: "t",
    });
    assert.equal(cfg.leaseTtlSec, 20);
    assert.equal(cfg.leaseRenewSec, 30);
    assert.ok(
      mgr.currentWarnings().some((w) => w.includes("租约 TTL")),
      "expected a lease TTL warning",
    );
  });

  it("keeps uploadBodyLimit consistent with stickerMaxBytes", async () => {
    await mgr.patch({ patch: { stickerMaxBytes: 20 * 1024 * 1024 }, actor: "t" });
    assert.equal(cfg.uploadBodyLimit, 40 * 1024 * 1024);
  });

  it("releases the RMW lock so a second write is not blocked", async () => {
    await mgr.patch({ patch: { chatflowMaxSteps: 40 }, actor: "a" });
    assert.equal(db.strings.has("wa:settings:runtime:lock"), false);
    await mgr.patch({ patch: { memoryTopK: 20 }, actor: "b" });
    assert.equal(cfg.chatflowMaxSteps, 40);
    assert.equal(cfg.memoryTopK, 20);
  });

  it("concurrent writes on two nodes do not lose each other's edits", async () => {
    const peerCfg = baseConfig({ CHATFLOW_MAX_STEPS: "32" });
    const peer = new RuntimeConfigManager(db, peerCfg, () => {}, () => {});
    await peer.init();

    // Both patches race against the same shared store.
    await Promise.all([
      mgr.patch({ patch: { chatflowMaxSteps: 50 }, actor: "node-a" }),
      peer.patch({ patch: { memoryTopK: 40 }, actor: "node-b" }),
    ]);

    await mgr.refresh();
    await peer.refresh();
    assert.equal(cfg.chatflowMaxSteps, 50, "node A's edit survived");
    assert.equal(cfg.memoryTopK, 40, "node B's edit survived");
    assert.equal(mgr.view().overriddenCount, 2);
  });

  it("view() payload matches what the admin page renders", () => {
    const v = mgr.view();
    const groupIds = new Set(v.groups.map((g) => g.id));
    assert.ok(v.items.length > 50, "expected a broad settings surface");
    for (const item of v.items) {
      for (const f of [
        "key",
        "env",
        "group",
        "label",
        "type",
        "value",
        "envDefault",
        "overridden",
        "restart",
      ]) {
        assert.ok(f in item, `${item.key} is missing ${f}`);
      }
      assert.ok(
        groupIds.has(item.group as never),
        `${item.key} points at unknown group ${item.group}`,
      );
      assert.ok(
        ["bool", "int", "float", "string", "csv", "secret"].includes(item.type),
        `${item.key} has unrenderable type ${item.type}`,
      );
    }
    // Every declared group must actually hold at least one row.
    for (const g of v.groups) {
      assert.ok(
        v.items.some((i) => i.group === g.id),
        `group ${g.id} would render empty`,
      );
    }
  });

  it("rejects a log level outside the allowed set", async () => {
    // A bad level would only bite on the NEXT boot (restart:true), where pino
    // throws at Fastify construction and crash-loops every node.
    const r = await mgr.patch({ patch: { logLevel: "verbose" }, actor: "t" });
    assert.deepEqual(r.changed, []);
    assert.equal(cfg.logLevel, "info");
    await mgr.patch({ patch: { logLevel: "debug" }, actor: "t" });
    assert.equal(cfg.logLevel, "debug");
  });

  it("a Redis read failure never wipes stored overrides", async () => {
    await mgr.patch({
      patch: { chatflowMaxSteps: 64, memoryTopK: 33 },
      actor: "t",
    });
    const stored = JSON.parse(
      JSON.stringify(db.store.get("wa:settings:runtime")),
    );

    // Simulate a transient Redis error on the next read.
    const realGet = db.getJson.bind(db);
    let failNext = true;
    (db as { getJson: unknown }).getJson = async (key: string) => {
      if (failNext) {
        failNext = false;
        throw new Error("ETIMEDOUT");
      }
      return realGet(key);
    };

    // refresh() must keep the last good state, not revert to .env.
    assert.equal(await mgr.refresh(), false);
    assert.equal(cfg.chatflowMaxSteps, 64);
    assert.equal(cfg.memoryTopK, 33);

    // patch() must refuse to write rather than persist an empty base.
    failNext = true;
    await assert.rejects(
      () => mgr.patch({ patch: { memoryTopK: 44 }, actor: "t" }),
      (e: unknown) => e instanceof RuntimeSettingsUnavailableError,
    );
    assert.deepEqual(db.store.get("wa:settings:runtime"), stored);
  });

  it("resetAll still works when the stored document is unreadable", async () => {
    await mgr.patch({ patch: { chatflowMaxSteps: 64 }, actor: "t" });
    const realGet = db.getJson.bind(db);
    let fail = true;
    (db as { getJson: unknown }).getJson = async (key: string) => {
      if (fail) throw new Error("bad json");
      return realGet(key);
    };
    const r = await mgr.patch({ resetAll: true, actor: "t" });
    assert.ok(r.changed.includes("chatflowMaxSteps"));
    fail = false;
    await mgr.refresh();
    assert.equal(cfg.chatflowMaxSteps, 32);
    assert.equal(mgr.view().overriddenCount, 0);
  });

  it("resetAll clears a corrupt document even with nothing loaded locally", async () => {
    // The node that boots into a corrupt doc has no overrides of its own, so
    // `changed` is empty — the write must happen anyway or recovery is a no-op.
    db.store.set("wa:settings:runtime", { values: { chatflowMaxSteps: 64 } });
    const realGet = db.getJson.bind(db);
    let fail = true;
    (db as { getJson: unknown }).getJson = async (key: string) => {
      if (fail) throw new Error("Unexpected token in JSON");
      return realGet(key);
    };
    await mgr.patch({ resetAll: true, actor: "t" });
    fail = false;
    const doc = db.store.get("wa:settings:runtime") as { values: object };
    assert.deepEqual(doc.values, {}, "corrupt doc was replaced with an empty one");
  });

  it("survives a malformed stored document", async () => {
    db.store.set("wa:settings:runtime", {
      values: { chatflowMaxSteps: "not-a-number", bogus: 1 },
      updatedAt: "x",
      updatedBy: "y",
    });
    await mgr.refresh();
    assert.equal(cfg.chatflowMaxSteps, 32);
  });

  it("keeps all last-known-good quality settings when one known value is corrupt", async () => {
    await mgr.patch({ patch: { replyCoveragePercent: 55 }, actor: "tester" });
    assert.equal(cfg.replyCoveragePercent, 55);
    assert.equal(cfg.replyFollowUpPercent, 20);
    const appliedBefore = applied.length;
    const viewBefore = structuredClone(mgr.view());

    db.store.set("wa:settings:runtime", {
      values: {
        replyCoveragePercent: "NaN",
        replyFollowUpPercent: 80,
      },
      updatedAt: "corrupt-quality-doc",
      updatedBy: "peer-node",
    });

    assert.equal(await mgr.refresh(), false);
    assert.equal(cfg.replyCoveragePercent, 55);
    assert.equal(cfg.replyFollowUpPercent, 20);
    assert.deepEqual(mgr.view(), viewBefore);
    assert.equal(applied.length, appliedBefore);
  });

  /**
   * Ticket #16: "If the service fan-out callback throws, the public config
   * object, local overrides, updated metadata and last-seen marker all remain
   * at the previous good state."
   */
  it("retries a failed multi-field apply without exposing a partial config", async () => {
    await mgr.patch({ patch: { replyCoveragePercent: 55 }, actor: "tester" });
    const cfgBefore = structuredClone(cfg);
    const viewBefore = structuredClone(mgr.view());
    const appliedBefore = applied.length;

    db.store.set("wa:settings:runtime", {
      values: {
        replyCoveragePercent: 65,
        replyFollowUpPercent: 35,
      },
      updatedAt: "peer-update",
      updatedBy: "peer-node",
    });
    applyError = new Error("transient subsystem failure");

    assert.equal(await mgr.refresh(), false);
    assert.deepEqual(cfg, cfgBefore);
    assert.deepEqual(mgr.view(), viewBefore);
    assert.equal(applied.length, appliedBefore);

    applyError = null;
    assert.equal(await mgr.refresh(), true, "the same document is retried");
    assert.equal(cfg.replyCoveragePercent, 65);
    assert.equal(cfg.replyFollowUpPercent, 35);
    assert.equal(mgr.view().updatedAt, "peer-update");
    assert.equal(mgr.view().updatedBy, "peer-node");
    assert.equal(applied.length, appliedBefore + 1);
    assert.deepEqual(
      [...applied.at(-1)!].sort(),
      ["replyCoveragePercent", "replyFollowUpPercent"],
    );
    assert.equal(appliedConfigs.at(-1)!.replyCoveragePercent, 65);
    assert.equal(appliedConfigs.at(-1)!.replyFollowUpPercent, 35);
    assert.equal(await mgr.refresh(), false, "a successful document is consumed once");
    assert.equal(applied.length, appliedBefore + 1);
  });
});
