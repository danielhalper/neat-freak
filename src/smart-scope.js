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
  const clusterStatus = new Map();
  for (const cluster of clusters) {
    let maxLastAccessed = 0;
    for (const tabId of cluster.tabIds) {
      const t = tabById.get(tabId);
      if (!t || !t.lastAccessed) continue;
      if (t.lastAccessed > maxLastAccessed) maxLastAccessed = t.lastAccessed;
    }
    const minutesSinceMostRecent = maxLastAccessed === 0
      ? Infinity
      : (now - maxLastAccessed) / 60_000;
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
