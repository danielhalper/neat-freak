import test from "node:test";
import assert from "node:assert/strict";
import { applySmartHeuristic } from "../src/smart-scope.js";

const NOW = 1_700_000_000_000;
const minutesAgo = (mins) => NOW - mins * 60_000;
const tab = (id, mins) => ({ id, lastAccessed: minutesAgo(mins) });

test("stale cluster (no tab in last hour) closes anything > 3h old", () => {
  // No tab in last 60 min → cluster is stale → cutoff = 180min (3h).
  // a (120min) ≤ 180 → keep. b (200), c (500) > 180 → save.
  const tabs = [tab("a", 120), tab("b", 200), tab("c", 500)];
  const clusters = [{ id: "c1", tabIds: ["a", "b", "c"] }];
  const { saveIds, keepIds } = applySmartHeuristic(tabs, clusters, NOW);
  assert.deepEqual(saveIds.sort(), ["b", "c"]);
  assert.deepEqual(keepIds, ["a"]);
});

test("active cluster (≥1 tab in last hour) closes anything > 8h old", () => {
  // a (30min) is in last 60 → cluster is active → cutoff = 480min (8h).
  // a, b (200), c (400) all ≤ 480 → keep. d (700) > 480 → save.
  const tabs = [tab("a", 30), tab("b", 200), tab("c", 400), tab("d", 700)];
  const clusters = [{ id: "c1", tabIds: ["a", "b", "c", "d"] }];
  const { saveIds, keepIds } = applySmartHeuristic(tabs, clusters, NOW);
  assert.deepEqual(saveIds, ["d"]);
  assert.deepEqual(keepIds.sort(), ["a", "b", "c"]);
});

test("multiple clusters evaluated independently", () => {
  // c1: a=10 → active → cutoff 480. b=200 ≤ 480 → keep.
  // c2: c=200, d=500 → no recent → stale → cutoff 180. Both > 180 → save.
  const tabs = [
    tab("a", 10), tab("b", 200),
    tab("c", 200), tab("d", 500),
  ];
  const clusters = [
    { id: "c1", tabIds: ["a", "b"] },
    { id: "c2", tabIds: ["c", "d"] },
  ];
  const { saveIds, keepIds } = applySmartHeuristic(tabs, clusters, NOW);
  assert.deepEqual(saveIds.sort(), ["c", "d"]);
  assert.deepEqual(keepIds.sort(), ["a", "b"]);
});

test("tab with no lastAccessed treated as just-opened (kept)", () => {
  // c1: a=30 → active → cutoff 480.
  // b has no lastAccessed (e.g. cmd-click opened in background, never activated)
  // → treated as "now" → kept. Protects fresh background tabs from being
  // mistaken for ancient abandoned ones.
  const tabs = [tab("a", 30), { id: "b" }];
  const clusters = [{ id: "c1", tabIds: ["a", "b"] }];
  const { saveIds, keepIds } = applySmartHeuristic(tabs, clusters, NOW);
  assert.deepEqual(saveIds, []);
  assert.deepEqual(keepIds.sort(), ["a", "b"]);
});

test("empty tab list returns empty sets", () => {
  const { saveIds, keepIds } = applySmartHeuristic([], [], NOW);
  assert.deepEqual(saveIds, []);
  assert.deepEqual(keepIds, []);
});

test("tab not assigned to any cluster is kept", () => {
  // Defensive — shouldn't happen in practice but should not crash.
  const tabs = [tab("a", 30), tab("orphan", 999)];
  const clusters = [{ id: "c1", tabIds: ["a"] }];
  const { saveIds, keepIds } = applySmartHeuristic(tabs, clusters, NOW);
  assert.deepEqual(keepIds.sort(), ["a", "orphan"]);
  assert.deepEqual(saveIds, []);
});

import { runSmartScope } from "../src/smart-scope.js";

test("runSmartScope with heuristic — splits tabs and returns categories", async () => {
  const now = NOW;
  const tabs = [
    { id: "a", title: "Mastery doc", url: "https://docs.google.com/document/a", domain: "docs.google.com", lastAccessed: minutesAgo(10) },
    { id: "b", title: "Mastery sheet", url: "https://docs.google.com/spreadsheets/b", domain: "docs.google.com", lastAccessed: minutesAgo(300) },
    { id: "c", title: "Random old article", url: "https://example.com/post-c", domain: "example.com", lastAccessed: minutesAgo(900) },
  ];
  // No LLM key → heuristic path.
  const result = await runSmartScope(tabs, { llmEnabled: false, apiKey: "" }, { now });
  assert.equal(result.mode, "heuristic");

  const savedIds = result.saveSet.map((t) => t.id);
  const keptIds = result.keepSet.map((t) => t.id);

  // 'c' is 900 min old, in some cluster — must be saved regardless of cluster activity (900 > 480).
  assert.ok(savedIds.includes("c"), `expected 'c' to be saved, got ${savedIds.join(",")}`);
  // 'a' is 10 min old — recent → kept.
  assert.ok(keptIds.includes("a"), `expected 'a' to be kept, got ${keptIds.join(",")}`);
  // Categories only cover saved tabs.
  const categorizedIds = result.categories.flatMap((c) => c.tabIds);
  for (const id of savedIds) {
    assert.ok(categorizedIds.includes(id), `expected category to include saved tab ${id}`);
  }
  for (const id of keptIds) {
    assert.ok(!categorizedIds.includes(id), `expected category to NOT include kept tab ${id}`);
  }
});

test("runSmartScope with empty tab list returns empty sets", async () => {
  const result = await runSmartScope([], { llmEnabled: false, apiKey: "" }, { now: NOW });
  assert.deepEqual(result.saveSet, []);
  assert.deepEqual(result.keepSet, []);
  assert.deepEqual(result.categories, []);
  assert.equal(result.mode, "heuristic");
});
