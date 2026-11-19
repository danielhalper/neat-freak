// Pure helpers for the proactive clutter-reminder flow:
//   diff the live tab set against a prepared plan and prune it. When a nudge
//   fires is decided in nudge-cycle.js.
//
// No Chrome APIs in here on purpose — these are the decision/diff functions, so
// they're unit-testable in the Node harness. The service worker wires them to
// chrome.tabs / chrome.storage. See docs/specs/2026-06-01-proactive-clutter-nudge-design.md.

// Keep document-significant path case, query strings and fragments. A query
// or hash can identify a different document in an SPA; extra invalidations are
// preferable to closing a tab whose content changed.
export function normalizeUrl(url) {
  if (typeof url !== "string" || !url) return "";
  try { return new URL(url).href; }
  catch { return url; }
}

// Order-independent fingerprint of the candidate set: which tabs, by id +
// normalized URL. Same tabs at the same URLs → same hash, regardless of order.
// Used to tell, on the Tidy click, whether the cached plan still applies.
export function hashTabSet(tabs) {
  if (!Array.isArray(tabs)) return "";
  return tabs.map((t) => `${t.id}:${normalizeUrl(t.url)}`).sort().join("|");
}

// How did the live set drift from the snapshot the plan was built on?
// Removals only shrink the plan, so they never force a recompute — only
// additions and navigations introduce real uncertainty, and only those count
// toward churn.
export function classifyDelta(snapshotTabs, currentTabs) {
  const snap = new Map((snapshotTabs || []).map((t) => [t.id, normalizeUrl(t.url)]));
  const cur = new Map((currentTabs || []).map((t) => [t.id, normalizeUrl(t.url)]));
  const removed = [];
  const added = [];
  const navigated = [];
  for (const id of snap.keys()) if (!cur.has(id)) removed.push(id);
  for (const [id, url] of cur) {
    if (!snap.has(id)) added.push(id);
    else if (snap.get(id) !== url) navigated.push(id);
  }
  const size = snap.size || 1;
  const churn = (added.length + navigated.length) / size;
  return { removed, added, navigated, churn };
}

// Reconcile a cached plan against a delta. Pruning removed tabs is free (drop
// them from groups + tabActions, drop any group that empties). A recompute is
// only needed when additions/navigations exceed the churn cap; below it, added
// tabs simply default to staying open (absent from the plan = not saved).
export function reconcilePlan(plan, delta, { churnCap = 0.2 } = {}) {
  if (!plan) return { plan: null, needsRecompute: true };
  const removedSet = new Set([...(delta?.removed || []), ...(delta?.navigated || [])]);
  const tabActions = (plan.tabActions || []).filter((a) => !removedSet.has(a.tabId));
  const groups = (plan.groups || [])
    .map((g) => ({ ...g, tabIds: (g.tabIds || []).filter((id) => !removedSet.has(id)) }))
    .filter((g) => (g.tabIds || []).length > 0);
  return {
    plan: { ...plan, tabActions, groups },
    needsRecompute: (delta?.churn || 0) > churnCap
  };
}
