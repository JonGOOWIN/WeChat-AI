import { K, type Db } from "@wechat-ai/db";
import { assertReplyCountWeights, type AppConfig } from "./config.js";
import {
  coerceSetting,
  configToSettingValue,
  isRuntimeSettingKey,
  SETTING_GROUPS,
  SETTING_SPEC_BY_KEY,
  SETTING_SPECS,
  settingValueToConfig,
  type RuntimeSettingKey,
  type SettingSpec,
  type SettingValue,
} from "./runtime-settings-spec.js";

/** Stored document at `wa:settings:runtime`. */
export interface RuntimeSettingsDoc {
  values: Partial<Record<RuntimeSettingKey, SettingValue>>;
  updatedAt: string;
  updatedBy: string;
}

/**
 * Per-node poll interval. Chosen over pub/sub: one GET every 5s per node is
 * negligible next to the request-path Redis traffic, and it needs no extra
 * subscriber connection. Worst-case propagation across the fleet is 5s.
 */
export const RUNTIME_SETTINGS_REFRESH_MS = 5_000;

/** Stored overrides could not be read; the caller must not write. */
export class RuntimeSettingsUnavailableError extends Error {
  constructor(public readonly cause: string) {
    super(`无法读取运行时配置（Redis）：${cause}`);
    this.name = "RuntimeSettingsUnavailableError";
  }
}

/** Placeholder returned instead of secret values. */
export const SECRET_MASK = "••••••••";
/** Typing this into a secret field clears it. */
export const SECRET_CLEAR = "-";

export interface SettingItemView {
  key: RuntimeSettingKey;
  env: string;
  group: string;
  label: string;
  type: SettingSpec["type"];
  min?: number;
  max?: number;
  step?: number;
  /** Closed set for string settings; rendered as a <select> */
  options?: readonly string[];
  restart: boolean;
  hint?: string;
  /** Effective value in use right now (secrets masked) */
  value: SettingValue;
  /** Value from the .env / process environment (secrets masked) */
  envDefault: SettingValue;
  /** True when a Redis override is in effect for this key */
  overridden: boolean;
}

export interface RuntimeSettingsView {
  groups: typeof SETTING_GROUPS;
  items: SettingItemView[];
  updatedAt: string;
  updatedBy: string;
  overriddenCount: number;
  refreshMs: number;
}

export interface PatchResult {
  view: RuntimeSettingsView;
  /** Keys whose stored value actually changed */
  changed: RuntimeSettingKey[];
  /** Changed keys that only take effect after a restart */
  restartRequired: RuntimeSettingKey[];
  warnings: string[];
}

/** Fan-out hook: push the new effective config into live services. */
export type ApplyRuntimeConfigFn = (
  changed: Set<RuntimeSettingKey>,
  cfg: AppConfig,
) => void;

function maskIfSecret(spec: SettingSpec, v: SettingValue): SettingValue {
  if (spec.type !== "secret") return v;
  return v ? SECRET_MASK : "";
}

/**
 * Owns the effective AppConfig.
 *
 * `cfg` is the very object handed to `registerRoutes` and every service, so
 * mutating it in place is what makes route handlers (which read `ctx.cfg.*`
 * per request) pick up changes for free. Services that snapshot their options
 * at construction are updated through {@link ApplyRuntimeConfigFn}.
 */
export class RuntimeConfigManager {
  private readonly envDefaults: Record<RuntimeSettingKey, SettingValue>;
  private overrides: Partial<Record<RuntimeSettingKey, SettingValue>> = {};
  private updatedAt = "";
  private updatedBy = "";
  private timer: ReturnType<typeof setInterval> | null = null;
  /** Serialized last-seen doc; skips the apply pass when Redis is unchanged. */
  private lastSeen = "";
  /** Dedupes the read-failure log line across poll ticks. */
  private lastReadError = "";
  private log: (msg: string) => void;

  constructor(
    private db: Db,
    private cfg: AppConfig,
    private applyFn: ApplyRuntimeConfigFn,
    log?: (msg: string) => void,
  ) {
    this.log = log ?? ((m) => console.log(m));
    const defaults = {} as Record<RuntimeSettingKey, SettingValue>;
    for (const spec of SETTING_SPECS) {
      defaults[spec.key] = configToSettingValue(spec, cfg);
    }
    this.envDefaults = defaults;
  }

  /** Read Redis once and apply. Call before the HTTP server starts serving. */
  async init(): Promise<void> {
    await this.refresh();
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.refresh().catch((err) => {
        this.log(
          `[settings] refresh failed: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      });
    }, RUNTIME_SETTINGS_REFRESH_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * A read failure and an absent key must never be confused.
   *
   * `getJson` rejects on both a Redis transport error and malformed JSON, and
   * returns null only when the key genuinely does not exist. Collapsing the
   * two into null would make one dropped GET look like "there are no
   * overrides" — which reverts the node to .env in refresh(), and in patch()
   * would persist that emptiness over the whole fleet.
   */
  private async readDoc(): Promise<
    { ok: true; doc: RuntimeSettingsDoc | null } | { ok: false; error: string }
  > {
    try {
      const doc = await this.db.getJson<RuntimeSettingsDoc>(K.runtimeSettings);
      return { ok: true, doc };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /**
   * Re-read overrides and push any diff into the live config.
   * Returns true when something changed.
   *
   * On a read failure this keeps the last good state untouched and returns
   * false — a transient Redis blip must not silently relax settings the panel
   * had tightened.
   */
  async refresh(): Promise<boolean> {
    const read = await this.readDoc();
    if (!read.ok) {
      if (this.lastReadError !== read.error) {
        this.lastReadError = read.error;
        this.log(
          `[settings] read failed, keeping last known config: ${read.error}`,
        );
      }
      return false;
    }
    this.lastReadError = "";
    const doc = read.doc;
    const raw = doc ? JSON.stringify(doc) : "";
    if (raw === this.lastSeen) return false;
    this.lastSeen = raw;

    const next: Partial<Record<RuntimeSettingKey, SettingValue>> = {};
    for (const [k, v] of Object.entries(doc?.values ?? {})) {
      if (!isRuntimeSettingKey(k)) continue;
      const spec = SETTING_SPEC_BY_KEY.get(k)!;
      const coerced = coerceSetting(spec, v);
      if (coerced !== null) next[k] = coerced;
    }
    try {
      assertReplyCountWeights(
        ([1, 2, 3, 4] as const).map((count) => {
          const key = `replyCountWeight${count}` as RuntimeSettingKey;
          return Number(
            next[key] === undefined ? this.envDefaults[key] : next[key],
          );
        }),
        "stored runtime reply count weights",
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.lastReadError = message;
      this.log(`[settings] invalid stored config, keeping last known config: ${message}`);
      return false;
    }
    this.overrides = next;
    this.updatedAt = doc?.updatedAt ?? "";
    this.updatedBy = doc?.updatedBy ?? "";
    return this.applyEffective();
  }

  /** Effective value for one key: Redis override, else env default. */
  private effective(key: RuntimeSettingKey): SettingValue {
    const o = this.overrides[key];
    return o === undefined ? this.envDefaults[key] : o;
  }

  /** Write effective values into `cfg` in place; fan out the diff. */
  private applyEffective(): boolean {
    const changed = new Set<RuntimeSettingKey>();
    const bag = this.cfg as unknown as Record<string, unknown>;
    for (const spec of SETTING_SPECS) {
      const want = settingValueToConfig(spec, this.effective(spec.key));
      const have = bag[spec.key];
      const same = Array.isArray(want)
        ? Array.isArray(have) && want.join(",") === have.join(",")
        : want === have;
      if (same) continue;
      bag[spec.key] = want;
      changed.add(spec.key);
    }
    if (changed.has("stickerMaxBytes")) {
      // Kept consistent with loadConfig(); only takes effect after a restart.
      this.cfg.uploadBodyLimit = Math.max(
        12 * 1024 * 1024,
        this.cfg.stickerMaxBytes * 2,
      );
    }
    if (!changed.size) return false;
    try {
      this.applyFn(changed, this.cfg);
    } catch (err) {
      this.log(
        `[settings] apply failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
    this.log(
      `[settings] applied ${changed.size} change(s): ${[...changed].join(", ")}`,
    );
    return true;
  }

  /** Cross-field sanity checks; advisory only, never silently rewrites input. */
  private warnings(): string[] {
    const out: string[] = [];
    const c = this.cfg;
    if (c.leaseTtlSec <= c.leaseRenewSec) {
      out.push(
        `租约 TTL(${c.leaseTtlSec}s) 必须明显大于续约间隔(${c.leaseRenewSec}s)，否则节点会在续约前丢失租约`,
      );
    }
    if (c.replyDelayMinMs > c.replyDelayMaxMs) {
      out.push("气泡间隔下限大于上限，实际发送会以上限为准");
    }
    if (c.replyDelayFirstMinMs > c.replyDelayFirstMaxMs) {
      out.push("首条延迟下限大于上限");
    }
    if (c.memoryFullInjectMax < c.memoryTopK) {
      out.push("全量注入阈值小于 Top-K，Top-K 将永远不会生效");
    }
    if (c.webSearchEnabled && !c.toolsBaseUrl) {
      out.push("已开启联网搜索但未配置工具网关地址，搜索会直接失败");
    }
    if (c.toolsBaseUrl && !c.toolsApiKey) {
      out.push("工具网关已配置但密钥为空，网关可能拒绝请求");
    }
    if (c.multiBubbleJson && c.replyFilterEnabled) {
      out.push("二次过滤开启时主模型不再直出 JSON，「模型直出气泡 JSON」将被忽略");
    }
    return out;
  }

  view(): RuntimeSettingsView {
    const items: SettingItemView[] = SETTING_SPECS.map((spec) => ({
      key: spec.key,
      env: spec.env,
      group: spec.group,
      label: spec.label,
      type: spec.type,
      min: spec.min,
      max: spec.max,
      step: spec.step,
      options: spec.options,
      restart: spec.restart === true,
      hint: spec.hint,
      value: maskIfSecret(spec, this.effective(spec.key)),
      envDefault: maskIfSecret(spec, this.envDefaults[spec.key]),
      overridden: this.overrides[spec.key] !== undefined,
    }));
    return {
      groups: SETTING_GROUPS,
      items,
      updatedAt: this.updatedAt,
      updatedBy: this.updatedBy,
      overriddenCount: items.filter((i) => i.overridden).length,
      refreshMs: RUNTIME_SETTINGS_REFRESH_MS,
    };
  }

  /** Current effective warnings, for the GET payload. */
  currentWarnings(): string[] {
    return this.warnings();
  }

  /**
   * Apply an admin patch: coerce, persist to Redis, then apply locally so the
   * editing node reflects it immediately (peers pick it up within 5s).
   *
   * `patch` values for secret fields: empty string = leave unchanged,
   * {@link SECRET_CLEAR} = clear.
   */
  async patch(input: {
    patch?: Record<string, unknown>;
    reset?: string[];
    resetAll?: boolean;
    actor: string;
  }): Promise<PatchResult> {
    // Serialize the read-modify-write fleet-wide. Without this, two admins on
    // two nodes each read the same base doc and the second SET drops the
    // first's whole edit — the merge is per-document, not per-field.
    const lock = await this.acquireLock();
    try {
      return await this.patchLocked(input);
    } finally {
      if (lock) await this.releaseLock(lock);
    }
  }

  /** Best-effort short lock; on failure we still proceed (see patch()). */
  private async acquireLock(): Promise<string | null> {
    const token = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    for (let i = 0; i < 5; i++) {
      try {
        const ok = await this.db.redis.set(
          K.runtimeSettingsLock,
          token,
          "EX",
          5,
          "NX",
        );
        if (ok === "OK") return token;
      } catch {
        // Redis is already the source of truth for the write below; if the
        // lock op itself fails, fall through rather than block the admin.
        return null;
      }
      await new Promise((r) => setTimeout(r, 120));
    }
    return null;
  }

  private async releaseLock(token: string): Promise<void> {
    try {
      // Only drop our own lock — a slow write must not release a successor's.
      const cur = await this.db.redis.get(K.runtimeSettingsLock);
      if (cur === token) await this.db.del(K.runtimeSettingsLock);
    } catch {
      /* the 5s EX is the backstop */
    }
  }

  private async patchLocked(input: {
    patch?: Record<string, unknown>;
    reset?: string[];
    resetAll?: boolean;
    actor: string;
  }): Promise<PatchResult> {
    // Read from Redis, not local state — this node's snapshot is up to 5s old.
    const read = await this.readDoc();
    // Writing a merge derived from a failed read would persist an empty base
    // and destroy every other override fleet-wide. resetAll is the exception:
    // it discards the base by definition, so it stays available as the
    // in-product recovery path even when the stored doc is unreadable.
    if (!read.ok && !input.resetAll) {
      throw new RuntimeSettingsUnavailableError(read.error);
    }
    const doc = read.ok ? read.doc : null;
    const values: Partial<Record<RuntimeSettingKey, SettingValue>> = {
      ...(doc?.values ?? {}),
    };
    const changed: RuntimeSettingKey[] = [];

    // A corrupt document must still be clearable even when `changed` comes out
    // empty (nothing readable to name), otherwise the recovery path is a no-op.
    let forceWrite = false;
    if (input.resetAll) {
      // Fall back to this node's known overrides when the stored doc could not
      // be read, so the audit record still names what was cleared.
      const known = read.ok
        ? Object.keys(values)
        : Object.keys(this.overrides);
      for (const k of known) {
        if (isRuntimeSettingKey(k)) changed.push(k);
      }
      for (const k of Object.keys(values)) {
        delete values[k as RuntimeSettingKey];
      }
      forceWrite = !read.ok;
    }

    for (const k of input.reset ?? []) {
      if (!isRuntimeSettingKey(k)) continue;
      if (values[k] !== undefined) {
        delete values[k];
        changed.push(k);
      }
    }

    for (const [k, rawValue] of Object.entries(input.patch ?? {})) {
      if (!isRuntimeSettingKey(k)) continue;
      const spec = SETTING_SPEC_BY_KEY.get(k)!;
      if (spec.type === "secret") {
        const s = typeof rawValue === "string" ? rawValue.trim() : "";
        // Never let the masked placeholder round-trip back in as a real value.
        if (!s || s === SECRET_MASK) continue;
        const nextSecret = s === SECRET_CLEAR ? "" : s;
        if (values[k] !== nextSecret) {
          values[k] = nextSecret;
          changed.push(k);
        }
        continue;
      }
      const coerced = coerceSetting(spec, rawValue);
      if (coerced === null) continue;
      // Setting a key back to its env default drops the override entirely,
      // so a later .env change is picked up again.
      if (coerced === this.envDefaults[k]) {
        if (values[k] !== undefined) {
          delete values[k];
          changed.push(k);
        }
        continue;
      }
      if (values[k] !== coerced) {
        values[k] = coerced;
        changed.push(k);
      }
    }

    const effectiveWeight = (key: RuntimeSettingKey): number =>
      Number(values[key] === undefined ? this.envDefaults[key] : values[key]);
    assertReplyCountWeights(
      ([1, 2, 3, 4] as const).map((count) =>
        effectiveWeight(`replyCountWeight${count}` as RuntimeSettingKey),
      ),
      "runtime reply count weights",
    );

    const nextDoc: RuntimeSettingsDoc = {
      values,
      updatedAt: new Date().toISOString(),
      updatedBy: input.actor || "admin",
    };
    if (changed.length || forceWrite) {
      await this.db.setJson(K.runtimeSettings, nextDoc);
    }
    // Force the next refresh() to re-apply even if the doc string matches.
    this.lastSeen = "";
    await this.refresh();

    const uniqueChanged = [...new Set(changed)];
    return {
      view: this.view(),
      changed: uniqueChanged,
      restartRequired: uniqueChanged.filter(
        (k) => SETTING_SPEC_BY_KEY.get(k)?.restart === true,
      ),
      warnings: this.warnings(),
    };
  }
}
