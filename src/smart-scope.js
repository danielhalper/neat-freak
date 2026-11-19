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

const LLM_MODEL = "gpt-oss-120b"; // fallback only; the managed backend model comes from settings.llmModel

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
  if (/docs\.google\.com\/forms\//.test(url)) score -= 2;
  if (/notion\.so/.test(domain)) score -= 2;
  if (/linear\.app/.test(domain)) score -= 2;
  if (/mail\.google\.com|outlook\.live\.com|outlook\.office/.test(url)) score -= 3;
  if (/calendar\.google\.com/.test(url)) score -= 3;
  if (/figma\.com\/(file|design|board|proto)/.test(url)) score -= 2;
  if (/\/(edit|compose|new)(\?|$|#)/.test(url)) score -= 2;
  if (/\/(cart|checkout|payment|order)(\/|\?|$|#)/.test(url)) score -= 2;
  if (/(localhost|127\.0\.0\.1):\d+/.test(url)) score -= 2; // dev servers
  return score;
}

function effectiveAccess(tab, now) {
  return Number.isFinite(tab?.lastAccessed) ? tab.lastAccessed : now;
}

function minutesSinceAccess(tab, now) {
  return (now - effectiveAccess(tab, now)) / 60_000;
}

function isProtectedWorkSurface(tab) {
  if (!tab) return true;
  if (tab.active || tab.audible) return true;
  if (!Number.isFinite(tab.lastAccessed)) return true;
  return contentSavabilityScore(tab) <= -2;
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
    group.sort((a, b) => effectiveAccess(b, now) - effectiveAccess(a, now));
    for (let i = 1; i < group.length; i++) {
      result.add(group[i].id);
    }
  }
  return result;
}

export function applySmartHeuristic(tabs, clusters, now, opts = {}) {
  const tabById = new Map(tabs.map((t) => [t.id, t]));

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
      const ts = effectiveAccess(t, now);
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
    const minutesAgo = minutesSinceAccess(t, now);
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
  if (!opts.proactive && tabs.length >= HEURISTIC_FLOOR_MIN_TABS && saveIds.length === 0) {
    const ranked = tabs
      .map((t) => ({
        id: t.id,
        // Each content-savability point is worth ~10 minutes of recency, so the
        // content signal dominates in the failure case (all tabs roughly same age).
        score: minutesSinceAccess(t, now) + contentSavabilityScore(t) * 10
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
 * @param {object} settings — extension settings. backendUrl (enclave chat URL) and
 *   enclaveKey (short-lived capped key) are injected at runtime by the background
 *   service worker after the token service mints a key; llmEnabled + llmModel are stored.
 * @param {object} [opts]
 * @param {number} [opts.now] — epoch ms for tests
 * @param {number} [opts.minSaveCount] — hard floor for saved tabs
 * @returns {Promise<{ saveSet: object[], keepSet: object[], categories: object[], mode: "llm"|"heuristic", error?: string, modelPicks?: string[] }>}
 *   modelPicks (llm only): tab ids the model listed, before the recency guard and the floor.
 */
export async function runSmartScope(tabs, settings, opts = {}) {
  const now = opts.now ?? Date.now();
  if (!tabs.length) {
    return { saveSet: [], keepSet: [], categories: [], mode: "heuristic" };
  }
  const graph = attachTabsToGraph(buildAssociationGraph(tabs), tabs);
  const minSaveCount = opts.proactive ? 0 : clampMinSaveCount(opts.minSaveCount, tabs.length);

  let result;
  if (settings.llmEnabled && settings.backendUrl) {
    try {
      result = await runLlmPath(tabs, graph, settings, now, {
        minSaveCount,
        proactive: Boolean(opts.proactive),
        totalOpenTabCount: opts.totalOpenTabCount,
        clutterThreshold: opts.clutterThreshold
      });
    } catch (error) {
      result = { ...runHeuristicPath(tabs, graph, now, opts), error: error?.message || String(error) };
    }
  } else {
    result = runHeuristicPath(tabs, graph, now, opts);
  }

  // Tab-limit floor: when neither path closed enough to get the user under
  // their clutter threshold, top up from the keep set. Caller passes
  // minSaveCount = (total open tabs) - (threshold - 1) so post-save total is
  // strictly under the limit.
  if (minSaveCount > result.saveSet.length) {
    result = enforceMinSaveCount(result, tabs, graph, minSaveCount, now);
  }

  // Hard safety net, applied last: never auto-close the tab the user is actively
  // on (active), a tab playing audio, or a tab with unsubmitted form input. The
  // LLM gets no "active" signal and defaults unmarked tabs to save, and the floor
  // ranks purely by savability — so without this, any of them could be closed.
  // This is the final word and overrides every prior decision, even the floor.
  result = forceKeepProtectedTabs(result, tabs, graph);

  return result;
}

// Pull any active / audible / unsaved-input tab back out of the save set. This
// is the final word — closing a tab with typed-but-unsubmitted form input would
// lose that work for good (restore only reopens the URL), so it overrides the
// LLM, the heuristic, and the tab-limit floor. Returns result unchanged if
// nothing needs protecting.
function forceKeepProtectedTabs(result, tabs, graph) {
  const protectedIds = new Set(
    tabs.filter((t) => t && (t.active || t.audible || t.hasUnsavedInput || t.signalsUnavailable)).map((t) => t.id)
  );
  if (!protectedIds.size) return result;
  const savedIdSet = new Set(
    result.saveSet.map((t) => t.id).filter((id) => !protectedIds.has(id))
  );
  if (savedIdSet.size === result.saveSet.length) return result; // none were at risk

  const saveSet = tabs.filter((t) => savedIdSet.has(t.id));
  const keepSet = tabs.filter((t) => !savedIdSet.has(t.id));
  const categories = (result.mode === "llm" && Array.isArray(result.categories) && result.categories.length)
    ? finalizeLlmCategories(result.categories, saveSet, tabs, graph)
    : computeSmartCategories(tabs, graph, savedIdSet);
  return { ...result, saveSet, keepSet, categories };
}

function clampMinSaveCount(raw, total) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(Math.floor(n), total);
}

// Expand the save set up to minSaveCount by promoting the safest tabs from
// keepSet. Ranking is intentionally tiered: stale/reference workstreams first,
// active work surfaces and unknown lastAccessed tabs last.
function enforceMinSaveCount(result, tabs, graph, minSaveCount, now) {
  const savedIdSet = new Set(result.saveSet.map((t) => t.id));
  const needed = minSaveCount - savedIdSet.size;
  if (needed <= 0) return result;

  const floorContext = buildFloorClusterInfo(graph, now);
  const ranked = result.keepSet
    .map((t) => ({
      tab: t,
      score: floorSavePriority(t, floorContext, now)
    }))
    .sort((a, b) => b.score - a.score);

  const added = ranked.slice(0, needed).map((r) => r.tab);
  for (const t of added) savedIdSet.add(t.id);

  const saveSet = tabs.filter((t) => savedIdSet.has(t.id));
  const keepSet = tabs.filter((t) => !savedIdSet.has(t.id));

  const categories = (result.mode === "llm" && Array.isArray(result.categories) && result.categories.length)
    ? finalizeLlmCategories(result.categories, saveSet, tabs, graph)
    : computeSmartCategories(tabs, graph, savedIdSet);

  return { ...result, saveSet, keepSet, categories };
}

function floorSavePriority(tab, clusterInfo, now) {
  const cluster = clusterInfo.get(tab.id);
  const contentScore = contentSavabilityScore(tab);
  const minutesAgo = minutesSinceAccess(tab, now);
  const protectedSurface = isProtectedWorkSurface(tab);
  const staleCluster = cluster ? cluster.minutesSinceMostRecent > ACTIVE_CLUSTER_WINDOW_MIN : false;

  let tier;
  if (!protectedSurface && staleCluster && contentScore >= 0) tier = 7;
  else if (!protectedSurface && staleCluster) tier = 6;
  else if (!protectedSurface && contentScore >= 2) tier = 5;
  else if (!protectedSurface && minutesAgo > ACTIVE_GROUP_CUTOFF_MIN) tier = 4;
  else if (!protectedSurface && contentScore > 0) tier = 3;
  else if (!protectedSurface) tier = 2;
  else if (!tab?.active && !tab?.audible && Number.isFinite(tab?.lastAccessed) && minutesAgo > ACTIVE_GROUP_CUTOFF_MIN) tier = 1;
  else tier = 0;

  const clusterStaleness = cluster ? Math.max(0, cluster.minutesSinceMostRecent) : 0;
  return tier * 1_000_000 + clusterStaleness * 1_000 + contentScore * 100 + minutesAgo;
}

function buildFloorClusterInfo(graph, now) {
  const result = new Map();
  for (const cluster of graph.clusters || []) {
    const clusterTabs = (cluster.tabIds || [])
      .map((tabId) => graph.tabById?.get?.(tabId))
      .filter(Boolean);
    let mostRecent = 0;
    for (const tab of clusterTabs) {
      const accessed = effectiveAccess(tab, now);
      if (accessed > mostRecent) mostRecent = accessed;
    }
    const minutesSinceMostRecent = mostRecent ? (now - mostRecent) / 60_000 : Infinity;
    for (const tab of clusterTabs) {
      result.set(tab.id, { id: cluster.id, minutesSinceMostRecent });
    }
  }
  return result;
}

function finalizeLlmCategories(categories, savedTabs, allTabs, graph) {
  const savedIds = new Set(savedTabs.map((tab) => tab.id));
  const assigned = new Set();
  const usedIds = new Set();
  const normalized = [];

  for (const category of categories || []) {
    const tabIds = [...new Set(category.tabIds || [])]
      .filter((tabId) => savedIds.has(tabId) && !assigned.has(tabId));
    if (!tabIds.length) continue;
    tabIds.forEach((tabId) => assigned.add(tabId));
    const id = uniqueCategoryId(category.id || category.name || "Folder", usedIds);
    normalized.push({ ...category, id, tabIds });
  }

  const missingTabs = savedTabs.filter((tab) => !assigned.has(tab.id));
  if (!missingTabs.length) return normalized;

  const missingIds = new Set(missingTabs.map((tab) => tab.id));
  const supplemental = computeSmartCategories(allTabs, graph, missingIds);
  if (supplemental.length) {
    for (const category of supplemental) {
      const tabIds = [...new Set(category.tabIds || [])]
        .filter((tabId) => missingIds.has(tabId) && !assigned.has(tabId));
      if (!tabIds.length) continue;
      tabIds.forEach((tabId) => assigned.add(tabId));
      const id = uniqueCategoryId(category.id || category.name || "Folder", usedIds);
      normalized.push({ ...category, id, tabIds });
    }
  }

  const stillMissing = savedTabs.filter((tab) => !assigned.has(tab.id)).map((tab) => tab.id);
  if (stillMissing.length) {
    normalized.push({
      id: uniqueCategoryId("other", usedIds),
      name: "Other",
      description: "Saved tabs that did not fit an existing folder.",
      confidence: 0.2,
      signals: [],
      relatedGroupNames: [],
      tabIds: stillMissing
    });
  }

  return normalized;
}

function uniqueCategoryId(raw, usedIds) {
  const base = String(raw || "folder")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "folder";
  let id = base;
  let index = 2;
  while (usedIds.has(id)) {
    id = `${base}-${index}`;
    index += 1;
  }
  usedIds.add(id);
  return id;
}

function attachTabsToGraph(graph, tabs) {
  if (graph.tabById) return graph;
  return { ...graph, tabById: new Map(tabs.map((tab) => [tab.id, tab])) };
}

function runHeuristicPath(tabs, graph, now, opts = {}) {
  const clusters = graph.clusters.map((c) => ({ id: c.id, tabIds: c.tabIds }));
  const { saveIds, keepIds } = applySmartHeuristic(tabs, clusters, now, opts);
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

// The extension no longer sends this request (see buildCompactRequest below);
// it stays for the eval harness and as a quality reference.
// Build the exact OpenAI chat-completions request body for the Smart LLM
// path — system prompt, JSON schema, and per-tab payload. Pure + exported so
// the eval harness can construct identical requests for other models/payloads
// without drift. The caller sets the auth header and may override body.model.
export function buildSmartScopeRequest(tabs, graph, now, floorContext = {}) {
  const snippetBudget = tabs.length >= 60 ? 420 : 720;
  const minSaveCount = floorContext.proactive ? 0 : clampMinSaveCount(floorContext.minSaveCount, tabs.length);
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
    hasUnsavedInput: Boolean(t.hasUnsavedInput),
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
          ...(floorContext.proactive ? [
            "You are preparing an optional proactive recommendation. The user has NOT asked to close anything yet. Recommend tabs that look ready to put away, using their content and workstream context. There is no target count or fraction to save. Returning no saves is valid. Recency is supporting evidence, not proof of importance or completion.",
          ] : [
          "The user clicked Smart because they want clutter cleared. DEFAULT TO 'save'. Aim to save the majority of tabs — most people only need 3-5 focus tabs open at a time. Closing too few is a worse failure than closing too many; saved tabs restore in one click.",
          ]),
          "",
          ...(minSaveCount > 0 ? [
            "HARD TAB-LIMIT FLOOR:",
            `You must return action: 'save' for at least ${minSaveCount} of the ${tabs.length} candidate tabs. This is the minimum needed to get the user below their tab limit.`,
            "When meeting this floor, save stale/reference/read-once clusters before active work surfaces. If you must choose among recent tabs, keep docs/forms/mail/calendar/dev surfaces and save ambient content first.",
            ""
          ] : []),
          floorContext.proactive ? "KEEP when work appears unfinished or evidence for putting it away is uncertain:" : "KEEP only when there is clear signal of active focus:",
          "- Work-in-progress: an open form being filled in, a partially-written draft, an unfinished checkout, a document the user is composing in (Google Docs, Notion, Linear, etc.).",
          "- A primary work surface touched in the last 60 minutes (not a reference link skimmed once).",
          "- The kind of tab someone would notice immediately if it disappeared mid-task.",
          "- hasUnsavedInput: true means the user has typed into a form or draft on the page that isn't submitted. Closing it would lose that work for good. ALWAYS keep these — even if they look old or stale — and never put them in a group.",
          "",
          floorContext.proactive
            ? "Recommend SAVE when the content and workstream context suggest the tab is ready to put away. Age alone does not establish completion; an old reference may still support current work. Do not fill a quota or treat every tab outside active focus as finished."
            : "SAVE everything else — yes, even tabs touched recently if they look like skim-once content: articles, blog posts, news, Stack Overflow answers, GitHub issues, search-results pages, old chat threads. The user can restore them from the saved folder.",
          "",
          ...(!floorContext.proactive ? [
          "IMPORTANT — when everything looks recent: lastAccessedMinutesAgo is noisy. Chrome updates it on a one-second tab focus, not on actual use. If all tabs are < 60 min and you're tempted to return all-keep, DON'T. The user clicking Smart is a strong signal they want clutter cleared. In that case, still save the half that look most like ambient/reference content (articles, search results, blog posts, news, GitHub issues you read once) and keep the half that look most like active work surfaces (docs being composed in, sheets, email, calendar, IDE/dev consoles, forms with input).",
          ] : []),
          "",
          "lastAccessedMinutesAgo: null means the tab was opened in the background or restored from a session and has never been activated — treat as just-opened and KEEP it. Do not interpret null as 'ancient'.",
          "",
          "GROUPING — content and workstream first; temporal proximity is supporting evidence:",
          "People typically open many tabs in bursts for a single task — a research session, a code review, a multi-tab purchase. Similar lastAccessedMinutesAgo alone does not establish a shared workstream; require content, entity or domain overlap. These are focus times, not creation times. Treat tabs within ~60 minutes of each other as strong candidates for the same group; within ~3 hours as plausible; beyond that, prefer content/domain similarity. Use temporal proximity especially as a tie-breaker when content alone is ambiguous, or to merge what would otherwise look like several thin near-singleton groups into one coherent workstream folder.",
          "",
          "Also return `groups`: workstream-aware folder names for the SAVED tabs only. Each saved tab must appear in exactly one group's tabIds. If you save nothing, return an empty groups array.",
          "Keep group names under 52 characters."
        ].join("\n")
      },
      {
        role: "user",
        content: JSON.stringify({
          tabs: tabsPayload,
          provisionalClusters,
          saveFloor: {
            minSaveCount,
            totalOpenTabCount: Number.isFinite(Number(floorContext.totalOpenTabCount)) ? Number(floorContext.totalOpenTabCount) : null,
            clutterThreshold: Number.isFinite(Number(floorContext.clutterThreshold)) ? Number(floorContext.clutterThreshold) : null
          }
        })
      }
    ]
  };

  return body;
}

// The request the extension sends, for background suggestions and the manual
// Smart tidy alike. Both run in the MV3 service worker, so the answer must come
// back inside its 30-second fetch window, and latency is set by output tokens,
// not input size. On Tinfoil gpt-oss-120b (2026-11-16) the full request above
// took ~40 s at 30-120 tabs (5.5-6.4k output tokens); this one took 2-3.4 s
// (240-450). So: short tab ids, low reasoning, and the model lists only the
// tabs to put away, in folders. Everything it leaves out stays open.
const MIN_IDLE_MIN = 30;

export function buildCompactRequest(tabs, graph, now, floorContext = {}) {
  const proactive = Boolean(floorContext.proactive);
  const minSaveCount = proactive ? 0 : clampMinSaveCount(floorContext.minSaveCount, tabs.length);
  const summaryBudget = tabs.length >= 60 ? 300 : 500;
  const shortIdByTabId = new Map(tabs.map((t, index) => [t.id, String(index + 1)]));
  const clusterIdByTabId = new Map();
  const clusters = graph.clusters.map((c, index) => {
    const id = `c${index + 1}`;
    for (const tabId of c.tabIds) clusterIdByTabId.set(tabId, id);
    return { id, name: c.provisionalName || "" };
  });
  const tabsPayload = tabs.map((t) => {
    const row = {
      id: shortIdByTabId.get(t.id),
      title: truncateText(t.title, 120),
      url: truncateText(t.url, 120),
      summary: truncateText(t.pageSummary, summaryBudget),
      minutesAgo: Number.isFinite(t.lastAccessed) ? Math.round((now - t.lastAccessed) / 60_000) : null
    };
    if (t.hasUnsavedInput) row.unsaved = true;
    if (clusterIdByTabId.has(t.id)) row.cluster = clusterIdByTabId.get(t.id);
    return row;
  });

  const body = {
    model: LLM_MODEL,
    reasoning_effort: "low",
    prompt_cache_key: proactive ? "neat-freak-proactive" : "neat-freak-smart",
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "tidy_folders",
        strict: true,
        schema: {
          type: "object",
          additionalProperties: false,
          required: ["groups"],
          properties: {
            groups: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: false,
                required: ["name", "tabIds"],
                properties: {
                  name: { type: "string" },
                  tabIds: { type: "array", items: { type: "string" } }
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
          ...(proactive ? [
            "You prepare an optional suggestion: which open Chrome tabs the user could put away now. Put-away tabs are saved into folders and reopen in one click. The user has not asked to close anything.",
            "Include a tab only when its content and context suggest the user is finished with it. When unsure, leave it out. Including nothing is valid; there is no quota.",
            "Age alone does not prove a tab is finished. Work surfaces (documents being edited, mail, calendars, dashboards, forms) need stronger evidence than articles, searches, videos, social feeds or completed confirmations and receipts."
          ] : [
            "The user clicked Smart because they want their tab clutter cleared. Choose which open Chrome tabs to put away now. Put-away tabs are saved into folders and reopen in one click.",
            "Put away read-once and finished content: articles, searches, videos, social feeds, finished confirmations and receipts, and anything not used for hours.",
            "Keep the user's active work: documents being written, mail, calendars, dashboards, forms, dev tools and project pages used in the last 60 minutes, and anything they would notice disappearing mid-task. Most people keep 3-5 such tabs.",
            ...(minSaveCount > 0 ? [
              `You must put away at least ${minSaveCount} of the ${tabs.length} tabs to get the user under their tab limit. Put away stale reference and read-once content before active work surfaces.`
            ] : [])
          ]),
          "Never include a tab with unsaved:true, or with minutesAgo null (opened in the background, never looked at).",
          `Tabs with minutesAgo under ${MIN_IDLE_MIN} stay open regardless; do not include them. Use them as context: an older tab in the same workstream as a recently used one may still be needed.`,
          "Group the listed tabs into folders by workstream: shared topic, entity or site first; closeness in minutesAgo is only a tie-breaker. Folder names under 52 characters. Each listed tab appears in exactly one folder. Use the short tab ids given."
        ].join("\n")
      },
      { role: "user", content: JSON.stringify({ tabs: tabsPayload, clusters }) }
    ]
  };

  return { body, tabIdByShortId: new Map([...shortIdByTabId].map(([tabId, shortId]) => [shortId, tabId])) };
}

// Translate the compact answer into the shape parseSmartScopeResponse reads:
// listed tabs are saves and every other tab is an explicit keep. The manual
// tab-limit floor is still met afterwards by enforceMinSaveCount.
// Low reasoning sometimes ignores the recency instruction (2026-11-16: a
// background run offered an inbox used 14 min ago; manual runs closed every
// tab, including a doc used 12 min ago), so recency is enforced here for both,
// matching the local heuristic, which never closes a tab used in the last
// 30 minutes. Only the manual tab-limit floor may override it.
// modelPicks: every tab the model listed, before the recency guard (ids only,
// unknown ids dropped), so the opt-in tab habits log can replay other guards.
function expandCompactResponse(parsed, tabIdByShortId, tabs, now) {
  const allowed = new Set(tabs
    .filter((t) => Number.isFinite(t.lastAccessed) && now - t.lastAccessed >= MIN_IDLE_MIN * 60_000)
    .map((t) => t.id));
  const picked = (Array.isArray(parsed?.groups) ? parsed.groups : []).map((group) => ({
    name: group?.name,
    tabIds: (Array.isArray(group?.tabIds) ? group.tabIds : [])
      .map((shortId) => tabIdByShortId.get(String(shortId)))
      .filter(Boolean)
  }));
  const groups = picked.map((group) => ({ ...group, tabIds: group.tabIds.filter((tabId) => allowed.has(tabId)) }));
  const listed = new Set(groups.flatMap((group) => group.tabIds));
  return {
    groups,
    tabActions: tabs.map((t) => ({ tabId: t.id, action: listed.has(t.id) ? "save" : "keep" })),
    modelPicks: [...new Set(picked.flatMap((group) => group.tabIds))]
  };
}

async function runLlmPath(tabs, graph, settings, now, floorContext = {}) {
  const request = buildCompactRequest(tabs, graph, now, floorContext);
  const body = request.body;
  body.model = settings.llmModel || LLM_MODEL;

  // Chrome stops an MV3 service worker whose fetch takes more than 30 s, so a
  // slow or unavailable model falls back to the local tidy instead.
  const timeoutMs = 25_000;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(settings.backendUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${settings.enclaveKey || ""}`
      },
      body: JSON.stringify(body),
      signal: controller.signal
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Smart LLM call failed (${response.status}): ${truncateText(text, 180)}`);
    }
    const data = await response.json();
    const content = data?.choices?.[0]?.message?.content || "{}";
    const parsed = JSON.parse(content);
    const { modelPicks, ...standard } = expandCompactResponse(parsed, request.tabIdByShortId, tabs, now);
    // Token totals for diagnostics; counts only, never content.
    const usage = Number.isFinite(data?.usage?.prompt_tokens) || Number.isFinite(data?.usage?.completion_tokens)
      ? { promptTokens: data.usage.prompt_tokens, completionTokens: data.usage.completion_tokens } : undefined;
    return { ...parseSmartScopeResponse(standard, tabs, graph, now, floorContext), modelPicks, ...(usage ? { usage } : {}) };
  } finally {
    clearTimeout(timeout);
  }

}

// Turn the LLM's JSON response into save/keep sets and finalized folder
// categories. Applies the same exact-URL dedup the heuristic uses, so
// duplicates get saved regardless of whether the model noticed. Pure +
// exported so the eval harness can score raw model responses without a fetch.
export function parseSmartScopeResponse(parsed, tabs, graph, now, opts = {}) {
  const actionsArray = Array.isArray(parsed.tabActions) ? parsed.tabActions : [];
  const actionByTabId = new Map(actionsArray.map((a) => [a.tabId, a]));

  const dedupSaveIds = computeUrlDedupSaveIds(tabs, now);

  const saveIds = [];
  const keepIds = [];
  for (const t of tabs) {
    if (dedupSaveIds.has(t.id)) {
      saveIds.push(t.id);
      continue;
    }
    const action = actionByTabId.get(t.id);
    if (action?.action === "keep" || (opts.proactive && action?.action !== "save")) keepIds.push(t.id);
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

  return { saveSet, keepSet, categories: finalizeLlmCategories(categories, saveSet, tabs, graph), mode: "llm" };
}

// The local heuristic's inputs and decision as plain numbers, for the opt-in
// tab habits log (behavior-log.js): it stores these, never titles or URLs, and
// eval/behavior-rules.js replays the heuristic from them offline. Mirrors the
// proactive heuristic path: cluster cutoffs, URL dedup, then the protected-tab
// safety net. Keyed by saved-tab id.
export function heuristicSignals(tabs, now = Date.now()) {
  const graph = attachTabsToGraph(buildAssociationGraph(tabs), tabs);
  const clusters = graph.clusters.map((c) => ({ id: c.id, tabIds: c.tabIds }));
  const saveIds = new Set(applySmartHeuristic(tabs, clusters, now, { proactive: true }).saveIds);
  const duplicates = computeUrlDedupSaveIds(tabs, now);
  const tabById = new Map(tabs.map((t) => [t.id, t]));
  const clusterIdle = new Map();
  for (const cluster of clusters) {
    const newest = Math.max(0, ...cluster.tabIds.map((id) => effectiveAccess(tabById.get(id), now)));
    for (const id of cluster.tabIds) clusterIdle.set(id, newest ? (now - newest) / 60_000 : Infinity);
  }
  return new Map(tabs.map((t) => [t.id, {
    clustered: clusterIdle.has(t.id),
    clusterIdleMin: clusterIdle.get(t.id) ?? null,
    duplicate: duplicates.has(t.id),
    contentScore: contentSavabilityScore(t),
    offer: saveIds.has(t.id) && !(t.active || t.audible || t.hasUnsavedInput || t.signalsUnavailable),
  }]));
}
