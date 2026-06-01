// Pure helpers for the proactive clutter-reminder flow:
//   arm on tier-cross → wait for a valid focused tab → compute-on-arrival →
//   present → (on Tidy) reuse the cached plan if the tab set still matches.
//
// No Chrome APIs in here on purpose — these are the decision/diff functions, so
// they're unit-testable in the Node harness. The service worker wires them to
// chrome.tabs / chrome.storage. See docs/specs/2026-06-01-proactive-clutter-nudge-design.md.

// Strip volatile URL bits (query, hash, trailing slash, case) so a scroll
// anchor or a tracking param doesn't read as a real navigation.
export function normalizeUrl(url) {
  if (typeof url !== "string" || !url) return "";
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}${u.pathname}`.replace(/\/+$/, "").toLowerCase();
  } catch {
    return String(url).split(/[?#]/)[0].replace(/\/+$/, "").toLowerCase();
  }
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

// Should we ARM a new reminder? Only when a higher tier than we've already
// alerted for has been reached AND the cooldown since the last alert has
// elapsed (or there was no prior alert). currentTier < 0 means "below
// threshold" → never arm.
export function shouldArm({ currentTier, lastAlertedTier, lastAlertAt, now, cooldownMs }) {
  if (!Number.isFinite(currentTier) || currentTier < 0) return false;
  const prevTier = Number.isFinite(lastAlertedTier) ? lastAlertedTier : -1;
  const escalated = currentTier > prevTier;
  const cooledDown = !lastAlertAt || (now - lastAlertAt) >= cooldownMs;
  return escalated && cooledDown;
}

// Reconcile a cached plan against a delta. Pruning removed tabs is free (drop
// them from groups + tabActions, drop any group that empties). A recompute is
// only needed when additions/navigations exceed the churn cap; below it, added
// tabs simply default to staying open (absent from the plan = not saved).
export function reconcilePlan(plan, delta, { churnCap = 0.2 } = {}) {
  if (!plan) return { plan: null, needsRecompute: true };
  const removedSet = new Set(delta?.removed || []);
  const tabActions = (plan.tabActions || []).filter((a) => !removedSet.has(a.tabId));
  const groups = (plan.groups || [])
    .map((g) => ({ ...g, tabIds: (g.tabIds || []).filter((id) => !removedSet.has(id)) }))
    .filter((g) => (g.tabIds || []).length > 0);
  return {
    plan: { ...plan, tabActions, groups },
    needsRecompute: (delta?.churn || 0) > churnCap
  };
}
