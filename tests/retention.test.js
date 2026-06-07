import test from "node:test";
import assert from "node:assert/strict";
import { enforceRetention } from "../src/storage.js";

const T = 1_700_000_000_000;
const DAY = 86_400_000;
const session = (id, createdAtMs, extra = {}) => ({
  id,
  createdAt: new Date(createdAtMs).toISOString(),
  closeStatus: "closed",
  pendingTabIds: [],
  tabs: [],
  categories: [],
  ...extra
});

test("count limit keeps the newest N, prunes the oldest (newest-first order)", () => {
  // 25 sessions, limit 20 → newest 20 kept, oldest 5 pruned. (Input order shuffled.)
  const sessions = Array.from({ length: 25 }, (_, i) => session(`s${i}`, T + i * DAY)); // s24 newest
  const kept = enforceRetention(sessions.slice().reverse(), { maxSavedSessions: 20 });
  assert.equal(kept.length, 20);
  assert.equal(kept[0].id, "s24", "returned newest-first");
  const ids = new Set(kept.map((s) => s.id));
  assert.ok(ids.has("s24") && ids.has("s5"), "newest 20 (s24..s5) kept");
  assert.ok(!ids.has("s4") && !ids.has("s0"), "oldest 5 pruned");
});

test("maxSavedSessions 0 keeps everything", () => {
  const sessions = [session("a", T + 2 * DAY), session("b", T + 1 * DAY)];
  const kept = enforceRetention(sessions, { maxSavedSessions: 0 });
  assert.equal(kept.length, 2);
});

test("a tiny limit clamps to a 20-session floor (no over-aggressive nuking)", () => {
  const sessions = Array.from({ length: 30 }, (_, i) => session(`s${i}`, T + i * DAY));
  const kept = enforceRetention(sessions, { maxSavedSessions: 5 }); // 5 clamps up to 20
  assert.equal(kept.length, 20);
});

test("review / pending sessions are never pruned and don't count against the limit", () => {
  // 21 closed (c0 oldest .. c20 newest) + 2 old protected. Limit 20.
  const closed = Array.from({ length: 21 }, (_, i) => session(`c${i}`, T + (i + 5) * DAY));
  const sessions = [
    ...closed,
    session("review-old", T + 1 * DAY, { closeStatus: "review" }),
    session("pending-old", T + 2 * DAY, { pendingTabIds: [101, 102] })
  ];
  // Of the 21 closed, keep newest 20 (prune c0); both protected always kept and uncounted.
  const kept = enforceRetention(sessions, { maxSavedSessions: 20 });
  const ids = new Set(kept.map((s) => s.id));
  assert.ok(ids.has("review-old"), "review session must survive");
  assert.ok(ids.has("pending-old"), "session with pending tabs must survive");
  assert.ok(ids.has("c20") && ids.has("c1"), "newest 20 closed kept");
  assert.ok(!ids.has("c0"), "oldest closed beyond the limit is pruned");
  assert.equal(kept.length, 22, "20 closed + 2 protected");
});

test("byte backstop drops oldest closed sessions while protecting review/pending", () => {
  const big = "x".repeat(2000);
  const sessions = [
    session("p", T + 10 * DAY, { closeStatus: "review", tabs: [{ s: big }] }),
    session("c3", T + 3 * DAY, { tabs: [{ s: big }] }),
    session("c2", T + 2 * DAY, { tabs: [{ s: big }] }),
    session("c1", T + 1 * DAY, { tabs: [{ s: big }] })
  ];
  // Unlimited count, but a tiny byte budget forces trimming oldest closed first.
  const kept = enforceRetention(sessions, { maxSavedSessions: 0 }, { byteBudget: 4500 });
  const ids = kept.map((s) => s.id);
  assert.ok(ids.includes("p"), "protected session must survive the byte backstop");
  assert.ok(ids.includes("c3"), "newest closed survives");
  assert.ok(!ids.includes("c1"), "oldest closed is dropped first");
  assert.ok(kept.length < 4, "byte backstop trimmed something");
});

test("empty / non-array input is handled", () => {
  assert.deepEqual(enforceRetention([], { maxSavedSessions: 180 }), []);
  assert.deepEqual(enforceRetention(undefined, { maxSavedSessions: 180 }), []);
});
