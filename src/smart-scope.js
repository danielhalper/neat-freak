import { buildAssociationGraph, graphCategorize } from "./categorizer.js";
import { truncateText, getDomain } from "./utils.js";

// Aggressive defaults. The user clicks Smart because they want clutter gone;
// saved tabs are one click away from restoring, so the failure mode is "had to
// restore something" not "lost work". Bias toward saving.
//
// With STALE_GROUP_CUTOFF_MIN == ACTIVE_CLUSTER_WINDOW_MIN, the heuristic for a
// cold cluster is "save everything" — anything in a stale cluster is by
// definition older than the active window.
const STALE_GROUP_CUTOFF_MIN = 30;    // 30m — cold clusters: save the whole thing
const ACTIVE_GROUP_CUTOFF_MIN = 90;   // 1.5h — active clusters: save anything older than 90 min
const ACTIVE_CLUSTER_WINDOW_MIN = 30; // a cluster is "active" if any tab was accessed in the last 30 min

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
// URL/domain content-type heuristics. Used by the heuristic floor below to
// decide which tabs to save when the recency-based logic would otherwise
// close nothing. Positive score = looks like skim-once / ambient content
// (more savable). Negative = active work surface (more keepable).
//
// Deliberately broad — false positives are cheap (user restores from folder)
// and false negatives just defer to the floor's recency ordering.
function contentSavabilityScore(tab) {
  if (!tab || !tab.url) return 0;
  const url = String(tab.url).toLowerCase();
  const domain = String(tab.domain || "").toLowerCase();
  let score = 0;

  // Skim-once / reference content — more savable.
  if (/medium\.com|substack\.com|dev\.to|hashnode\.dev/.test(domain)) score += 3;
  if (/(nytimes|washingtonpost|wsj|bloomberg|theverge|techcrunch|arstechnica|wired|hacker)/.test(domain)) score += 3;
  if (/\/(blog|article|articles|post|posts|news|story|stories)\//.test(url)) score += 2;
  if (/(stackoverflow|stackexchange)\.com/.test(domain)) score += 2;
  if (/(google\..*\/search|bing\.com\/search|duckduckgo\.com|kagi\.com\/search)/.test(url)) score += 3;
  if (/github\.com\/[^/]+\/[^/]+\/(issues|pull)\/\d+/.test(url)) score += 2;
  if (/reddit\.com\/r\//.test(url)) score += 2;
  if (/(youtube\.com\/watch|vimeo\.com\/\d+)/.test(url)) score += 1;

  // Active work surfaces — less savable (negative score).
  if (/docs\.google\.com\/(document|spreadsheets|presentation)/.test(url)) score -= 3;
  if (/notion\.so/.test(domain)) score -= 2;
  if (/linear\.app/.test(domain)) score -= 2;
  if (/mail\.google\.com|outlook\.live\.com|outlook\.office/.test(url)) score -= 3;
  if (/calendar\.google\.com/.test(url)) score -= 3;
  if (/figma\.com\/(file|design|board|proto)/.test(url)) score -= 2;
  if (/\/(edit|compose|new)(\?|$|#)/.test(url)) score -= 2;
  if (/(localhost|127\.0\.0\.1):\d+/.test(url)) score -= 2; // dev servers
  return score;
}

/**
 * Identify URL duplicates among the candidate tabs. Returns the set of tab
 * ids that should be force-saved as duplicates — every tab in a group except
 * the most recently accessed one. Matches on the exact URL string (full path,
 * query, fragment), not just the domain. Shared by the heuristic and LLM paths.
 *
 * @param {Array<{id: string, url?: string, lastAccessed?: number}>} tabs
 * @param {number} now epoch ms
 * @returns {Set<string>}
 */
export function computeUrlDedupSaveIds(tabs, now) {
  const effectiveAccess = (t) => (t && t.lastAccessed) ? t.lastAccessed : now;
  const result = new Set();
  const urlGroups = new Map();
  for (const t of tabs) {
    if (!t || !t.url) continue;
    const list = urlGroups.get(t.url) || [];
    list.push(t);
    urlGroups.set(t.url, list);
  }
  for (const group of urlGroups.values()) {
    if (group.length <= 1) continue;
    group.sort((a, b) => effectiveAccess(b) - effectiveAccess(a));
    for (let i = 1; i < group.length; i++) {
      result.add(group[i].id);
    }
  }
  return result;
}

export function applySmartHeuristic(tabs, clusters, now) {
  const tabById = new Map(tabs.map((t) => [t.id, t]));

  // Tabs without a known lastAccessed (e.g., opened in the background via cmd-click,
  // restored from session) are treated as just-opened. Otherwise the heuristic
  // mistakes a fresh background tab for an ancient abandoned one and closes it.
  const effectiveAccess = (t) => (t && t.lastAccessed) ? t.lastAccessed : now;

  // Dedup pre-pass: when multiple tabs share an exact-same URL, only the most
  // recently accessed one stays open; the older duplicates are pure clutter
  // and get force-saved regardless of cluster activity or cutoff. The user
  // can always restore from the saved folder.
  const dedupSaveIds = computeUrlDedupSaveIds(tabs, now);

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
    // Force-save URL duplicates before any cutoff logic.
    if (dedupSaveIds.has(t.id)) {
      saveIds.push(t.id);
      continue;
    }
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

  // Floor: when the user has a real pile of tabs (≥8) and the absolute-cutoff
  // logic above closed nothing, the lastAccessed signal is too noisy to act
  // on (typical case: browser just opened, every tab reports a fresh
  // lastAccessed because the user flipped through them). The user clicking
  // Smart is itself a strong signal — deliver tidying.
  //
  // Switch to relative ranking: combined score of recency (older = higher)
  // plus URL content type (skim-once content = higher, active surfaces =
  // lower). Save the top ~40% by score.
  const HEURISTIC_FLOOR_MIN_TABS = 8;
  const HEURISTIC_FLOOR_SAVE_FRACTION = 0.4;
  if (tabs.length >= HEURISTIC_FLOOR_MIN_TABS && saveIds.length === 0) {
    const ranked = tabs
      .map((t) => ({
        id: t.id,
        // Each content-savability point is worth ~10 minutes of recency, so the
        // content signal dominates in the failure case (all tabs roughly same age).
        score: (now - effectiveAccess(t)) / 60_000 + contentSavabilityScore(t) * 10
      }))
      .sort((a, b) => b.score - a.score); // highest score first

    const saveCount = Math.max(2, Math.floor(ranked.length * HEURISTIC_FLOOR_SAVE_FRACTION));
    const fallbackSaveIds = new Set(ranked.slice(0, saveCount).map((r) => r.id));
    return {
      saveIds: [...fallbackSaveIds],
      keepIds: keepIds.filter((id) => !fallbackSaveIds.has(id))
    };
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
    reasoning_effort: "medium",
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
          "For each tab, set action: 'save' (close+tuck into a folder, restorable in one click) or 'keep' (leave the tab alone).",
          "",
          "The user clicked Smart because they want clutter cleared. DEFAULT TO 'save'. Aim to save the majority of tabs — most people only need 3-5 focus tabs open at a time. Closing too few is a worse failure than closing too many; saved tabs restore in one click.",
          "",
          "KEEP only when there is clear signal of active focus:",
          "- Work-in-progress: an open form being filled in, a partially-written draft, an unfinished checkout, a document the user is composing in (Google Docs, Notion, Linear, etc.).",
          "- A primary work surface touched in the last 60 minutes (not a reference link skimmed once).",
          "- The kind of tab someone would notice immediately if it disappeared mid-task.",
          "",
          "SAVE everything else — yes, even tabs touched recently if they look like skim-once content: articles, blog posts, news, Stack Overflow answers, GitHub issues, search-results pages, old chat threads. The user can restore them from the saved folder.",
          "",
          "IMPORTANT — when everything looks recent: lastAccessedMinutesAgo is noisy. Chrome updates it on a one-second tab focus, not on actual use. If all tabs are < 60 min and you're tempted to return all-keep, DON'T. The user clicking Smart is a strong signal they want clutter cleared. In that case, still save the half that look most like ambient/reference content (articles, search results, blog posts, news, GitHub issues you read once) and keep the half that look most like active work surfaces (docs being composed in, sheets, email, calendar, IDE/dev consoles, forms with input).",
          "",
          "lastAccessedMinutesAgo: null means the tab was opened in the background or restored from a session and has never been activated — treat as just-opened and KEEP it. Do not interpret null as 'ancient'.",
          "",
          "GROUPING — use temporal proximity as a strong signal:",
          "People typically open many tabs in bursts for a single task — a research session, a code review, a multi-tab purchase. Tabs with similar lastAccessedMinutesAgo are likely part of the same workstream even if their content/domain signals don't obviously match. Treat tabs within ~60 minutes of each other as strong candidates for the same group; within ~3 hours as plausible; beyond that, prefer content/domain similarity. Use temporal proximity especially as a tie-breaker when content alone is ambiguous, or to merge what would otherwise look like several thin near-singleton groups into one coherent workstream folder.",
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

  // Same exact-URL dedup the heuristic applies — duplicates are clutter and
  // shouldn't depend on the LLM noticing. Override its decision for any tab
  // that's a non-canonical copy of a URL.
  const dedupSaveIds = computeUrlDedupSaveIds(tabs, now);

  const saveIds = [];
  const keepIds = [];
  for (const t of tabs) {
    if (dedupSaveIds.has(t.id)) {
      saveIds.push(t.id);
      continue;
    }
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
