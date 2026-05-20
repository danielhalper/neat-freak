# Smart Scope Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a third "Smart" capture scope to Neat Freak. Smart uses `tab.lastAccessed` plus association-graph clusters to decide which tabs to save+close vs keep open — instead of saving every eligible tab in the chosen scope.

**Architecture:** A new pure module `src/smart-scope.js` owns the decision logic. It reuses the existing `buildAssociationGraph` from `categorizer.js` for clustering, then either calls a Smart-aware OpenAI prompt (when a key is configured) or applies a deterministic 3h/8h heuristic. The save flow in `background.js` branches on `scope === "smart"`, splits tabs into `saveSet` / `keepSet`, and closes only the save set. UI changes are additive — a third pill in the segmented control, copy adjustments in the popup preview and done state.

**Tech Stack:** Vanilla JS Chrome Manifest V3 extension. Node's built-in `node --test` runner for pure-function tests (no jest, no jsdom). Pure-function modules tested in isolation; chrome.* surfaces tested manually after each task.

**Spec:** [2026-05-20-smart-scope-design.md](2026-05-20-smart-scope-design.md)

---

## File Structure

**New files:**
- `src/smart-scope.js` — pure-function orchestrator. Exports `runSmartScope(tabs, settings)`, `applySmartHeuristic(tabs, clusters, now)`, internal `runSmartScopeLLM()`. Stateless. Imports `buildAssociationGraph` and `graphCategorize` from categorizer.js.
- `tests/smart-scope.test.js` — `node --test` covering the heuristic decision logic.
- `tests/utils.test.js` — light helpers if needed for the test harness.

**Modified files:**
- `src/categorizer.js` — export `buildAssociationGraph` and `graphCategorize` (currently both internal). No other changes.
- `src/storage.js` — change `defaultScope` default to `"smart"`. No version bump.
- `src/background.js` — `getCandidateTabs` treats `scope: "smart"` like `allWindows` for the underlying query. `saveTabs` branches into `runSmartScope` when scope is smart, only closes the save set, and includes `keepCount` / `mode` in the `done` event payload.
- `popup.html` — add a `Smart` segmented button as the first option. Update copy in the description.
- `src/popup.js` — handle the `smart` scope value: adjust preview subtitle copy, pipe scope into SAVE_TABS, render `keepCount` and `mode` in done state.
- `options.html` — `<select id="default-scope">` gets a `<option value="smart">Smart</option>` slotted first.

**Test runner setup:**
- Add a top-level `package.json` (currently absent) with one script: `"test": "node --test tests/"`. No dependencies — uses Node's built-in test runner.

---

## Task 1: Add test infrastructure

**Files:**
- Create: `package.json`
- Create: `tests/.gitkeep`

- [ ] **Step 1: Create the package.json**

Write to `package.json`:

```json
{
  "name": "neat-freak",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "node --test tests/"
  }
}
```

- [ ] **Step 2: Create the tests directory placeholder**

```bash
mkdir -p tests && touch tests/.gitkeep
```

- [ ] **Step 3: Verify the test runner picks up an empty directory**

Run: `npm test`
Expected: `# pass 0\n# fail 0\n# tests 0\n` exit 0. Confirms node --test is wired up.

- [ ] **Step 4: Commit**

```bash
git add package.json tests/.gitkeep
git commit -m "chore: add test infrastructure (node --test)"
```

---

## Task 2: Export buildAssociationGraph and graphCategorize from categorizer.js

**Files:**
- Modify: `src/categorizer.js` (two function declarations near the bottom)

Currently `buildAssociationGraph` and `graphCategorize` are internal. Smart-scope needs them.

- [ ] **Step 1: Find the existing function declarations**

Run: `grep -n "^function buildAssociationGraph\|^function graphCategorize" "src/categorizer.js"`
Expected output:
```
297:function graphCategorize(tabs, associationGraph) {
318:function buildAssociationGraph(tabs) {
```

- [ ] **Step 2: Add `export` to both declarations**

Edit `src/categorizer.js`:

Replace:
```js
function graphCategorize(tabs, associationGraph) {
```
With:
```js
export function graphCategorize(tabs, associationGraph) {
```

Replace:
```js
function buildAssociationGraph(tabs) {
```
With:
```js
export function buildAssociationGraph(tabs) {
```

- [ ] **Step 3: Sanity check existing module still parses**

Run: `node --check src/categorizer.js`
Expected: no output (success). Any error means a typo.

- [ ] **Step 4: Verify internal callers still work**

Run: `grep -c "buildAssociationGraph\|graphCategorize" src/categorizer.js`
Expected: number > 5 (existing internal calls are unchanged; `export` just adds a public binding).

- [ ] **Step 5: Commit**

```bash
git add src/categorizer.js
git commit -m "refactor: export buildAssociationGraph and graphCategorize"
```

---

## Task 3: Pure-function heuristic — failing tests

**Files:**
- Create: `tests/smart-scope.test.js`

We write the tests first, before any implementation. They will fail with "Cannot find module" — that's expected.

- [ ] **Step 1: Write the failing test file**

Write to `tests/smart-scope.test.js`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import { applySmartHeuristic } from "../src/smart-scope.js";

const NOW = 1_700_000_000_000;
const minutesAgo = (mins) => NOW - mins * 60_000;
const tab = (id, mins) => ({ id, lastAccessed: minutesAgo(mins) });

test("stale cluster (no tab in last hour) closes anything > 3h old", () => {
  // All tabs older than 1h → cluster is stale → cutoff = 3h.
  const tabs = [tab("a", 120), tab("b", 200), tab("c", 500)];
  const clusters = [{ id: "c1", tabIds: ["a", "b", "c"] }];
  const { saveIds, keepIds } = applySmartHeuristic(tabs, clusters, NOW);
  assert.deepEqual(saveIds.sort(), ["b", "c"]);
  assert.deepEqual(keepIds, ["a"]);
});

test("active cluster (≥1 tab in last hour) closes anything > 8h old", () => {
  // 30min tab makes cluster active → cutoff = 8h (480min).
  const tabs = [tab("a", 30), tab("b", 200), tab("c", 500), tab("d", 700)];
  const clusters = [{ id: "c1", tabIds: ["a", "b", "c", "d"] }];
  const { saveIds, keepIds } = applySmartHeuristic(tabs, clusters, NOW);
  assert.deepEqual(saveIds, ["d"]);
  assert.deepEqual(keepIds.sort(), ["a", "b", "c"]);
});

test("multiple clusters evaluated independently", () => {
  // c1 active (a=10min), c2 stale (no tab in last 60min).
  const tabs = [
    tab("a", 10), tab("b", 200),
    tab("c", 120), tab("d", 500),
  ];
  const clusters = [
    { id: "c1", tabIds: ["a", "b"] },
    { id: "c2", tabIds: ["c", "d"] },
  ];
  const { saveIds, keepIds } = applySmartHeuristic(tabs, clusters, NOW);
  assert.deepEqual(saveIds.sort(), ["c", "d"]);
  assert.deepEqual(keepIds.sort(), ["a", "b"]);
});

test("tab with no lastAccessed treated as ancient", () => {
  const tabs = [tab("a", 30), { id: "b" }];
  const clusters = [{ id: "c1", tabIds: ["a", "b"] }];
  const { saveIds, keepIds } = applySmartHeuristic(tabs, clusters, NOW);
  assert.deepEqual(saveIds, ["b"]);
  assert.deepEqual(keepIds, ["a"]);
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
```

- [ ] **Step 2: Run the tests to confirm they fail**

Run: `npm test`
Expected: `Error [ERR_MODULE_NOT_FOUND]: Cannot find module '.../src/smart-scope.js'` — confirms module doesn't exist yet.

- [ ] **Step 3: Commit (red state)**

```bash
git add package.json tests/smart-scope.test.js
git commit -m "test: failing tests for applySmartHeuristic"
```

---

## Task 4: Implement applySmartHeuristic to make tests pass

**Files:**
- Create: `src/smart-scope.js`

- [ ] **Step 1: Write the heuristic implementation**

Write to `src/smart-scope.js`:

```js
const STALE_GROUP_CUTOFF_MIN = 180;   // 3h
const ACTIVE_GROUP_CUTOFF_MIN = 480;  // 8h
const ACTIVE_CLUSTER_WINDOW_MIN = 60; // a cluster is "active" if any tab was accessed in the last hour

/**
 * Decide which tabs to save and which to keep, using the 3h/8h heuristic.
 * Pure function. Pass `now` for deterministic tests.
 *
 * @param {Array<{id: string, lastAccessed?: number}>} tabs
 * @param {Array<{id: string, tabIds: string[]}>} clusters
 * @param {number} now epoch ms
 * @returns {{ saveIds: string[], keepIds: string[] }}
 */
export function applySmartHeuristic(tabs, clusters, now) {
  const tabById = new Map(tabs.map((t) => [t.id, t]));

  // Determine active/stale per cluster.
  const clusterStatus = new Map(); // clusterId -> "active" | "stale"
  for (const cluster of clusters) {
    let maxLastAccessed = 0;
    for (const tabId of cluster.tabIds) {
      const t = tabById.get(tabId);
      if (!t || !t.lastAccessed) continue;
      if (t.lastAccessed > maxLastAccessed) maxLastAccessed = t.lastAccessed;
    }
    const minutesSinceMostRecent = (now - maxLastAccessed) / 60_000;
    clusterStatus.set(cluster.id, minutesSinceMostRecent <= ACTIVE_CLUSTER_WINDOW_MIN ? "active" : "stale");
  }

  // Map each tab to the cluster it lives in.
  const clusterByTabId = new Map();
  for (const cluster of clusters) {
    for (const tabId of cluster.tabIds) {
      clusterByTabId.set(tabId, cluster.id);
    }
  }

  const saveIds = [];
  const keepIds = [];
  for (const t of tabs) {
    const clusterId = clusterByTabId.get(t.id);
    if (!clusterId) {
      // Defensive: tab not in any cluster — keep it.
      keepIds.push(t.id);
      continue;
    }
    const status = clusterStatus.get(clusterId);
    const cutoff = status === "stale" ? STALE_GROUP_CUTOFF_MIN : ACTIVE_GROUP_CUTOFF_MIN;
    const minutesAgo = t.lastAccessed ? (now - t.lastAccessed) / 60_000 : Infinity;
    if (minutesAgo > cutoff) saveIds.push(t.id);
    else keepIds.push(t.id);
  }

  return { saveIds, keepIds };
}
```

- [ ] **Step 2: Run the tests to verify they pass**

Run: `npm test`
Expected: `# pass 6\n# fail 0\n` exit 0.

- [ ] **Step 3: Commit (green state)**

```bash
git add src/smart-scope.js
git commit -m "feat: applySmartHeuristic — 3h/8h group-aware cutoff"
```

---

## Task 5: Add runSmartScope orchestrator (heuristic path only)

**Files:**
- Modify: `src/smart-scope.js` (add the orchestrator)
- Modify: `tests/smart-scope.test.js` (add integration tests for runSmartScope)

`runSmartScope` wraps `applySmartHeuristic`, builds the graph, and produces the same output shape that `background.js` expects from `categorizeTabs` (i.e. a `categories` array of folder-ready objects).

- [ ] **Step 1: Add failing integration tests**

Append to `tests/smart-scope.test.js`:

```js
import { runSmartScope } from "../src/smart-scope.js";

test("runSmartScope with heuristic — splits tabs and returns categories", async () => {
  const now = NOW;
  const tabs = [
    { id: "a", title: "Mastery doc", url: "https://docs.google.com/document/a", domain: "docs.google.com", lastAccessed: minutesAgo(10) },
    { id: "b", title: "Mastery sheet", url: "https://docs.google.com/spreadsheets/b", domain: "docs.google.com", lastAccessed: minutesAgo(300) },
    { id: "c", title: "Random old article", url: "https://example.com/post-c", domain: "example.com", lastAccessed: minutesAgo(900) },
  ];
  // Force no LLM by passing empty settings.
  const result = await runSmartScope(tabs, { llmEnabled: false, apiKey: "" }, { now });
  assert.equal(result.mode, "heuristic");
  // Among saveSet, we expect at least the 900-min-old example.com tab.
  const savedIds = result.saveSet.map((t) => t.id);
  assert.ok(savedIds.includes("c"), `expected 'c' to be saved, got ${savedIds.join(",")}`);
  // The recent docs.google.com tab should be kept.
  const keptIds = result.keepSet.map((t) => t.id);
  assert.ok(keptIds.includes("a"), `expected 'a' to be kept, got ${keptIds.join(",")}`);
  // Categories cover only saved tabs.
  const categorizedIds = result.categories.flatMap((c) => c.tabIds);
  for (const id of savedIds) {
    assert.ok(categorizedIds.includes(id), `expected category to include saved tab ${id}`);
  }
  for (const id of keptIds) {
    assert.ok(!categorizedIds.includes(id), `expected category to NOT include kept tab ${id}`);
  }
});
```

- [ ] **Step 2: Run tests to confirm they fail**

Run: `npm test`
Expected: `Cannot find export 'runSmartScope'` or similar.

- [ ] **Step 3: Implement runSmartScope**

Append to `src/smart-scope.js`:

```js
import { buildAssociationGraph, graphCategorize } from "./categorizer.js";

/**
 * Top-level entry point. Decides save vs keep, returns saveSet, keepSet, and
 * a categories array (folder structure for saveSet).
 *
 * @param {Array<object>} tabs — the candidate tabs (already filtered by pinned/current per scope)
 * @param {object} settings — extension settings (apiKey, llmEnabled)
 * @param {object} [opts]
 * @param {number} [opts.now] — epoch ms for tests
 * @returns {Promise<{ saveSet: object[], keepSet: object[], categories: object[], mode: "llm"|"heuristic", error?: string }>}
 */
export async function runSmartScope(tabs, settings, opts = {}) {
  const now = opts.now ?? Date.now();
  if (!tabs.length) {
    return { saveSet: [], keepSet: [], categories: [], mode: "heuristic" };
  }

  const graph = buildAssociationGraph(tabs);

  // (LLM path comes in a later task — for now, always use the heuristic.)
  return runHeuristicPath(tabs, graph, now);
}

function runHeuristicPath(tabs, graph, now) {
  const clusters = graph.clusters.map((c) => ({ id: c.id, tabIds: c.tabIds }));
  const { saveIds, keepIds } = applySmartHeuristic(tabs, clusters, now);
  const saveIdSet = new Set(saveIds);
  const saveSet = tabs.filter((t) => saveIdSet.has(t.id));
  const keepSet = tabs.filter((t) => !saveIdSet.has(t.id));
  const categories = computeSmartCategories(graph, saveIdSet);
  return { saveSet, keepSet, categories, mode: "heuristic" };
}

function computeSmartCategories(tabs, graph, saveIdSet) {
  // Filter graph clusters to only saveSet tab IDs, drop emptied clusters,
  // then run them through the existing graphCategorize helper to get the
  // shape the manager UI expects.
  const filteredClusters = graph.clusters
    .map((c) => ({ ...c, tabIds: c.tabIds.filter((id) => saveIdSet.has(id)) }))
    .filter((c) => c.tabIds.length > 0);
  if (!filteredClusters.length) return [];
  const filteredGraph = { ...graph, clusters: filteredClusters };
  // graphCategorize returns { categories, meta }. Pass only the savable tabs
  // so its withRelatedGroups pass has the right input.
  const savableTabs = tabs.filter((t) => saveIdSet.has(t.id));
  const result = graphCategorize(savableTabs, filteredGraph);
  return result.categories || [];
}
```

Then update `runHeuristicPath` to pass `tabs` through:

```js
function runHeuristicPath(tabs, graph, now) {
  const clusters = graph.clusters.map((c) => ({ id: c.id, tabIds: c.tabIds }));
  const { saveIds, keepIds } = applySmartHeuristic(tabs, clusters, now);
  const saveIdSet = new Set(saveIds);
  const saveSet = tabs.filter((t) => saveIdSet.has(t.id));
  const keepSet = tabs.filter((t) => !saveIdSet.has(t.id));
  const categories = computeSmartCategories(tabs, graph, saveIdSet);
  return { saveSet, keepSet, categories, mode: "heuristic" };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: `# pass 7\n# fail 0\n`.

- [ ] **Step 5: Commit**

```bash
git add src/smart-scope.js tests/smart-scope.test.js
git commit -m "feat: runSmartScope orchestrator with heuristic path"
```

---

## Task 6: Add the LLM-driven Smart path

**Files:**
- Modify: `src/smart-scope.js`

LLM path can't be unit-tested (real HTTP call). Implemented and manually tested.

- [ ] **Step 1: Add the LLM call function**

Append to `src/smart-scope.js`:

```js
import { truncateText, getDomain } from "./utils.js";

const OPENAI_CHAT_COMPLETIONS_URL = "https://api.openai.com/v1/chat/completions";
const LLM_MODEL = "gpt-5-mini";

async function runLlmPath(tabs, graph, settings, now) {
  const snippetBudget = tabs.length >= 60 ? 420 : 720;
  const provisionalClusters = graph.clusters.map((c) => ({
    id: c.id,
    provisionalName: c.provisionalName,
    tabIds: c.tabIds,
    topTerms: c.topTerms?.slice(0, 6) || []
  }));
  const clusterByTabId = new Map();
  for (const c of graph.clusters) {
    for (const tabId of c.tabIds) clusterByTabId.set(tabId, c.id);
  }
  const tabsPayload = tabs.map((t) => ({
    id: t.id,
    title: truncateText(t.title, 160),
    url: truncateText(t.url, 220),
    domain: t.domain || getDomain(t.url),
    pageSummary: truncateText(t.pageSummary, snippetBudget),
    lastAccessedMinutesAgo: t.lastAccessed ? Math.round((now - t.lastAccessed) / 60_000) : null,
    clusterId: clusterByTabId.get(t.id) || ""
  }));

  const body = {
    model: LLM_MODEL,
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "smart_scope_response",
        strict: true,
        schema: {
          type: "object",
          additionalProperties: false,
          required: ["groups", "tabActions"],
          properties: {
            groups: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: false,
                required: ["name", "description", "confidence", "signals", "tabIds"],
                properties: {
                  name: { type: "string" },
                  description: { type: "string" },
                  confidence: { type: "number" },
                  signals: { type: "array", items: { type: "string" } },
                  tabIds: { type: "array", items: { type: "string" } }
                }
              }
            },
            tabActions: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: false,
                required: ["tabId", "action", "reason"],
                properties: {
                  tabId: { type: "string" },
                  action: { type: "string", enum: ["save", "keep"] },
                  reason: { type: "string" }
                }
              }
            }
          }
        }
      }
    },
    messages: [
      {
        role: "system",
        content: [
          "You are deciding which open Chrome tabs to save+close and which to keep open, plus how to group the ones you're closing into folders by workstream.",
          "",
          "For each tab, set action: 'save' (close+tuck into a folder) or 'keep' (leave the tab alone).",
          "",
          "Decide using:",
          "- Group context: if a whole cluster has been cold for hours, save all of them. If a cluster is actively in use, even older tabs in it can probably go (the user is focused on the recent ones).",
          "- Content: protect tabs that look like work-in-progress — open forms, partially-written drafts, unfinished checkouts. Keep these open even if they look stale.",
          "- Distribution: if everything is recent, nothing is stale. If most things are days old and a few are fresh, the fresh ones matter most.",
          "",
          "Also return `groups`: workstream-aware folder names for the SAVED tabs only. Each saved tab must appear in exactly one group's tabIds.",
          "Keep group names under 52 characters."
        ].join("\n")
      },
      {
        role: "user",
        content: JSON.stringify({ tabs: tabsPayload, provisionalClusters })
      }
    ]
  };

  const timeoutMs = tabs.length >= 60 ? 180_000 : 120_000;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetch(OPENAI_CHAT_COMPLETIONS_URL, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${settings.apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body),
      signal: controller.signal
    });
  } finally {
    clearTimeout(timeout);
  }
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Smart LLM call failed (${response.status}): ${truncateText(text, 180)}`);
  }
  const data = await response.json();
  const content = data?.choices?.[0]?.message?.content || "{}";
  const parsed = JSON.parse(content);

  const actionsArray = Array.isArray(parsed.tabActions) ? parsed.tabActions : [];
  const actionByTabId = new Map(actionsArray.map((a) => [a.tabId, a]));

  const tabIdSet = new Set(tabs.map((t) => t.id));
  const saveIds = [];
  const keepIds = [];
  for (const t of tabs) {
    const action = actionByTabId.get(t.id);
    if (action?.action === "keep") keepIds.push(t.id);
    else saveIds.push(t.id);
  }
  const saveIdSet = new Set(saveIds);
  const saveSet = tabs.filter((t) => saveIdSet.has(t.id));
  const keepSet = tabs.filter((t) => !saveIdSet.has(t.id));

  // Translate LLM groups into the categories shape used elsewhere.
  const categories = (parsed.groups || []).map((g, idx) => ({
    id: `smart-group-${idx + 1}`,
    name: truncateText(g.name || "Folder", 52),
    description: truncateText(g.description || "", 160),
    confidence: typeof g.confidence === "number" ? Math.max(0, Math.min(1, g.confidence)) : 0.6,
    signals: Array.isArray(g.signals) ? g.signals.slice(0, 6).map((s) => truncateText(s, 40)) : [],
    tabIds: (Array.isArray(g.tabIds) ? g.tabIds : []).filter((id) => saveIdSet.has(id))
  })).filter((c) => c.tabIds.length > 0);

  return { saveSet, keepSet, categories, mode: "llm" };
}
```

- [ ] **Step 2: Wire LLM path into runSmartScope**

In `src/smart-scope.js`, replace the body of `runSmartScope`:

```js
export async function runSmartScope(tabs, settings, opts = {}) {
  const now = opts.now ?? Date.now();
  if (!tabs.length) {
    return { saveSet: [], keepSet: [], categories: [], mode: "heuristic" };
  }
  const graph = buildAssociationGraph(tabs);

  if (settings.llmEnabled && settings.apiKey) {
    try {
      return await runLlmPath(tabs, graph, settings, now);
    } catch (error) {
      const fallback = runHeuristicPath(tabs, graph, now);
      return { ...fallback, error: error?.message || String(error) };
    }
  }
  return runHeuristicPath(tabs, graph, now);
}
```

- [ ] **Step 3: Re-run tests (should still pass — LLM path not exercised)**

Run: `npm test`
Expected: `# pass 7\n# fail 0\n`.

- [ ] **Step 4: Commit**

```bash
git add src/smart-scope.js
git commit -m "feat: Smart scope LLM path with auto-fallback to heuristic"
```

---

## Task 7: Storage default → "smart"

**Files:**
- Modify: `src/storage.js`

- [ ] **Step 1: Change the default**

In `src/storage.js`, find:

```js
defaultScope: "allWindows",
```

Replace with:

```js
defaultScope: "smart",
```

- [ ] **Step 2: Verify**

Run: `grep -n "defaultScope:" src/storage.js`
Expected: one line showing `defaultScope: "smart"`.

- [ ] **Step 3: Commit**

```bash
git add src/storage.js
git commit -m "feat: default scope is now 'smart' for new installs"
```

---

## Task 8: Background — accept "smart" scope in getCandidateTabs

**Files:**
- Modify: `src/background.js`

`getCandidateTabs` currently maps `scope === "allWindows"` to `{}` (all windows query) and anything else to `{ currentWindow: true }`. Smart should query all windows.

- [ ] **Step 1: Find the line**

Run: `grep -n "currentWindow: true" src/background.js`
Expected: one line in `getCandidateTabs`.

- [ ] **Step 2: Update scope handling**

In `src/background.js`, find:

```js
const query = options.scope === "allWindows" ? {} : { currentWindow: true };
```

Replace with:

```js
const query = (options.scope === "allWindows" || options.scope === "smart") ? {} : { currentWindow: true };
```

- [ ] **Step 3: Syntax check**

Run: `node --check src/background.js`
Expected: no output.

- [ ] **Step 4: Commit**

```bash
git add src/background.js
git commit -m "feat: getCandidateTabs treats 'smart' as all-windows query"
```

---

## Task 9: Background — branch saveTabs into runSmartScope when scope is smart

**Files:**
- Modify: `src/background.js` (in `saveTabs`)

The non-smart flow runs `categorizeTabs(tabs, settings)` which returns `{ categories, meta }`. The Smart flow runs `runSmartScope(tabs, settings)` which returns `{ saveSet, keepSet, categories, mode, error? }`. We branch on `captureOptions.scope`.

- [ ] **Step 1: Import runSmartScope**

In `src/background.js`, find the existing import:

```js
import { categorizeTabs, testLlm } from "./categorizer.js";
```

Add a new import below it:

```js
import { runSmartScope } from "./smart-scope.js";
```

- [ ] **Step 2: Locate the existing categorize call in saveTabs**

Run: `grep -n "await categorizeTabs(tabs, settings)" src/background.js`
Expected: one line.

Read 30 lines around it to identify the call site:

Run: `grep -n -B2 -A8 "await categorizeTabs(tabs, settings)" src/background.js`

- [ ] **Step 3: Replace the grouping step with a branch**

Find this block:

```js
const willUseLlm = settings.llmEnabled && settings.apiKey;
emitProgress({ step: "grouping", tabCount: tabs.length, llm: Boolean(willUseLlm) });
const { categories, meta } = await categorizeTabs(tabs, settings);
```

Replace with:

```js
const willUseLlm = settings.llmEnabled && settings.apiKey;
emitProgress({ step: "grouping", tabCount: tabs.length, llm: Boolean(willUseLlm) });

let categories;
let meta;
let smartResult = null;
let tabsToClose;
let tabsToKeep = [];

if (captureOptions.scope === "smart") {
  smartResult = await runSmartScope(tabs, settings);
  categories = smartResult.categories;
  meta = {
    method: smartResult.mode === "llm" ? "smart-llm" : "smart-heuristic",
    error: smartResult.error || "",
    keepCount: smartResult.keepSet.length,
    saveCount: smartResult.saveSet.length
  };
  // For Smart, only close the saveSet — keepSet stays as live tabs.
  tabsToClose = smartResult.saveSet;
  tabsToKeep = smartResult.keepSet;
} else {
  const result = await categorizeTabs(tabs, settings);
  categories = result.categories;
  meta = result.meta;
  tabsToClose = tabs;
}
```

- [ ] **Step 4: Locate the close-tabs step and update the IDs source**

Run: `grep -n "candidates.map((tab) => tab.id)" src/background.js`
Expected: one match in the close step. Run with -B1 -A3 to see context.

Find this block:

```js
if (!captureOptions.reviewBeforeClose) {
  await closeTabIds(candidates.map((tab) => tab.id));
}
```

Replace with:

```js
if (!captureOptions.reviewBeforeClose) {
  // For Smart, only close the tabs the LLM/heuristic chose to save.
  // For other scopes, tabsToClose === tabs.
  const closeSource = smartResult ? tabsToClose : candidates;
  await closeTabIds(closeSource.map((tab) => tab.originalTabId || tab.id).filter(Number.isFinite));
}
```

Note: `tab.originalTabId` is set inside `buildSavedTabs` (it's `tab.id` from the original Chrome tab object). For Smart, `tabsToClose` items come from the `tabs` array (post-`buildSavedTabs`), so they carry `originalTabId`. The fallback `|| tab.id` handles any case where `originalTabId` isn't set.

- [ ] **Step 5: Locate the session shape and update saved-tabs list**

Find this block in saveTabs:

```js
const session = {
  id: createId("session"),
  categories,
  ...
  tabs,
  ...
};
```

The `tabs` here is the FULL candidate list. For Smart, the saved session should ONLY include the tabs that were closed (saveSet). For non-smart, it's all of them.

Replace `tabs,` with `tabs: smartResult ? tabsToClose : tabs,`.

- [ ] **Step 6: Update the `done` event payload to include keepCount and mode**

Find this block:

```js
emitProgress({
  step: "done",
  sessionId: session.id,
  tabCount: tabs.length,
  groupCount: folderSummaries.length,
  ...
});
```

Update it to:

```js
emitProgress({
  step: "done",
  sessionId: session.id,
  tabCount: smartResult ? smartResult.saveSet.length : tabs.length,
  keepCount: smartResult ? smartResult.keepSet.length : 0,
  scope: captureOptions.scope,
  smartMode: smartResult ? smartResult.mode : null,
  smartError: smartResult?.error || "",
  groupCount: folderSummaries.length,
  looseCount: (categories || []).filter((c) => (c.tabIds || []).length === 1).length,
  llm: Boolean(meta?.method?.includes("llm")),
  folders: folderSummaries,
  pendingCount: session.pendingTabIds?.length || 0,
  reviewMode: captureOptions.reviewBeforeClose === true
});
```

Note: `tabCount` semantics change for Smart — it's now the count of SAVED tabs (matching the user's mental model). Total eligible tabs is `saveCount + keepCount`.

- [ ] **Step 7: Syntax check**

Run: `node --check src/background.js`
Expected: no output.

- [ ] **Step 8: Commit**

```bash
git add src/background.js
git commit -m "feat: saveTabs branches into Smart scope (close saveSet, keep keepSet)"
```

---

## Task 10: Popup HTML — add Smart segmented button

**Files:**
- Modify: `popup.html`

- [ ] **Step 1: Find the current segmented control**

Run: `grep -n -A4 "scope-switch compact" popup.html`

- [ ] **Step 2: Add the Smart button as the first option**

In `popup.html`, find:

```html
<div class="scope-switch compact" role="group" aria-label="Tab capture scope">
  <button class="segmented active" id="scope-all" type="button" data-scope="allWindows">All windows</button>
  <button class="segmented" id="scope-current" type="button" data-scope="currentWindow">Current</button>
</div>
```

Replace with:

```html
<div class="scope-switch compact" role="group" aria-label="Tab capture scope">
  <button class="segmented active" id="scope-smart" type="button" data-scope="smart">Smart</button>
  <button class="segmented" id="scope-all" type="button" data-scope="allWindows">All windows</button>
  <button class="segmented" id="scope-current" type="button" data-scope="currentWindow">Current</button>
</div>
```

Note: the `active` class moves to the Smart button (it's the new default). When popup.js applies the user's stored `defaultScope`, it'll set `active` on whichever button matches.

- [ ] **Step 3: Update the CSS grid for three columns**

In `src/styles.css`, find:

```css
.scope-switch {
  ...
  grid-template-columns: 1fr 1fr;
  ...
}
```

Replace `1fr 1fr` with `1fr 1fr 1fr`.

- [ ] **Step 4: Commit**

```bash
git add popup.html src/styles.css
git commit -m "feat: add Smart segmented button to popup"
```

---

## Task 11: Popup JS — handle "smart" scope value and preview copy

**Files:**
- Modify: `src/popup.js`

- [ ] **Step 1: Update renderPreview to emit Smart copy**

In `src/popup.js`, find `function renderPreview(preview) {`. Replace the full function with:

```js
function renderPreview(preview) {
  const count = preview?.count || 0;
  const skipped = preview?.skippedCount || 0;
  const isSmart = selectedScope === "smart";

  if (count === 0) {
    saveButtonLabel.textContent = "Nothing to tidy";
    if (skipped) {
      saveModeCopy.textContent = `${skipped} tab${skipped === 1 ? "" : "s"} skipped (pinned, current, or unsupported)`;
    } else {
      saveModeCopy.textContent = "No open tabs are eligible to save";
    }
  } else if (isSmart) {
    saveButtonLabel.textContent = "Tidy my tabs";
    saveModeCopy.textContent = `${count} tab${count === 1 ? "" : "s"} eligible — Smart will pick`;
  } else {
    saveButtonLabel.textContent = "Tidy my tabs";
    let copy = `${count} tab${count === 1 ? "" : "s"} to save`;
    if (skipped) copy += `, ${skipped} skipped`;
    saveModeCopy.textContent = copy;
  }
  saveButton.toggleAttribute("disabled", count === 0);
}
```

- [ ] **Step 2: Update showDoneState to show keep count when present**

In `src/popup.js`, find `function showDoneState({ sessionId, tabCount, groupCount, looseCount, llm, folders, pendingCount, reviewMode }) {`. Replace its signature and the first body section:

```js
function showDoneState({ sessionId, tabCount, groupCount, looseCount, llm, folders, pendingCount, reviewMode, keepCount = 0, smartMode = null, smartError = "" }) {
  lastResultSessionId = sessionId || "";
  progressEl.setAttribute("hidden", "");
  defaultStateEl.setAttribute("hidden", "");
  doneEl.removeAttribute("hidden");

  if (smartMode && tabCount === 0 && keepCount > 0) {
    // Smart decided nothing should close.
    doneTitleEl.textContent = "Nothing's stale yet";
    doneSubtitleEl.textContent = "All your tabs look fresh — no cleanup needed right now.";
  } else {
    doneTitleEl.textContent = `${tabCount} tab${tabCount === 1 ? "" : "s"} tucked away`;
    const parts = [];
    parts.push(`${groupCount} folder${groupCount === 1 ? "" : "s"}`);
    if (looseCount) parts.push(`${looseCount} loose`);
    if (smartMode === "heuristic" && smartError) parts.push("heuristic (LLM unavailable)");
    else if (smartMode === "heuristic") parts.push("heuristic");
    else if (smartMode === "llm" || llm) parts.push("gpt-5-mini");
    if (keepCount) parts.push(`${keepCount} kept open`);
    doneSubtitleEl.textContent = parts.join(" · ");
  }
  // The remainder of this function (folder list rendering, close-live button)
  // is unchanged. Leave the existing code below this point intact.
```

Then leave the rest of the function (folder list + close-live button code) as-is.

- [ ] **Step 3: Update handleProgress to thread the new fields through**

In `src/popup.js`, find `function handleProgress(message) {`. Inside the `if (message.step === "done")` branch, replace the `showDoneState({...})` call with:

```js
showDoneState({
  sessionId: message.sessionId,
  tabCount: message.tabCount || 0,
  groupCount: message.groupCount || 0,
  looseCount: message.looseCount || 0,
  llm: Boolean(message.llm),
  folders: Array.isArray(message.folders) ? message.folders : [],
  pendingCount: message.pendingCount || 0,
  reviewMode: Boolean(message.reviewMode),
  keepCount: message.keepCount || 0,
  smartMode: message.smartMode || null,
  smartError: message.smartError || ""
});
```

- [ ] **Step 4: Update the SAVE_TABS response-path showDoneState call**

In `src/popup.js`, find the section in `saveTabs()` that calls `showDoneState({...})` from `response.session`. Add `keepCount`, `smartMode`, and `smartError` from the session.categorization meta (which background.js wrote):

```js
showDoneState({
  sessionId: session?.id,
  tabCount: session?.tabs?.length || 0,
  groupCount: folderObjs.length,
  looseCount: loose,
  llm: session?.categorization?.method?.includes("llm"),
  folders: folderObjs,
  pendingCount: session?.pendingTabIds?.length || 0,
  reviewMode: session?.closeStatus === "review",
  keepCount: session?.categorization?.keepCount || 0,
  smartMode: session?.categorization?.method?.startsWith("smart-")
    ? (session.categorization.method === "smart-llm" ? "llm" : "heuristic")
    : null,
  smartError: session?.categorization?.error || ""
});
```

- [ ] **Step 5: Syntax check**

Run: `node --check src/popup.js`
Expected: no output.

- [ ] **Step 6: Commit**

```bash
git add src/popup.js
git commit -m "feat: popup handles Smart scope (preview copy, keep count, done state)"
```

---

## Task 12: Options page — Smart in the default-scope select

**Files:**
- Modify: `options.html`

- [ ] **Step 1: Find the existing select**

Run: `grep -n -A4 'id="default-scope"' options.html`

- [ ] **Step 2: Add Smart as the first option**

In `options.html`, find:

```html
<select id="default-scope">
  <option value="currentWindow">Current window</option>
  <option value="allWindows">All windows</option>
</select>
```

Replace with:

```html
<select id="default-scope">
  <option value="smart">Smart</option>
  <option value="allWindows">All windows</option>
  <option value="currentWindow">Current window</option>
</select>
```

- [ ] **Step 3: No JS changes needed**

`src/options.js` already saves `fields.defaultScope.value` directly. Verify by running:

Run: `grep -n "defaultScope" src/options.js`
Expected: lines showing `fields.defaultScope.value` read/write — no special-casing per value.

- [ ] **Step 4: Commit**

```bash
git add options.html
git commit -m "feat: Smart option in Settings default-scope select"
```

---

## Task 13: Manual smoke tests

This task has no code — it's a verification step. Mark each manual check as you confirm it.

- [ ] **Reload the extension**

In Chrome: `chrome://extensions` → toggle off + on, or remove + Load unpacked from `/Users/danielhalper/Engineering projects/neat-freak/`.

- [ ] **Open the popup — Smart is selected by default**

Open the popup. The leftmost pill is "Smart" and should be active. The button subtitle reads: `X tabs eligible — Smart will pick` (or "Nothing to tidy" if 0 eligible).

- [ ] **Smart scope with no LLM key — heuristic path**

1. Open Settings, ensure API key is blank.
2. Open ~10 tabs across 2 windows. Let some sit for an hour (or temporarily lower thresholds in `src/smart-scope.js` to test faster).
3. Open popup, ensure Smart is selected, click Tidy.
4. Observe: only the older tabs close. The done state shows `… · heuristic · N kept open`.

- [ ] **Smart scope with LLM key — LLM path**

1. Open Settings, add OpenAI API key, save.
2. Open ~30 tabs of mixed age.
3. Click Tidy with Smart selected.
4. Observe: progress shows "Asking gpt-5-mini", done state shows `… · gpt-5-mini · N kept open`. Saved tabs match what the LLM should reasonably close.

- [ ] **LLM fallback on bad key**

1. Settings → set API key to something invalid like `sk-invalid`.
2. Click Tidy with Smart.
3. Observe: done state shows `… · heuristic (LLM unavailable) · N kept open`. No error toast; gracefully fell back.

- [ ] **Empty result case**

1. With only 2-3 recent tabs open, click Tidy with Smart.
2. Observe: done state shows `Nothing's stale yet`. No session is created in the manager.

- [ ] **All-windows and Current scopes still work**

1. Switch scope to "All windows", click Tidy.
2. All eligible tabs save+close as before. Done state shows `X tabs tucked away · N folders · gpt-5-mini` (no `kept open` line).
3. Same check for "Current".

- [ ] **Commit (no code, just a marker that smoke testing happened)**

```bash
git commit --allow-empty -m "test: smoke tested Smart scope end-to-end"
```

---

## Task 14: Final polish — re-zip for Web Store

**Files:**
- (regenerates) `docs/store-submission/neat-freak-v1.1.0.zip`

- [ ] **Step 1: Bump the manifest version**

In `manifest.json`, find `"version": "1.0.0"`. Replace with `"version": "1.1.0"`.

- [ ] **Step 2: Re-zip**

```bash
cd "/Users/danielhalper/Engineering projects/neat-freak" && rm -f docs/store-submission/neat-freak-v*.zip && zip -r docs/store-submission/neat-freak-v1.1.0.zip manifest.json popup.html manager.html options.html welcome.html assets/ src/ -x "*.DS_Store"
```

Expected: a fresh `neat-freak-v1.1.0.zip` with all files.

- [ ] **Step 3: Verify the zip contents**

Run: `unzip -l docs/store-submission/neat-freak-v1.1.0.zip | head -10`
Expected: includes `manifest.json`, `popup.html`, `src/smart-scope.js`, etc.

- [ ] **Step 4: Commit**

```bash
git add manifest.json docs/store-submission/
git commit -m "release: v1.1.0 — Smart scope"
```

---

## Self-Review

**Spec coverage check:**

| Spec section | Task |
|---|---|
| Popup scope switch with Smart leftmost | Task 10 |
| Subtitle "X tabs eligible — Smart will pick" | Task 11 |
| Save flow (LLM): graph → LLM with lastAccessed + clusters → groups + tabActions | Task 6 |
| Save flow (heuristic): 3h stale / 8h active, 1h active-window | Tasks 4–5 |
| `runSmartScope` function in a module | Tasks 4–6 (in src/smart-scope.js) |
| Done state shows "32 saved · 55 kept · gpt-5-mini" | Task 11 |
| Nothing-stale empty case | Task 11 |
| All-tabs-saved case → manager auto-opens | No code change — existing conditional-auto-open logic handles it |
| LLM-failure fallback with notice | Task 6 (auto-fallback) + Task 11 (notice rendering) |
| Active-tab kept open via keepCurrentTab | No change — existing setting already does this |
| Pinned-tab skipped via includePinned | No change — existing setting already does this |
| `<5 tabs no special-casing | No change — runSmartScope handles it |
| storage.js — `defaultScope` accepts "smart", default for new installs | Task 7 |
| categorizer.js exports buildAssociationGraph + graphCategorize | Task 2 |
| background.js scope branch + close only saveSet | Task 9 |
| options.html select gets "smart" first | Task 12 |
| LLM response schema with groups + tabActions | Task 6 |

**Placeholder scan:** None.

**Type consistency check:**
- `runSmartScope` returns `{ saveSet, keepSet, categories, mode, error? }` — referenced consistently in Tasks 5, 6, 9.
- `applySmartHeuristic` returns `{ saveIds, keepIds }` — referenced in Tasks 3, 4, 5.
- `meta.method` values: `"smart-llm"`, `"smart-heuristic"`, plus existing `"llm-graph"` / `"association-graph"` — referenced in Tasks 9, 11.
- `tab.originalTabId` — used in Task 9 to map saved-tabs back to live Chrome tab IDs for closing. Verified to be set in `buildSavedTabs` (no change to that function needed).

---

## Execution Handoff

**Plan complete and saved to `docs/specs/2026-05-20-smart-scope-plan.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

Which approach?
