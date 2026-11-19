import { test } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeUrl,
  hashTabSet,
  classifyDelta,
  reconcilePlan
} from "../src/clutter-reminder.js";

test("normalizeUrl preserves document identity in paths, queries and fragments", () => {
  assert.equal(normalizeUrl("https://Example.com/Path/?q=1#frag"), "https://example.com/Path/?q=1#frag");
  assert.equal(normalizeUrl("https://example.com/path/"), "https://example.com/path/");
  assert.equal(normalizeUrl("https://example.com"), "https://example.com/");
  assert.equal(normalizeUrl(""), "");
  assert.equal(normalizeUrl(undefined), "");
});

test("hashTabSet is order-independent but URL-sensitive", () => {
  const a = [{ id: 1, url: "https://a.com" }, { id: 2, url: "https://b.com" }];
  const b = [{ id: 2, url: "https://b.com" }, { id: 1, url: "https://a.com" }];
  assert.equal(hashTabSet(a), hashTabSet(b), "reordering must not change the hash");

  const navigated = [{ id: 1, url: "https://a.com/x" }, { id: 2, url: "https://b.com" }];
  assert.notEqual(hashTabSet(a), hashTabSet(navigated), "a URL change must change the hash");

  // Queries and fragments may identify a different document.
  const anchored = [{ id: 1, url: "https://a.com#section" }, { id: 2, url: "https://b.com?utm=x" }];
  assert.notEqual(hashTabSet(a), hashTabSet(anchored));
});

test("classifyDelta splits removed / added / navigated; removals excluded from churn", () => {
  const snapshot = [
    { id: 1, url: "https://a.com" },
    { id: 2, url: "https://b.com" },
    { id: 3, url: "https://c.com" },
    { id: 4, url: "https://d.com" }
  ];
  const current = [
    { id: 1, url: "https://a.com" },        // unchanged
    { id: 3, url: "https://c.com/moved" },   // navigated
    { id: 4, url: "https://d.com" },         // unchanged
    { id: 5, url: "https://e.com" }          // added
  ];                                          // id 2 removed

  const d = classifyDelta(snapshot, current);
  assert.deepEqual(d.removed, [2]);
  assert.deepEqual(d.added, [5]);
  assert.deepEqual(d.navigated, [3]);
  // churn = (added 1 + navigated 1) / snapshotSize 4 = 0.5; removal of id 2 does NOT count.
  assert.equal(d.churn, 0.5);
});

test("classifyDelta: pure removals are zero churn", () => {
  const snapshot = [{ id: 1, url: "https://a.com" }, { id: 2, url: "https://b.com" }];
  const current = [{ id: 1, url: "https://a.com" }];
  const d = classifyDelta(snapshot, current);
  assert.deepEqual(d.removed, [2]);
  assert.equal(d.churn, 0, "closing tabs never drives churn");
});

test("reconcilePlan: prunes removed tabs for free, drops emptied groups", () => {
  const plan = {
    tabActions: [
      { tabId: 1, action: "save" },
      { tabId: 2, action: "save" },
      { tabId: 3, action: "keep" }
    ],
    groups: [
      { name: "Research", tabIds: [1, 2] },
      { name: "Solo", tabIds: [3] }
    ]
  };
  // id 3 closed → churn 0 → no recompute; group "Solo" empties and is dropped.
  const { plan: out, needsRecompute } = reconcilePlan(plan, { removed: [3], added: [], navigated: [], churn: 0 });
  assert.equal(needsRecompute, false);
  assert.deepEqual(out.tabActions.map((a) => a.tabId), [1, 2]);
  assert.deepEqual(out.groups.map((g) => g.name), ["Research"]);
});

test("reconcilePlan: high churn forces a recompute", () => {
  const plan = { tabActions: [{ tabId: 1, action: "save" }], groups: [] };
  const { needsRecompute } = reconcilePlan(plan, { removed: [], added: [9, 10], navigated: [], churn: 0.5 });
  assert.equal(needsRecompute, true);
});

test("reconcilePlan: null plan always needs recompute", () => {
  const { plan, needsRecompute } = reconcilePlan(null, { removed: [], added: [], navigated: [], churn: 0 });
  assert.equal(plan, null);
  assert.equal(needsRecompute, true);
});
