import test from "node:test";
import assert from "node:assert/strict";
import { enforceRetention } from "../src/storage.js";

const T = 1_700_000_000_000;
const DAY = 86_400_000;
// A session with `numTabs` tabs, created at `createdAtMs`.
const session = (id, createdAtMs, numTabs, extra = {}) => ({
  id,
  createdAt: new Date(createdAtMs).toISOString(),
  closeStatus: "closed",
  pendingTabIds: [],
  tabs: Array.from({ length: numTabs }, (_, i) => ({ id: `${id}-t${i}`, url: `https://x/${id}/${i}` })),
  categories: [],
  ...extra
});

test("keeps whole sessions newest-first within the tab budget, prunes older", () => {
  // Newest→oldest: s4,s3,s2,s1, each 120 tabs. Budget 300.
  // s4 (120) + s3 (240) kept; s2 would push to 360 > 300 → stop.
  const sessions = [
    session("s1", T + 1 * DAY, 120),
    session("s2", T + 2 * DAY, 120),
    session("s3", T + 3 * DAY, 120),
    session("s4", T + 4 * DAY, 120)
  ];
  const kept = enforceRetention(sessions, { maxSavedTabs: 300 });
  assert.deepEqual(kept.map((s) => s.id), ["s4", "s3"]);
});

test("the newest session is kept even if it alone exceeds the budget", () => {
  const sessions = [
    session("old", T + 1 * DAY, 100),
    session("huge", T + 2 * DAY, 500) // newest, > budget by itself
  ];
  const kept = enforceRetention(sessions, { maxSavedTabs: 300 });
  assert.deepEqual(kept.map((s) => s.id), ["huge"]);
});

test("maxSavedTabs 0 keeps everything", () => {
  const sessions = [session("a", T + 2 * DAY, 40), session("b", T + 1 * DAY, 40)];
  const kept = enforceRetention(sessions, { maxSavedTabs: 0 });
  assert.equal(kept.length, 2);
});

test("a tiny limit clamps to the 100-tab floor", () => {
  // 5 sessions × 40 tabs. Limit 30 clamps up to 100 → keep s5 (40) + s4 (80); s3 → 120 > 100.
  const sessions = Array.from({ length: 5 }, (_, i) => session(`s${i + 1}`, T + (i + 1) * DAY, 40));
  const kept = enforceRetention(sessions, { maxSavedTabs: 30 });
  assert.deepEqual(kept.map((s) => s.id), ["s5", "s4"]);
});

test("review / pending sessions are never pruned and don't count toward the tab budget", () => {
  const sessions = [
    session("c3", T + 6 * DAY, 200),
    session("c2", T + 5 * DAY, 200),
    session("c1", T + 4 * DAY, 200),
    session("review-old", T + 1 * DAY, 200, { closeStatus: "review" }),
    session("pending-old", T + 2 * DAY, 200, { pendingTabIds: [101, 102] })
  ];
  // Budget 300: of the closed, keep newest (c3=200); c2 → 400 > 300 stops. Both protected kept.
  const kept = enforceRetention(sessions, { maxSavedTabs: 300 });
  const ids = new Set(kept.map((s) => s.id));
  assert.ok(ids.has("review-old"), "review session must survive");
  assert.ok(ids.has("pending-old"), "session with pending tabs must survive");
  assert.ok(ids.has("c3"), "newest closed kept");
  assert.ok(!ids.has("c2") && !ids.has("c1"), "older closed beyond budget pruned");
});

test("byte backstop drops oldest closed sessions while protecting review/pending", () => {
  const big = "x".repeat(2000);
  const tabWith = (n) => Array.from({ length: n }, () => ({ s: big }));
  const sessions = [
    { id: "p", createdAt: new Date(T + 10 * DAY).toISOString(), closeStatus: "review", pendingTabIds: [], tabs: tabWith(1) },
    { id: "c3", createdAt: new Date(T + 3 * DAY).toISOString(), closeStatus: "closed", pendingTabIds: [], tabs: tabWith(1) },
    { id: "c2", createdAt: new Date(T + 2 * DAY).toISOString(), closeStatus: "closed", pendingTabIds: [], tabs: tabWith(1) },
    { id: "c1", createdAt: new Date(T + 1 * DAY).toISOString(), closeStatus: "closed", pendingTabIds: [], tabs: tabWith(1) }
  ];
  // Unlimited tab count, but a tiny byte budget forces trimming oldest closed first.
  const kept = enforceRetention(sessions, { maxSavedTabs: 0 }, { byteBudget: 4500 });
  const ids = new Set(kept.map((s) => s.id));
  assert.ok(ids.has("p"), "protected session must survive the byte backstop");
  assert.ok(ids.has("c3"), "newest closed survives");
  assert.ok(!ids.has("c1"), "oldest closed dropped first");
  assert.ok(kept.length < 4, "byte backstop trimmed something");
});

test("empty / non-array input is handled", () => {
  assert.deepEqual(enforceRetention([], { maxSavedTabs: 5000 }), []);
  assert.deepEqual(enforceRetention(undefined, { maxSavedTabs: 5000 }), []);
});
