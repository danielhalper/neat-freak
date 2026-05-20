import { buildAssociationGraph, graphCategorize } from "./categorizer.js";
import { truncateText, getDomain } from "./utils.js";

const STALE_GROUP_CUTOFF_MIN = 180;   // 3h
const ACTIVE_GROUP_CUTOFF_MIN = 480;  // 8h
const ACTIVE_CLUSTER_WINDOW_MIN = 60; // a cluster is "active" if any tab was accessed in the last hour

const OPENAI_CHAT_COMPLETIONS_URL = "https://api.openai.com/v1/chat/completions";
const LLM_MODEL = "gpt-5.4-mini";

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

  // Tabs without a known lastAccessed (e.g., opened in the background via cmd-click,
  // restored from session) are treated as just-opened. Otherwise the heuristic
  // mistakes a fresh background tab for an ancient abandoned one and closes it.
  const effectiveAccess = (t) => (t && t.lastAccessed) ? t.lastAccessed : now;

  const clusterStatus = new Map();
  for (const cluster of clusters) {
    let maxLastAccessed = 0;
    for (const tabId of cluster.tabIds) {
      const t = tabById.get(tabId);
      const ts = effectiveAccess(t);
      if (ts > maxLastAccessed) maxLastAccessed = ts;
    }
    const minutesSinceMostRecent = maxLastAccessed === 0
      ? Infinity
      : (now - maxLastAccessed) / 60_000;
    clusterStatus.set(cluster.id, minutesSinceMostRecent <= ACTIVE_CLUSTER_WINDOW_MIN ? "active" : "stale");
  }

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
    const minutesAgo = (now - effectiveAccess(t)) / 60_000;
    if (minutesAgo > cutoff) saveIds.push(t.id);
    else keepIds.push(t.id);
  }

  return { saveIds, keepIds };
}

/**
 * Top-level entry point. Decides save vs keep, returns saveSet, keepSet, and
 * a categories array (folder structure for saveSet).
 *
 * @param {Array<object>} tabs — candidate tabs (already filtered by pinned/current per scope)
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

function runHeuristicPath(tabs, graph, now) {
  const clusters = graph.clusters.map((c) => ({ id: c.id, tabIds: c.tabIds }));
  const { saveIds, keepIds } = applySmartHeuristic(tabs, clusters, now);
  const saveIdSet = new Set(saveIds);
  const saveSet = tabs.filter((t) => saveIdSet.has(t.id));
  const keepSet = tabs.filter((t) => !saveIdSet.has(t.id));
  const categories = computeSmartCategories(tabs, graph, saveIdSet);
  return { saveSet, keepSet, categories, mode: "heuristic" };
}

function computeSmartCategories(tabs, graph, saveIdSet) {
  const filteredClusters = graph.clusters
    .map((c) => ({ ...c, tabIds: c.tabIds.filter((id) => saveIdSet.has(id)) }))
    .filter((c) => c.tabIds.length > 0);
  if (!filteredClusters.length) return [];
  const filteredGraph = { ...graph, clusters: filteredClusters };
  const savableTabs = tabs.filter((t) => saveIdSet.has(t.id));
  const result = graphCategorize(savableTabs, filteredGraph);
  return result.categories || [];
}

async function runLlmPath(tabs, graph, settings, now) {
  const snippetBudget = tabs.length >= 60 ? 420 : 720;
  const provisionalClusters = graph.clusters.map((c) => ({
    id: c.id,
    provisionalName: c.provisionalName,
    tabIds: c.tabIds,
    topTerms: (c.topTerms || []).slice(0, 6)
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
    reasoning_effort: "low",
    prompt_cache_key: "neat-freak-smart-scope",
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
          "DEFAULT TO 'keep'. Only choose 'save' when a tab is clearly stale AND clearly not in active use. When in doubt, keep it.",
          "",
          "Decide using:",
          "- Recency: lastAccessedMinutesAgo is how long ago the user last looked at the tab. Anything under ~3 hours should almost always be kept. lastAccessedMinutesAgo: null means the tab was opened in the background or restored from a session and has never been activated — treat it as just-opened and KEEP it. Do not interpret null as 'ancient'.",
          "- Group context: if a whole cluster has been cold for hours and none of its tabs were touched recently, those tabs can be saved together. If a cluster is active (any tab touched in the last hour), be conservative — keep the recent tabs, and only save the genuinely old ones (8h+).",
          "- Content: protect tabs that look like work-in-progress — open forms, partially-written drafts, unfinished checkouts, docs the user is likely writing in. Keep these open even if they look stale.",
          "- Distribution: if everything is recent, save almost nothing. The goal is to clear clutter, not to aggressively close.",
          "",
          "Also return `groups`: workstream-aware folder names for the SAVED tabs only. Each saved tab must appear in exactly one group's tabIds. If you save nothing, return an empty groups array.",
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
