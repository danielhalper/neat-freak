import test from "node:test";
import assert from "node:assert/strict";
import { applySmartHeuristic } from "../src/smart-scope.js";

const NOW = 1_700_000_000_000;
const minutesAgo = (mins) => NOW - mins * 60_000;
const tab = (id, mins) => ({ id, lastAccessed: minutesAgo(mins) });
const tabWithUrl = (id, mins, url) => ({ id, lastAccessed: minutesAgo(mins), url });

test("stale cluster (no tab in last 30 min) saves the whole cluster", () => {
  // No tab in last 30 min → cluster is stale → cutoff = 30 min.
  // Every tab in a stale cluster is by definition > 30 min, so all get saved.
  const tabs = [tab("a", 90), tab("b", 200), tab("c", 500)];
  const clusters = [{ id: "c1", tabIds: ["a", "b", "c"] }];
  const { saveIds, keepIds } = applySmartHeuristic(tabs, clusters, NOW);
  assert.deepEqual(saveIds.sort(), ["a", "b", "c"]);
  assert.deepEqual(keepIds, []);
});

test("active cluster (≥1 tab in last 30 min) closes anything > 1.5h old", () => {
  // a (30 min) sits exactly on the boundary; 30 <= 30 keeps the cluster
  // active. Cutoff = 90 min (1.5h). a (≤90) keep; b/c/d > 90 → save.
  const tabs = [tab("a", 30), tab("b", 200), tab("c", 400), tab("d", 700)];
  const clusters = [{ id: "c1", tabIds: ["a", "b", "c", "d"] }];
  const { saveIds, keepIds } = applySmartHeuristic(tabs, clusters, NOW);
  assert.deepEqual(saveIds.sort(), ["b", "c", "d"]);
  assert.deepEqual(keepIds, ["a"]);
});

test("multiple clusters evaluated independently", () => {
  // c1: a=10 → active → cutoff 90. b=200 > 90 → save.
  // c2: c=200, d=500 → no recent → stale → save whole cluster.
  const tabs = [
    tab("a", 10), tab("b", 200),
    tab("c", 200), tab("d", 500),
  ];
  const clusters = [
    { id: "c1", tabIds: ["a", "b"] },
    { id: "c2", tabIds: ["c", "d"] },
  ];
  const { saveIds, keepIds } = applySmartHeuristic(tabs, clusters, NOW);
  assert.deepEqual(saveIds.sort(), ["b", "c", "d"]);
  assert.deepEqual(keepIds, ["a"]);
});

test("tab with no lastAccessed treated as just-opened (kept)", () => {
  // c1: a=10 → active → cutoff 90.
  // b has no lastAccessed (e.g. cmd-click opened in background, never activated)
  // → treated as "now" → kept. Protects fresh background tabs from being
  // mistaken for ancient abandoned ones.
  const tabs = [tab("a", 10), { id: "b" }];
  const clusters = [{ id: "c1", tabIds: ["a", "b"] }];
  const { saveIds, keepIds } = applySmartHeuristic(tabs, clusters, NOW);
  assert.deepEqual(saveIds, []);
  assert.deepEqual(keepIds.sort(), ["a", "b"]);
});

test("URL dedup: older duplicates of the same URL are force-saved", () => {
  // All three share the same URL. The most-recently-accessed (a, 5 min)
  // stays open; the older duplicates b (20) and c (40) get saved as
  // duplicates regardless of cutoff. Cluster is active (5 ≤ 30), cutoff 90,
  // so without dedup b and c would both be kept (≤ 90).
  const tabs = [
    tabWithUrl("a", 5,  "https://docs.example.com/x"),
    tabWithUrl("b", 20, "https://docs.example.com/x"),
    tabWithUrl("c", 40, "https://docs.example.com/x"),
  ];
  const clusters = [{ id: "c1", tabIds: ["a", "b", "c"] }];
  const { saveIds, keepIds } = applySmartHeuristic(tabs, clusters, NOW);
  assert.deepEqual(saveIds.sort(), ["b", "c"]);
  assert.deepEqual(keepIds, ["a"]);
});

test("URL dedup respects exact URL match (different URLs not deduped)", () => {
  // Same domain, different paths → not duplicates. Both kept under the
  // active-cluster cutoff.
  const tabs = [
    tabWithUrl("a", 5,  "https://docs.example.com/x"),
    tabWithUrl("b", 10, "https://docs.example.com/y"),
  ];
  const clusters = [{ id: "c1", tabIds: ["a", "b"] }];
  const { saveIds, keepIds } = applySmartHeuristic(tabs, clusters, NOW);
  assert.deepEqual(saveIds, []);
  assert.deepEqual(keepIds.sort(), ["a", "b"]);
});

test("heuristic floor: ≥8 tabs all-recent saves ~40% via content + recency", () => {
  // Simulates the "fresh browser session, user flipped through tabs" case:
  // 10 tabs, all touched in the last 20 min (all active cluster, no cutoff
  // would fire), no URL duplicates. Without the floor, saveIds would be
  // empty. With the floor, the top-40% by combined score gets saved.
  // Content scoring biases active surfaces (docs) toward keep and skim-once
  // URLs (articles, search results) toward save.
  const tabs = [
    tabWithUrl("doc1",      2,  "https://docs.google.com/document/d/abc/edit"),
    tabWithUrl("doc2",      4,  "https://docs.google.com/document/d/def/edit"),
    tabWithUrl("mail",      6,  "https://mail.google.com/mail/u/0/#inbox"),
    tabWithUrl("calendar",  8,  "https://calendar.google.com/calendar/u/0/r"),
    tabWithUrl("article1",  10, "https://www.theverge.com/post/abc-article"),
    tabWithUrl("article2",  12, "https://medium.com/some-blog/post/123"),
    tabWithUrl("issue",     14, "https://github.com/foo/bar/issues/42"),
    tabWithUrl("search",    16, "https://www.google.com/search?q=hello"),
    tabWithUrl("so",        18, "https://stackoverflow.com/questions/12345/x"),
    tabWithUrl("news",      20, "https://www.nytimes.com/2024/01/01/story"),
  ];
  const clusters = [{ id: "c1", tabIds: tabs.map((t) => t.id) }];
  const { saveIds, keepIds } = applySmartHeuristic(tabs, clusters, NOW);

  // 40% of 10 = 4 saves.
  assert.equal(saveIds.length, 4);
  assert.equal(keepIds.length, 6);
  // The four highest-scored should be skim-once URLs, not docs/mail/calendar.
  const saveSet = new Set(saveIds);
  for (const keepable of ["doc1", "doc2", "mail", "calendar"]) {
    assert.ok(!saveSet.has(keepable), `expected ${keepable} to be kept, got saveIds=${saveIds.join(",")}`);
  }
});

test("heuristic floor does NOT fire under 8 tabs", () => {
  // Same all-recent pattern but only 6 tabs — floor stays off, existing
  // cutoff logic produces zero saves and we leave it that way.
  const tabs = [
    tabWithUrl("a", 5,  "https://example.com/article-1"),
    tabWithUrl("b", 10, "https://example.com/article-2"),
    tabWithUrl("c", 15, "https://example.com/article-3"),
    tabWithUrl("d", 20, "https://example.com/article-4"),
    tabWithUrl("e", 25, "https://example.com/article-5"),
    tabWithUrl("f", 30, "https://example.com/article-6"),
  ];
  const clusters = [{ id: "c1", tabIds: tabs.map((t) => t.id) }];
  const { saveIds, keepIds } = applySmartHeuristic(tabs, clusters, NOW);
  assert.deepEqual(saveIds, []);
  assert.equal(keepIds.length, 6);
});

test("heuristic floor does NOT fire when normal cutoff already saves something", () => {
  // 10 tabs but one is genuinely old (5h ago), in an active cluster. Normal
  // cutoff saves that one; floor doesn't escalate.
  const tabs = [
    tabWithUrl("recent1", 5,   "https://example.com/article-1"),
    tabWithUrl("recent2", 10,  "https://example.com/article-2"),
    tabWithUrl("recent3", 15,  "https://example.com/article-3"),
    tabWithUrl("recent4", 20,  "https://example.com/article-4"),
    tabWithUrl("recent5", 25,  "https://example.com/article-5"),
    tabWithUrl("recent6", 28,  "https://example.com/article-6"),
    tabWithUrl("recent7", 30,  "https://example.com/article-7"),
    tabWithUrl("recent8", 35,  "https://example.com/article-8"),
    tabWithUrl("recent9", 40,  "https://example.com/article-9"),
    tabWithUrl("ancient", 300, "https://example.com/old-article"),
  ];
  const clusters = [{ id: "c1", tabIds: tabs.map((t) => t.id) }];
  const { saveIds, keepIds } = applySmartHeuristic(tabs, clusters, NOW);
  // Normal cutoff (active cluster, 90min cutoff) saves the 300-min tab.
  // Floor does not fire because saveIds.length > 0.
  assert.deepEqual(saveIds, ["ancient"]);
  assert.equal(keepIds.length, 9);
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

  // 'c' is 900 min old, in some cluster — must be saved regardless of cluster activity (900 > 180).
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
