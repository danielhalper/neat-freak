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

test("runSmartScope minSaveCount tops up under-threshold smart picks", async () => {
  // 5 all-recent tabs → heuristic floor doesn't fire (< 8) and the absolute
  // cutoff saves nothing. Without minSaveCount, this returns 0 saves.
  // minSaveCount = 3 forces top-up; ranking prefers skim-once content over
  // active work surfaces.
  const tabs = [
    { id: "doc",   title: "Doc",   url: "https://docs.google.com/document/d/a/edit", domain: "docs.google.com", lastAccessed: minutesAgo(2) },
    { id: "mail",  title: "Mail",  url: "https://mail.google.com/mail/u/0/#inbox",   domain: "mail.google.com", lastAccessed: minutesAgo(4) },
    { id: "blog1", title: "Blog 1", url: "https://medium.com/blog/post-1",            domain: "medium.com",      lastAccessed: minutesAgo(6) },
    { id: "blog2", title: "Blog 2", url: "https://medium.com/blog/post-2",            domain: "medium.com",      lastAccessed: minutesAgo(8) },
    { id: "blog3", title: "Blog 3", url: "https://medium.com/blog/post-3",            domain: "medium.com",      lastAccessed: minutesAgo(10) },
  ];
  const result = await runSmartScope(
    tabs, { llmEnabled: false, apiKey: "" }, { now: NOW, minSaveCount: 3 }
  );
  assert.equal(result.saveSet.length, 3, `expected 3 saves, got ${result.saveSet.length}`);
  const savedIds = new Set(result.saveSet.map((t) => t.id));
  for (const blog of ["blog1", "blog2", "blog3"]) {
    assert.ok(savedIds.has(blog), `expected ${blog} saved`);
  }
  for (const surface of ["doc", "mail"]) {
    assert.ok(!savedIds.has(surface), `expected ${surface} kept`);
  }
  // Every saved tab is covered by exactly one category.
  const categorized = result.categories.flatMap((c) => c.tabIds);
  for (const id of savedIds) {
    assert.ok(categorized.includes(id), `expected category coverage for ${id}`);
  }
});

test("runSmartScope minSaveCount protects never-activated background tabs", async () => {
  const tabs = [
    { id: "bg", title: "Background article", url: "https://medium.com/blog/background", domain: "medium.com" },
    { id: "blog1", title: "Blog 1", url: "https://medium.com/blog/post-1", domain: "medium.com", lastAccessed: minutesAgo(20) },
    { id: "blog2", title: "Blog 2", url: "https://medium.com/blog/post-2", domain: "medium.com", lastAccessed: minutesAgo(25) },
    { id: "doc", title: "Doc", url: "https://docs.google.com/document/d/a/edit", domain: "docs.google.com", lastAccessed: minutesAgo(10) },
  ];
  const result = await runSmartScope(
    tabs, { llmEnabled: false, apiKey: "" }, { now: NOW, minSaveCount: 2 }
  );
  const savedIds = new Set(result.saveSet.map((tabItem) => tabItem.id));
  assert.ok(savedIds.has("blog1"));
  assert.ok(savedIds.has("blog2"));
  assert.ok(!savedIds.has("bg"), "never-activated background tab should be a last-resort save");
  assert.ok(!savedIds.has("doc"), "active work surface should be a last-resort save");
});

test("runSmartScope minSaveCount of 0 is a no-op", async () => {
  const tabs = [
    { id: "a", title: "A", url: "https://example.com/a", lastAccessed: minutesAgo(5) },
    { id: "b", title: "B", url: "https://example.com/b", lastAccessed: minutesAgo(10) },
  ];
  const result = await runSmartScope(
    tabs, { llmEnabled: false, apiKey: "" }, { now: NOW, minSaveCount: 0 }
  );
  assert.equal(result.saveSet.length, 0);
});

test("runSmartScope minSaveCount caps at total tab count", async () => {
  // Caller asked for more saves than we have tabs — cap, save everything.
  const tabs = [
    { id: "a", title: "A", url: "https://example.com/a", lastAccessed: minutesAgo(5) },
    { id: "b", title: "B", url: "https://example.com/b", lastAccessed: minutesAgo(10) },
  ];
  const result = await runSmartScope(
    tabs, { llmEnabled: false, apiKey: "" }, { now: NOW, minSaveCount: 99 }
  );
  assert.equal(result.saveSet.length, 2);
});

test("runSmartScope never closes the active tab, even under a maxed-out floor", async () => {
  // The tab the user is on (active) and an audio-playing tab must never end
  // up in the save set — not even when minSaveCount would force-save all.
  const tabs = [
    { id: "current", title: "Current", url: "https://example.com/now", lastAccessed: minutesAgo(1), active: true },
    { id: "music",   title: "Music",   url: "https://music.example.com", lastAccessed: minutesAgo(3), audible: true },
    { id: "blog",    title: "Blog",    url: "https://medium.com/blog/x", lastAccessed: minutesAgo(40) },
  ];
  const result = await runSmartScope(
    tabs, { llmEnabled: false, apiKey: "" }, { now: NOW, minSaveCount: 99 }
  );
  const savedIds = new Set(result.saveSet.map((t) => t.id));
  assert.ok(!savedIds.has("current"), "active tab must never be saved/closed");
  assert.ok(!savedIds.has("music"), "audible tab must never be saved/closed");
  // No category should reference a protected tab either.
  const categorized = result.categories.flatMap((c) => c.tabIds);
  assert.ok(!categorized.includes("current"), "active tab must not appear in a folder");
  assert.ok(!categorized.includes("music"), "audible tab must not appear in a folder");
});

test("runSmartScope does not undo smart's own picks when floor is small", async () => {
  // One ancient tab — heuristic saves it on its own. minSaveCount=0 must not
  // shrink that pick.
  const tabs = [
    { id: "old",    title: "Old",    url: "https://example.com/old",                  lastAccessed: minutesAgo(900) },
    { id: "recent", title: "Recent", url: "https://docs.google.com/document/d/x/edit", lastAccessed: minutesAgo(5) },
  ];
  const result = await runSmartScope(
    tabs, { llmEnabled: false, apiKey: "" }, { now: NOW, minSaveCount: 0 }
  );
  assert.ok(result.saveSet.some((t) => t.id === "old"));
});

test("runSmartScope LLM receives the save floor and keeps floor-added tabs out of unrelated LLM folders", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });

  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    const userPayload = JSON.parse(body.messages[1].content);
    assert.equal(userPayload.saveFloor.minSaveCount, 2);
    assert.equal(userPayload.saveFloor.totalOpenTabCount, 4);
    assert.equal(userPayload.saveFloor.clutterThreshold, 3);
    assert.match(body.messages[0].content, /at least 2/);

    return {
      ok: true,
      async json() {
        return {
          choices: [{
            message: {
              content: JSON.stringify({
                groups: [{
                  name: "Proposal",
                  description: "Client proposal work",
                  confidence: 0.9,
                  signals: ["proposal"],
                  tabIds: ["doc"]
                }],
                tabActions: [
                  { tabId: "doc", action: "save", reason: "old proposal reference" },
                  { tabId: "blog", action: "keep", reason: "recent" },
                  { tabId: "search", action: "keep", reason: "recent" }
                ]
              })
            }
          }]
        };
      }
    };
  };

  const tabs = [
    { id: "doc", title: "Proposal", url: "https://docs.google.com/document/d/p/edit", domain: "docs.google.com", lastAccessed: minutesAgo(240) },
    { id: "blog", title: "API blog post", url: "https://medium.com/blog/api-post", domain: "medium.com", lastAccessed: minutesAgo(12) },
    { id: "search", title: "API search", url: "https://www.google.com/search?q=api", domain: "www.google.com", lastAccessed: minutesAgo(8) },
  ];
  const result = await runSmartScope(tabs, { llmEnabled: true, apiKey: "test-key" }, {
    now: NOW,
    minSaveCount: 2,
    totalOpenTabCount: 4,
    clutterThreshold: 3
  });

  assert.equal(result.mode, "llm");
  assert.equal(result.saveSet.length, 2);
  const addedIds = result.saveSet.map((tabItem) => tabItem.id).filter((id) => id !== "doc");
  assert.equal(addedIds.length, 1);

  const proposal = result.categories.find((category) => category.name === "Proposal");
  assert.ok(proposal, "expected LLM Proposal category");
  assert.deepEqual(proposal.tabIds, ["doc"], "floor-added tab should not be merged into Proposal");

  const categoryHits = new Map();
  for (const category of result.categories) {
    for (const tabId of category.tabIds) {
      categoryHits.set(tabId, (categoryHits.get(tabId) || 0) + 1);
    }
  }
  for (const tabItem of result.saveSet) {
    assert.equal(categoryHits.get(tabItem.id), 1, `expected one category for ${tabItem.id}`);
  }
});
