import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createPersona,
  forkPersona,
  generatePersonaSlug,
  getPersona,
  personaHeatScore,
  updatePersonaMeta,
} from "./repos.js";
import { openDatabase } from "./client.js";
import { K } from "./keys.js";

const redisUrl = process.env.REDIS_URL ?? "redis://127.0.0.1:6379";

describe("generatePersonaSlug", () => {
  it("produces unique-ish slugs", () => {
    const a = generatePersonaSlug("user123", "腹黑学姐");
    const b = generatePersonaSlug("user123", "腹黑学姐");
    assert.match(a, /^p-/);
    assert.notEqual(a, b);
  });
});

describe("personaHeatScore", () => {
  it("weights use / assign / fork", () => {
    assert.equal(personaHeatScore({}), 0);
    assert.equal(
      personaHeatScore({ use_count: 1, assign_count: 1, fork_count: 1 }),
      2 + 5 + 3,
    );
    assert.equal(personaHeatScore({ use_count: 3 }), 6);
  });
});

describe("persona conversation quality overrides", () => {
  it("stores only the explicitly overridden fields on create", async (t) => {
    const db = openDatabase(redisUrl);
    t.after(() => db.close());
    try {
      await db.ping();
    } catch {
      t.skip("Redis not available");
      return;
    }

    const persona = await createPersona(db, {
      displayName: `quality-create-${process.pid}`,
      systemPrompt: "reply as a quality test persona",
      ownerUserId: `quality-owner-${process.pid}`,
      visibility: "private",
      conversationQuality: {
        coveragePercent: 42,
        emotionContinuityTurns: 7,
      },
    });

    const loaded = await getPersona(db, persona.id);
    assert.deepEqual(loaded?.conversation_quality, {
      coveragePercent: 42,
      emotionContinuityTurns: 7,
    });
  });

  it("distinguishes omitted, cleared, and concrete fields on update", async (t) => {
    const db = openDatabase(redisUrl);
    t.after(() => db.close());
    try {
      await db.ping();
    } catch {
      t.skip("Redis not available");
      return;
    }
    const persona = await createPersona(db, {
      displayName: `quality-update-${process.pid}`,
      systemPrompt: "quality update",
      ownerUserId: `quality-owner-${process.pid}`,
      visibility: "private",
      conversationQuality: {
        coveragePercent: 41,
        followUpPercent: 22,
        lengthWeights: [50, 40, 10],
      },
    });

    await updatePersonaMeta(db, persona.id, {
      description: "unrelated update",
      conversationQuality: {
        coveragePercent: null,
        followUpPercent: 33,
      },
    });
    const loaded = await getPersona(db, persona.id);
    assert.deepEqual(loaded?.conversation_quality, {
      followUpPercent: 33,
      lengthWeights: [50, 40, 10],
    });
  });

  it("reads legacy JSON without materializing global quality defaults", async (t) => {
    const db = openDatabase(redisUrl);
    t.after(() => db.close());
    try {
      await db.ping();
    } catch {
      t.skip("Redis not available");
      return;
    }
    const id = `persona_legacy_quality_${process.pid}`;
    await db.setJson(K.persona(id), {
      id,
      slug: `legacy-quality-${process.pid}`,
      display_name: "legacy",
      description: "",
      content_policy: "standard",
      is_default: 0,
      enabled: 1,
      published_version_id: null,
      owner_user_id: "system",
      visibility: "public",
      tags: [],
      use_count: 0,
    });

    const loaded = await getPersona(db, id);
    assert.equal(loaded?.conversation_quality, undefined);
  });

  it("forks the quality patch but never the source credential", async (t) => {
    const db = openDatabase(redisUrl);
    t.after(() => db.close());
    try {
      await db.ping();
    } catch {
      t.skip("Redis not available");
      return;
    }
    const source = await createPersona(db, {
      displayName: `quality-fork-${process.pid}`,
      systemPrompt: "quality fork",
      ownerUserId: `source-owner-${process.pid}`,
      visibility: "public",
      llmProviderId: "private-provider-id",
      conversationQuality: { repetitionWindowAssistantTurns: 3 },
    });

    const { persona } = await forkPersona(db, {
      sourceId: source.id,
      ownerUserId: `fork-owner-${process.pid}`,
    });
    assert.deepEqual(persona.conversation_quality, {
      repetitionWindowAssistantTurns: 3,
    });
    assert.equal(persona.llm_provider_id, null);
  });

  it("rejects invalid ranges and non-100 length weights before storage", async (t) => {
    const db = openDatabase(redisUrl);
    t.after(() => db.close());
    try {
      await db.ping();
    } catch {
      t.skip("Redis not available");
      return;
    }
    const base = {
      displayName: `quality-invalid-${process.pid}`,
      systemPrompt: "quality invalid",
      ownerUserId: `quality-owner-${process.pid}`,
      visibility: "private" as const,
    };
    await assert.rejects(
      createPersona(db, {
        ...base,
        conversationQuality: { coveragePercent: 101 },
      }),
      /coveragePercent.*0.*100/,
    );
    await assert.rejects(
      createPersona(db, {
        ...base,
        conversationQuality: { lengthWeights: [60, 30, 9] },
      }),
      /totaling 100/,
    );
    await assert.rejects(
      createPersona(db, {
        ...base,
        conversationQuality: { surprise: 1 } as never,
      }),
      /unknown conversationQuality field: surprise/,
    );

    const existing = await createPersona(db, {
      ...base,
      displayName: `quality-invalid-update-${process.pid}`,
      description: "before",
    });
    await assert.rejects(
      updatePersonaMeta(db, existing.id, {
        description: "must not partially apply",
        conversationQuality: { emotionContinuityTurns: 2.5 },
      }),
      /emotionContinuityTurns.*integer/,
    );
    assert.equal((await getPersona(db, existing.id))?.description, "before");
  });
});
