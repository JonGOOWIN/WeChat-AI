import assert from "node:assert/strict";
import { describe, it, type TestContext } from "node:test";
import {
  ensurePeer,
  getPeerConversationQuality,
  listPeers,
  openDatabase,
  setPeerConversationQuality,
  setPeerProactiveEnabled,
  touchPeerActivity,
  type Peer,
} from "./index.js";
import { K } from "./keys.js";

const redisUrl = process.env.REDIS_URL ?? "redis://127.0.0.1:6379";

async function fixture(t: TestContext) {
  const db = openDatabase(redisUrl);
  try { await db.ping(); } catch {
    db.close();
    t.skip("Redis not available");
    return null;
  }
  t.after(() => db.close());
  const botId = `quality:bot:${process.pid}:${Math.random()}`;
  return { db, botId };
}

describe("peer conversation quality storage", () => {
  it("generates an unambiguous bot-and-peer scoped key for opaque ids", () => {
    assert.notEqual(
      K.peerQuality("bot:a", "peer"),
      K.peerQuality("bot", "a:peer"),
    );
    assert.match(K.peerQuality("机器人/a", "wx:user|1"), /^wa:peer-quality:/);
  });

  it("merges fields, clears with null and deletes an empty override", async (t) => {
    const f = await fixture(t); if (!f) return;
    const peerId = "wx:user|opaque";
    await ensurePeer(f.db, f.botId, peerId);
    await setPeerConversationQuality(f.db, f.botId, peerId, {
      coveragePercent: 41,
      lengthWeights: [20, 70, 10],
    });
    assert.deepEqual(await getPeerConversationQuality(f.db, f.botId, peerId), {
      coveragePercent: 41,
      lengthWeights: [20, 70, 10],
    });
    await setPeerConversationQuality(f.db, f.botId, peerId, {
      coveragePercent: null,
      followUpPercent: 32,
    });
    assert.deepEqual(await getPeerConversationQuality(f.db, f.botId, peerId), {
      lengthWeights: [20, 70, 10],
      followUpPercent: 32,
    });
    await setPeerConversationQuality(f.db, f.botId, peerId, null);
    assert.equal(await f.db.redis.exists(K.peerQuality(f.botId, peerId)), 0);
    await setPeerConversationQuality(f.db, f.botId, peerId, { followUpPercent: 20 });
    await setPeerConversationQuality(f.db, f.botId, peerId, {});
    assert.equal(await f.db.redis.exists(K.peerQuality(f.botId, peerId)), 0);
  });

  it("enriches a peer list in one batch and never changes Peer JSON", async (t) => {
    const f = await fixture(t); if (!f) return;
    await Promise.all(["p:1", "p:2"].map((id) => ensurePeer(f.db, f.botId, id)));
    await setPeerConversationQuality(f.db, f.botId, "p:1", { coveragePercent: 51 });
    const originalMget = f.db.mgetJson.bind(f.db);
    let batches = 0;
    f.db.mgetJson = async (...args) => { batches++; return originalMget(...args); };
    const peers = await listPeers(f.db, f.botId);
    assert.equal(batches, 1);
    assert.deepEqual(
      peers.find((p) => p.peer_id === "p:1")?.conversation_quality,
      { coveragePercent: 51 },
    );
    const stored = await f.db.getJson<Peer>(K.peer(f.botId, "p:1"));
    assert.equal("conversation_quality" in (stored as object), false);
  });

  it("keeps a concurrent quality save isolated from activity and proactive writes", async (t) => {
    const f = await fixture(t); if (!f) return;
    const peerId = "concurrent";
    await ensurePeer(f.db, f.botId, peerId);
    await Promise.all([
      setPeerConversationQuality(f.db, f.botId, peerId, { emotionContinuityTurns: 7 }),
      touchPeerActivity(f.db, f.botId, peerId, "2026-08-12T00:00:00.000Z"),
    ]);
    await setPeerProactiveEnabled(f.db, f.botId, peerId, false);
    assert.deepEqual(await getPeerConversationQuality(f.db, f.botId, peerId), {
      emotionContinuityTurns: 7,
    });
  });

  it("treats malformed optional overlay JSON as inheritance and still clears it", async (t) => {
    const f = await fixture(t); if (!f) return;
    const peerId = "malformed-overlay";
    await ensurePeer(f.db, f.botId, peerId);
    await f.db.redis.set(K.peerQuality(f.botId, peerId), "{");
    assert.deepEqual(await getPeerConversationQuality(f.db, f.botId, peerId), {});
    const peers = await listPeers(f.db, f.botId);
    assert.equal(
      peers.find((peer) => peer.peer_id === peerId)?.conversation_quality,
      undefined,
    );
    await setPeerConversationQuality(f.db, f.botId, peerId, {
      coveragePercent: null,
      followUpPercent: null,
      lengthWeights: null,
      emotionContinuityTurns: null,
      repetitionWindowAssistantTurns: null,
    });
    assert.equal(await f.db.redis.exists(K.peerQuality(f.botId, peerId)), 0);
  });

  it("does not disguise a Redis I/O failure as inheritance", async (t) => {
    const db = openDatabase(redisUrl);
    try { await db.ping(); } catch { db.close(); t.skip("Redis not available"); return; }
    await db.close();
    await assert.rejects(
      () => getPeerConversationQuality(db, "io-failure-bot", "peer"),
      /closed|connection|enableOfflineQueue/i,
    );
  });
});
