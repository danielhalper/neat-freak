import { categorizeTabs, testLlm } from "./categorizer.js";
import { runSmartScope } from "./smart-scope.js";
import {
  addSession,
  deleteSession,
  getSessions,
  getSettings,
  saveSessions,
  saveSettings,
  updateSession
} from "./storage.js";
import { createId, getDomain, isSavableUrl, nowIso, truncateText } from "./utils.js";

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  routeMessage(message)
    .then((response) => sendResponse({ ok: true, ...response }))
    .catch((error) => sendResponse({ ok: false, error: error.message }));
  return true;
});

// chrome.storage.session defaults to TRUSTED_CONTEXTS — meaning the service
// worker and extension pages can read it but content scripts can NOT. The
// clutter and done toasts run as injected content scripts and read the tab
// count from session storage. Without this, every toast renders with whatever
// default the script falls back to (e.g. "20 tabs" regardless of reality).
if (chrome.storage?.session?.setAccessLevel) {
  chrome.storage.session
    .setAccessLevel({ accessLevel: "TRUSTED_AND_UNTRUSTED_CONTEXTS" })
    .catch((err) => console.warn("[Neat Freak] session storage access:", err?.message || err));
}

// Track whether the Chrome action popup is open. The popup opens a long-lived
// "popup-alive" port on load; Chrome auto-disconnects it when the popup closes
// (focus moves outside). We count active ports so two simultaneous popup
// instances (rare but possible during edge transitions) don't corrupt state.
let activePopupPorts = 0;
function isPopupOpen() {
  return activePopupPorts > 0;
}
if (chrome.runtime?.onConnect) {
  chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== "popup-alive") return;
    activePopupPorts += 1;
    port.onDisconnect.addListener(() => {
      activePopupPorts = Math.max(0, activePopupPorts - 1);
    });
  });
}

async function routeMessage(message) {
  switch (message?.type) {
    case "GET_POPUP_STATE":
      return getPopupState();
    case "PREVIEW_TABS":
      return { preview: await previewTabs(message.options || {}) };
    case "GET_SESSIONS":
      return { sessions: await getSessions() };
    case "GET_SETTINGS":
      return { settings: await getSettings() };
    case "SAVE_SETTINGS":
      return { settings: await saveSettings(message.settings || {}) };
    case "SAVE_TABS":
      return saveTabs(message.options || {});
    case "CLOSE_SAVED_TABS":
      return closeSavedTabs(message.sessionId);
    case "RESTORE_TAB":
      return restoreTabsByIds(message.sessionId, [message.tabId]);
    case "RESTORE_GROUP":
      return restoreGroup(message.sessionId, message.categoryId);
    case "RESTORE_SESSION":
      return restoreSession(message.sessionId);
    case "RESTORE_ALL_SESSIONS":
      return restoreAllSessions();
    case "DELETE_TAB":
      return deleteSavedTab(message.sessionId, message.tabId);
    case "DELETE_GROUP":
      return deleteSavedGroup(message.sessionId, message.categoryId);
    case "DELETE_SESSION":
      return { sessions: await deleteSession(message.sessionId) };
    case "RECATEGORIZE_SESSION":
      return recategorizeSession(message.sessionId);
    case "IMPORT_SESSIONS":
      return importSessions(message.sessions || []);
    case "OPEN_MANAGER":
      await openManager(message.sessionId);
      return {};
    case "OPEN_OPTIONS":
      chrome.runtime.openOptionsPage();
      return {};
    case "TEST_LLM":
      return testLlmConnection(message.settings);
    case "SEARCH_TABS":
      return searchSavedTabs(message.query || "", message.mode || "local");
    case "MARK_ONBOARDED":
      return markOnboarded();
    case "CLUTTER_TOAST_TIDY":      // legacy alias from any in-flight content scripts; same handler
    case "PANEL_TIDY_NOW":
      return handlePanelTidyNow();
    case "DONE_TOAST_OPEN":          // legacy alias
    case "PANEL_OPEN_MANAGER":
      await openManager(message.sessionId || "");
      await setPanelState({ mode: "hidden" });
      return {};
    case "PANEL_DISMISS":
      await setPanelState({ mode: "hidden" });
      return {};
    case "OPEN_PANEL_FROM_ICON":
      return openPanelFromIcon();
    default:
      throw new Error("Unknown Neat Freak message.");
  }
}

// Popup-shim entry point. Called from popup.js when the user clicks the
// toolbar icon. We try to inject the floating panel on the active tab; if it
// works, popup.js closes itself and the panel is the surface. If injection
// fails (chrome:// page, web store, etc.), popup.js falls back to rendering
// the existing popup UI inline.
async function openPanelFromIcon() {
  const activeTabs = await queryTabs({ active: true, lastFocusedWindow: true });
  const target = activeTabs[0];
  if (!target?.id || !isInjectablePageUrl(target.url)) {
    return { injected: false };
  }
  await setPanelState({ mode: "idle" });
  // setPanelState already attempts injection; success/failure is implicit in
  // whether it threw, but we can be explicit by trying once more — cheap.
  const ok = await ensurePanelMounted();
  return { injected: ok };
}

async function getPopupState() {
  const settings = await getSettings();
  const sessions = await getSessions();
  const preview = await previewTabs({
    includePinned: settings.defaultIncludePinned,
    keepCurrentTab: settings.defaultKeepCurrentTab,
    scope: settings.defaultScope
  });
  return { preview, sessions: sessions.slice(0, 3), settings };
}

async function previewTabs(options) {
  const { candidates, skipped } = await getCandidateTabs(options);
  const domains = [...new Set(candidates.map((tab) => getDomain(tab.url)).filter(Boolean))].slice(0, 6);
  return {
    count: candidates.length,
    skippedCount: skipped.length,
    domains
  };
}

function emitProgress(payload) {
  try {
    chrome.runtime.sendMessage({ type: "SAVE_PROGRESS", ...payload }).catch(() => undefined);
  } catch {
    // No open popup is listening — that's fine. Notifications cover that case.
  }
  // Persist the latest step so a re-opened popup can recover state.
  try {
    const session = chrome.storage?.session;
    if (!session) return;
    const enriched = { ...payload, t: Date.now() };
    session.set({ neatFreakSaveState: enriched }).catch(() => undefined);
    if (payload.step === "done") {
      // Auto-expire the done snapshot after 60s so we don't show a stale "tucked away" message hours later.
      setTimeout(() => {
        session.remove("neatFreakSaveState").catch(() => undefined);
      }, 60 * 1000);
    }
  } catch {
    // chrome.storage.session may be unavailable in some older Chromiums; tolerate it.
  }

  // Mirror progress into the floating panel's saving state so the sub-text
  // updates per step ("Capturing N URLs…" → "Grouping…" → "Saving…"). Skipped
  // if the popup is open — popup handles its own progress UI.
  if (!isPopupOpen() && payload?.step && payload.step !== "done") {
    const label = progressLabelFor(payload);
    setPanelState({ mode: "saving", label }).catch(() => undefined);
  }
}

function progressLabelFor(payload) {
  switch (payload.step) {
    case "scanning":
      return "Scanning open tabs";
    case "capturing":
      return payload.tabCount ? `Capturing ${payload.tabCount} URL${payload.tabCount === 1 ? "" : "s"}` : "Capturing URLs";
    case "grouping":
      return payload.llm ? "Grouping with AI" : "Grouping locally";
    case "saving":
      return "Saving";
    default:
      return "Organizing";
  }
}

async function saveTabs(options) {
  const settings = await getSettings();
  const captureOptions = {
    includePinned: Boolean(options.includePinned ?? settings.defaultIncludePinned),
    keepCurrentTab: Boolean(options.keepCurrentTab ?? settings.defaultKeepCurrentTab),
    reviewBeforeClose: Boolean(options.reviewBeforeClose ?? settings.defaultReviewBeforeClose),
    scope: options.scope || settings.defaultScope || "allWindows"
  };

  const { candidates, skipped } = await getCandidateTabs(captureOptions);
  if (!candidates.length) {
    throw new Error("No savable tabs found. Chrome internal pages and extension pages are skipped.");
  }

  // Only auto-open the Manager if closing the candidate tabs would leave Chrome
  // with no surviving tabs (otherwise Chrome would quit and the user would lose
  // their workspace). If skipped/other tabs exist, don't yank them into the Manager.
  if (options.openManager !== false) {
    const survivors = await countSurvivingTabs(candidates);
    if (survivors === 0) {
      await openManager();
    }
  }

  emitProgress({ step: "scanning", tabCount: candidates.length });
  emitProgress({ step: "capturing", tabCount: candidates.length });
  const tabs = await buildSavedTabs(candidates, settings);

  const willUseLlm = settings.llmEnabled && settings.apiKey;
  emitProgress({ step: "grouping", tabCount: tabs.length, llm: Boolean(willUseLlm) });

  let categories;
  let meta;
  let smartResult = null;
  let tabsToClose;

  if (captureOptions.scope === "smart") {
    smartResult = await runSmartScope(tabs, settings);
    categories = smartResult.categories;
    meta = {
      method: smartResult.mode === "llm" ? "smart-llm" : "smart-heuristic",
      error: smartResult.error || "",
      keepCount: smartResult.keepSet.length,
      saveCount: smartResult.saveSet.length
    };
    tabsToClose = smartResult.saveSet;
  } else {
    const result = await categorizeTabs(tabs, settings);
    categories = result.categories;
    meta = result.meta;
    tabsToClose = tabs;
  }

  emitProgress({ step: "saving" });
  const session = {
    id: createId("session"),
    categories,
    closeStatus: captureOptions.reviewBeforeClose ? "review" : "closed",
    closedAt: captureOptions.reviewBeforeClose ? "" : nowIso(),
    createdAt: nowIso(),
    pendingTabIds: captureOptions.reviewBeforeClose ? tabsToClose.map((tab) => tab.originalTabId || tab.id).filter(Number.isFinite) : [],
    scope: captureOptions.scope,
    skipped,
    tabs: smartResult ? tabsToClose : tabs,
    title: createSessionTitle(smartResult ? tabsToClose : candidates),
    updatedAt: nowIso(),
    categorization: meta
  };

  await addSession(session);
  notifySessionReady(session, meta);
  // Unified panel: transition to done state. showPanelDone short-circuits if
  // the Chrome popup is open (it handles its own done state) so we don't
  // compete for the user's attention.
  showPanelDone(session, meta, smartResult).catch(() => undefined);
  const folderSummaries = (categories || [])
    .filter((c) => (c.tabIds || []).length >= 2)
    .map((c) => ({ id: c.id, name: c.name, count: c.tabIds.length }));
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

  if (!captureOptions.reviewBeforeClose) {
    // For Smart, only close the chosen save set. For other scopes, close all candidates.
    const closeSource = smartResult ? tabsToClose : candidates;
    await closeTabIds(closeSource.map((tab) => tab.originalTabId || tab.id).filter(Number.isFinite));
  }

  return { session };
}

async function countSurvivingTabs(candidates) {
  const all = await queryTabs({});
  const candidateIds = new Set(candidates.map((t) => t.id).filter(Number.isFinite));
  return all.filter((tab) => !candidateIds.has(tab.id)).length;
}

async function getCandidateTabs(options) {
  const query = (options.scope === "allWindows" || options.scope === "smart") ? {} : { currentWindow: true };
  const tabs = await queryTabs(query);
  const skipped = [];
  const candidates = [];

  for (const tab of tabs) {
    const reason = getSkipReason(tab, options);
    if (reason) {
      skipped.push({
        id: tab.id,
        title: tab.title || tab.url || "Untitled",
        url: tab.url || "",
        reason
      });
      continue;
    }
    candidates.push(tab);
  }

  return { candidates, skipped };
}

function getSkipReason(tab, options) {
  const { includePinned, keepCurrentTab } = options || {};
  if (!tab?.id || !tab.url) return "missing-url";
  if (keepCurrentTab && tab.active) return "current-tab";
  if (tab.pinned && !includePinned) return "pinned";
  if (!isSavableUrl(tab.url)) return "unsupported-url";
  return "";
}

async function buildSavedTabs(tabs, settings) {
  return mapLimit(tabs, 8, async (tab) => {
    const domain = getDomain(tab.url);
    const pageSummary = settings.collectPageSummaries && tab.url?.startsWith("http")
      ? await getPageSummary(tab.id, settings.maxSnippetChars).catch(() => "")
      : "";

    return {
      id: createId("tab"),
      active: Boolean(tab.active),
      audible: Boolean(tab.audible),
      domain,
      favIconUrl: tab.favIconUrl || "",
      index: Number.isFinite(tab.index) ? tab.index : 0,
      // lastAccessed is the only signal Smart scope has for "is this tab actually in use?".
      // Without it, every tab looks brand-new (null), and the LLM can't tell stale from fresh —
      // which is exactly what caused recently-opened tabs to get closed.
      lastAccessed: Number.isFinite(tab.lastAccessed) ? tab.lastAccessed : undefined,
      originalTabId: tab.id,
      pageSummary,
      pinned: Boolean(tab.pinned),
      title: tab.title || domain || tab.url,
      url: tab.url,
      windowId: tab.windowId
    };
  });
}

async function getPageSummary(tabId, maxChars) {
  // Cap per-tab summary extraction at 4 seconds. If a tab is unresponsive
  // (restricted page, suspended, slow-loading), we'd rather skip its summary
  // than hang the entire save flow.
  const scriptPromise = executeScript({
    target: { tabId },
    func: collectPageSummary,
    args: [Number(maxChars || 720)]
  });
  const result = await Promise.race([
    scriptPromise,
    new Promise((resolve) => setTimeout(() => resolve(null), 4000))
  ]);
  return result?.[0]?.result || "";
}

function collectPageSummary(maxChars) {
  const readMeta = (name) => document.querySelector(`meta[name="${name}"], meta[property="${name}"]`)?.getAttribute("content") || "";
  const title = document.title || "";
  const description = readMeta("description") || readMeta("og:description") || readMeta("twitter:description");
  const h1 = document.querySelector("h1")?.innerText || "";
  const headings = [...document.querySelectorAll("h2, h3")]
    .slice(0, 6)
    .map((element) => element.innerText)
    .filter(Boolean)
    .join(" | ");
  const paragraphs = [...document.querySelectorAll("article p, main p, p")]
    .slice(0, 8)
    .map((element) => element.innerText)
    .filter((text) => text && text.length > 32)
    .join(" ");
  return [title, description, h1, headings, paragraphs]
    .filter(Boolean)
    .join(" -- ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxChars);
}

async function closeSavedTabs(sessionId) {
  const session = (await getSessions()).find((item) => item.id === sessionId);
  if (!session) throw new Error("Session not found.");
  await closeTabIds(session.pendingTabIds || []);
  const updated = await updateSession(sessionId, (current) => ({
    ...current,
    closeStatus: "closed",
    closedAt: nowIso(),
    pendingTabIds: []
  }));
  return { session: updated, sessions: await getSessions() };
}

async function restoreTabsByIds(sessionId, tabIds) {
  const session = (await getSessions()).find((item) => item.id === sessionId);
  if (!session) throw new Error("Session not found.");
  const wanted = new Set(tabIds);
  const tabs = session.tabs.filter((tab) => wanted.has(tab.id));
  await restoreUrls(tabs.map((tab) => tab.url));
  return {};
}

async function restoreGroup(sessionId, categoryId) {
  const session = (await getSessions()).find((item) => item.id === sessionId);
  if (!session) throw new Error("Session not found.");
  const category = session.categories.find((item) => item.id === categoryId);
  if (!category) throw new Error("Group not found.");
  const wanted = new Set(category.tabIds);
  await restoreUrls(session.tabs.filter((tab) => wanted.has(tab.id)).map((tab) => tab.url));
  return {};
}

async function restoreSession(sessionId) {
  const session = (await getSessions()).find((item) => item.id === sessionId);
  if (!session) throw new Error("Session not found.");
  await restoreUrls(session.tabs.map((tab) => tab.url));
  return {};
}

async function restoreAllSessions() {
  const sessions = await getSessions();
  const urls = sessions.flatMap((session) => (session.tabs || []).map((tab) => tab.url));
  if (!urls.length) throw new Error("No saved tabs to restore.");
  await restoreUrls(urls);
  return {};
}

async function deleteSavedTab(sessionId, tabId) {
  const updated = await updateSession(sessionId, (session) => {
    const tabs = session.tabs.filter((tab) => tab.id !== tabId);
    const categories = session.categories
      .map((category) => ({
        ...category,
        tabIds: category.tabIds.filter((id) => id !== tabId)
      }))
      .filter((category) => category.tabIds.length);
    return { ...session, tabs, categories };
  });
  return { session: updated, sessions: await getSessions() };
}

async function deleteSavedGroup(sessionId, categoryId) {
  const session = (await getSessions()).find((item) => item.id === sessionId);
  if (!session) throw new Error("Session not found.");
  const category = session.categories.find((item) => item.id === categoryId);
  if (!category) throw new Error("Group not found.");
  const dropTabIds = new Set(category.tabIds);

  if (dropTabIds.size === session.tabs.length) {
    const sessions = await deleteSession(sessionId);
    return { session: null, sessions };
  }

  const updated = await updateSession(sessionId, (current) => {
    const tabs = current.tabs.filter((tab) => !dropTabIds.has(tab.id));
    const categories = current.categories
      .filter((item) => item.id !== categoryId)
      .map((item) => ({ ...item, tabIds: item.tabIds.filter((id) => !dropTabIds.has(id)) }))
      .filter((item) => item.tabIds.length);
    const pendingTabIds = (current.pendingTabIds || []).filter((id) => {
      const tab = current.tabs.find((t) => t.id === id || t.originalTabId === id);
      return tab ? !dropTabIds.has(tab.id) : true;
    });
    return { ...current, tabs, categories, pendingTabIds };
  });
  return { session: updated, sessions: await getSessions() };
}

async function recategorizeSession(sessionId) {
  const settings = await getSettings();
  const session = (await getSessions()).find((item) => item.id === sessionId);
  if (!session) throw new Error("Session not found.");
  const { categories, meta } = await categorizeTabs(session.tabs, settings);
  const updated = await updateSession(sessionId, (current) => ({
    ...current,
    categories,
    categorization: meta
  }));
  return { session: updated, sessions: await getSessions() };
}

async function importSessions(incoming) {
  if (!Array.isArray(incoming)) throw new Error("Import file must contain an array of sessions.");
  const existing = await getSessions();
  const normalized = incoming
    .filter((session) => session && Array.isArray(session.tabs) && Array.isArray(session.categories))
    .map((session) => ({
      ...session,
      id: session.id || createId("session"),
      importedAt: nowIso(),
      pendingTabIds: []
    }));
  await saveSessions([...normalized, ...existing]);
  return { sessions: await getSessions() };
}

async function testLlmConnection(settingsOverride) {
  const settings = { ...(await getSettings()), ...(settingsOverride || {}) };
  if (!settings.apiKey) throw new Error("Add an API key before testing the LLM.");
  const result = await testLlm(settings);
  return { result };
}

const SEARCH_STOP_WORDS = new Set([
  "the", "a", "an", "is", "to", "of", "for", "and", "or", "in", "on", "at",
  "i", "me", "my", "we", "our", "you", "your", "it", "that", "this", "with",
  "be", "was", "were", "are", "am", "do", "did", "does", "have", "has", "had",
  "what", "where", "when", "which", "who", "how", "why",
  "tab", "tabs", "page", "pages", "site", "sites"
]);

async function searchSavedTabs(query, mode) {
  const trimmed = String(query || "").trim();
  if (!trimmed) return { results: [], mode: "empty" };

  const allTabs = await flattenSavedTabs();
  if (!allTabs.length) return { results: [], mode: "empty" };

  const localRanked = rankLocalSearch(allTabs, trimmed);
  if (mode !== "smart") {
    return { results: localRanked.slice(0, 30), mode: "local" };
  }

  const settings = await getSettings();
  if (!settings.apiKey) {
    return { results: localRanked.slice(0, 30), mode: "local", error: "Add an API key in settings to enable smart search." };
  }

  const candidates = localRanked.slice(0, 80);
  if (!candidates.length) return { results: [], mode: "smart" };

  try {
    const matches = await smartSearchTabs(trimmed, candidates, settings);
    const indexed = new Map(candidates.map((item) => [item.tabId, item]));
    const ranked = matches
      .map((match) => {
        const tab = indexed.get(match.tabId);
        if (!tab) return null;
        return { ...tab, smartScore: Number(match.score) || 0, smartReason: match.reason || "" };
      })
      .filter(Boolean);
    return { results: ranked.slice(0, 30), mode: "smart" };
  } catch (error) {
    return { results: localRanked.slice(0, 30), mode: "local", error: error.message };
  }
}

async function flattenSavedTabs() {
  const sessions = await getSessions();
  const flat = [];
  for (const session of sessions) {
    const tabsById = new Map((session.tabs || []).map((tab) => [tab.id, tab]));
    for (const category of (session.categories || [])) {
      const folderName = category.name || "";
      const folderSize = (category.tabIds || []).length;
      for (const tabId of (category.tabIds || [])) {
        const tab = tabsById.get(tabId);
        if (!tab) continue;
        flat.push({
          tabId: tab.id,
          sessionId: session.id,
          sessionCreatedAt: session.createdAt,
          folderName,
          folderSize,
          title: tab.title || "",
          url: tab.url || "",
          domain: tab.domain || "",
          favIconUrl: tab.favIconUrl || "",
          pageSummary: tab.pageSummary || ""
        });
      }
    }
  }
  return flat;
}

function tokenizeQuery(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2 && !SEARCH_STOP_WORDS.has(token));
}

function rankLocalSearch(tabs, query) {
  const tokens = tokenizeQuery(query);
  if (!tokens.length) return [];
  const queryLower = query.toLowerCase();
  const now = Date.now();

  const scored = tabs.map((tab) => {
    const haystack = [tab.title, tab.url, tab.domain, tab.folderName, tab.pageSummary]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    let score = 0;
    if (haystack.includes(queryLower)) score += 3;
    for (const token of tokens) {
      if (!haystack.includes(token)) continue;
      score += 1;
      if (tab.title.toLowerCase().includes(token)) score += 0.5;
      if (tab.domain.toLowerCase().includes(token)) score += 0.25;
    }
    // recency boost: newer sessions get a small lift
    const age = tab.sessionCreatedAt ? (now - Date.parse(tab.sessionCreatedAt)) : Infinity;
    if (Number.isFinite(age) && age < 1000 * 60 * 60 * 24 * 14) score += 0.2;
    return { tab, score };
  });

  return scored
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((entry) => entry.tab);
}

async function smartSearchTabs(query, candidates, settings) {
  const url = "https://api.openai.com/v1/chat/completions";
  const payload = candidates.map((tab) => ({
    tabId: tab.tabId,
    title: truncateText(tab.title, 160),
    url: truncateText(tab.url, 180),
    domain: tab.domain,
    folder: tab.folderName,
    summary: truncateText(tab.pageSummary, 320)
  }));

  const body = {
    model: "gpt-5.4-mini",
    reasoning_effort: "none",
    prompt_cache_key: "neat-freak-search",
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "tab_search_matches",
        strict: true,
        schema: {
          type: "object",
          additionalProperties: false,
          required: ["matches"],
          properties: {
            matches: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: false,
                required: ["tabId", "score", "reason"],
                properties: {
                  tabId: { type: "string" },
                  score: { type: "number" },
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
          "You're helping someone find a saved browser tab. They'll give you a natural-language query and a list of saved tab metadata.",
          "Return the tabs that genuinely match the user's intent, ranked best-first. Include up to 12 matches. Skip tabs that don't actually fit.",
          "Use shorthand and entity matching: \"ux applicants\" should hit Google Drive resumes and LinkedIn profiles for UX candidates.",
          "Score from 0.0 (weak match) to 1.0 (definite). Keep reasons under 80 chars."
        ].join(" ")
      },
      { role: "user", content: JSON.stringify({ query, tabs: payload }) }
    ]
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30000);
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${settings.apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body),
      signal: controller.signal
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Smart search failed (${response.status}): ${truncateText(text, 180)}`);
    }
    const data = await response.json();
    const content = data?.choices?.[0]?.message?.content || "{}";
    const parsed = JSON.parse(content);
    return Array.isArray(parsed.matches) ? parsed.matches : [];
  } finally {
    clearTimeout(timer);
  }
}

async function restoreUrls(urls) {
  const uniqueUrls = [...new Set(urls.filter(Boolean))];
  for (const [index, url] of uniqueUrls.entries()) {
    await createTab({ url, active: index === 0 });
  }
}

async function openManager(sessionId = "") {
  const base = chrome.runtime.getURL("manager.html");
  const target = sessionId ? `${base}#${encodeURIComponent(sessionId)}` : base;
  const existing = await queryTabs({ url: `${base}*` });
  if (existing.length) {
    const tab = existing[0];
    await updateTab(tab.id, { active: true, url: target });
    if (tab.windowId !== undefined) {
      await focusWindow(tab.windowId).catch(() => undefined);
    }
    return;
  }
  await createTab({ url: target, active: true });
}

function updateTab(tabId, updateProperties) {
  return new Promise((resolve, reject) => {
    chrome.tabs.update(tabId, updateProperties, (tab) => {
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(error.message));
      else resolve(tab);
    });
  });
}

function focusWindow(windowId) {
  return new Promise((resolve, reject) => {
    if (!chrome.windows?.update) return resolve();
    chrome.windows.update(windowId, { focused: true }, (win) => {
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(error.message));
      else resolve(win);
    });
  });
}

function createSessionTitle(tabs) {
  return `${tabs.length} tab${tabs.length === 1 ? "" : "s"}`;
}

const NOTIFICATION_PREFIX = "neat-freak-session:";

function notifySessionReady(session, meta) {
  if (!chrome.notifications?.create) return;
  const categories = session.categories || [];
  const folders = categories.filter((c) => (c.tabIds || []).length >= 2).length;
  const loose = categories.filter((c) => (c.tabIds || []).length === 1).length;
  const tabCount = (session.tabs || []).length;
  const llm = meta?.method?.includes("llm");

  const summary = [
    `${tabCount} tab${tabCount === 1 ? "" : "s"} tucked away`,
    `${folders} folder${folders === 1 ? "" : "s"}${loose ? ` · ${loose} loose` : ""}`
  ].join(" · ");

  const message = llm
    ? "Grouped with AI. Click to open the manager."
    : "Grouped locally. Click to open the manager.";

  try {
    chrome.notifications.create(`${NOTIFICATION_PREFIX}${session.id}`, {
      type: "basic",
      iconUrl: chrome.runtime.getURL("assets/icon-128.png"),
      title: `Neat Freak — ${summary}`,
      message,
      priority: 1,
      requireInteraction: false
    }, () => {
      const error = chrome.runtime.lastError;
      if (error) {
        // Surface this in the service worker console so the user can diagnose
        // why they're not seeing notifications (usually OS-level permission denied).
        console.warn("[Neat Freak] Session-ready notification failed:", error.message);
      }
    });
  } catch (err) {
    console.warn("[Neat Freak] Session-ready notification threw:", err?.message || err);
  }
}

// ===== Floating panel state =====
// Single source of truth for the in-page floating panel. setPanelState writes
// the new mode to chrome.storage.session.neatFreakPanelState and (re-)injects
// the panel script so it picks up the change. The panel script is idempotent:
// if it's already mounted on the active tab, the re-injection just triggers a
// re-render against the new state.

const PANEL_STATE_KEY = "neatFreakPanelState";

async function setPanelState(state) {
  try {
    await chrome.storage.session?.set?.({ [PANEL_STATE_KEY]: state });
  } catch (err) {
    console.warn("[Neat Freak] Panel state write failed:", err?.message || err);
    return false;
  }
  if (!state || state.mode === "hidden") return true;
  return ensurePanelMounted();
}

async function ensurePanelMounted() {
  const activeTabs = await queryTabs({ active: true, lastFocusedWindow: true });
  const target = activeTabs[0];
  if (!target?.id || !isInjectablePageUrl(target.url)) return false;
  try {
    await chrome.scripting.executeScript({
      target: { tabId: target.id },
      files: ["src/neat-freak-panel.js"]
    });
    return true;
  } catch (err) {
    // Restricted pages we didn't predict (PDFs, view-source:, etc.).
    console.warn("[Neat Freak] Panel injection failed:", err?.message || err);
    return false;
  }
}

// Replaces the old showDoneToast — writes the panel into done state, which
// the persistent panel picks up and renders in place. If the popup is open
// (handling its own done state), we skip the panel write entirely.
async function showPanelDone(session, meta, smartResult) {
  if (isPopupOpen()) return false;
  const categories = session.categories || [];
  const groupCount = categories.filter((c) => (c.tabIds || []).length >= 2).length;
  const looseCount = categories.filter((c) => (c.tabIds || []).length === 1).length;
  const tabCount = (session.tabs || []).length;
  const keepCount = smartResult ? (smartResult.keepSet?.length || 0) : 0;

  return setPanelState({
    mode: "done",
    tabCount,
    groupCount,
    looseCount,
    keepCount,
    sessionId: session.id,
    llm: Boolean(meta?.method?.includes("llm"))
  });
}

// Tidy now (from the panel's clutter state) — transition through saving and
// done in place rather than dismissing the panel and re-showing a new toast.
async function handlePanelTidyNow() {
  await setPanelState({ mode: "saving", label: "Tidying your tabs" });
  try {
    await saveTabs({ scope: "smart" });
  } catch (err) {
    console.warn("[Neat Freak] Tidy-from-panel save failed:", err?.message || err);
    // Fallback: hide the panel and open the manager so the user has a path forward.
    await setPanelState({ mode: "hidden" });
    await openManager();
  }
  return {};
}

if (chrome.notifications?.onClicked) {
  chrome.notifications.onClicked.addListener((notificationId) => {
    // Only the session-ready notification uses chrome.notifications now.
    // Clutter alerts run through the in-page toast, not the OS.
    if (!notificationId.startsWith(NOTIFICATION_PREFIX)) return;
    const sessionId = notificationId.slice(NOTIFICATION_PREFIX.length);
    openManager(sessionId).catch(() => undefined);
    chrome.notifications.clear(notificationId);
  });
}

// ===== Clutter watcher =====
// Two surfaces, both inside Chrome (never OS-level):
//   1. Icon badge — persistent count when the user is at or above the threshold.
//      Always reactive to tab events, can't be denied by the OS.
//   2. Toast — content script injected into the active tab on the FIRST crossing
//      of the threshold. Stays quiet until the count drops back below the
//      hysteresis floor and crosses up again — otherwise it would follow the user
//      from tab to tab on every navigation.

const CLUTTER_HYSTERESIS = 3; // count must dip to (threshold - this) before we'll alert again
const CLUTTER_THRESHOLD_FALLBACK = 20; // used only if reading settings fails
const CLUTTER_DISABLED_KEY = "neatFreakClutterDisabled";
const CLUTTER_ALERTED_KEY = "neatFreakClutterAlerted"; // session-scoped: were we already at/over threshold?
const CLUTTER_BADGE_COLOR = "#dc2626";
const CLUTTER_CHECK_DEBOUNCE_MS = 3000;
const CLUTTER_ALARM_NAME = "neat-freak-clutter-check";
const CLUTTER_ALARM_PERIOD_MIN = 30;
let clutterCheckTimer = null;

function scheduleClutterCheck() {
  if (clutterCheckTimer) clearTimeout(clutterCheckTimer);
  clutterCheckTimer = setTimeout(checkClutter, CLUTTER_CHECK_DEBOUNCE_MS);
}

function setBadge(tabCount, threshold) {
  if (!chrome.action?.setBadgeText) return;
  const shouldShow = tabCount >= threshold;
  chrome.action.setBadgeText({ text: shouldShow ? String(tabCount) : "" });
  if (shouldShow && chrome.action.setBadgeBackgroundColor) {
    chrome.action.setBadgeBackgroundColor({ color: CLUTTER_BADGE_COLOR });
  }
}

async function isClutterDisabled() {
  // Primary source: settings.showClutterNudges (settable from options UI).
  try {
    const settings = await getSettings();
    if (settings.showClutterNudges === false) return true;
  } catch {
    // Continue to legacy check.
  }
  // Legacy flag from the old "Don't show this again" toast button. Migration
  // moves this into settings on SW boot (see migrateLegacyClutterFlag below),
  // but we still honor it in case the migration hasn't run yet this session.
  const stored = await new Promise((resolve) => {
    chrome.storage.local.get([CLUTTER_DISABLED_KEY], (result) => resolve(result || {}));
  });
  return Boolean(stored[CLUTTER_DISABLED_KEY]);
}

// One-time migration: if the user disabled clutter via the old toast button,
// surface that as showClutterNudges=false in settings and clear the legacy key
// so settings UI is the single source of truth.
async function migrateLegacyClutterFlag() {
  try {
    const stored = await new Promise((resolve) => {
      chrome.storage.local.get([CLUTTER_DISABLED_KEY], (r) => resolve(r || {}));
    });
    if (!stored[CLUTTER_DISABLED_KEY]) return;
    await saveSettings({ showClutterNudges: false });
    await new Promise((resolve) => {
      chrome.storage.local.remove([CLUTTER_DISABLED_KEY], () => resolve());
    });
  } catch {
    // Migration is best-effort; the legacy fallback in isClutterDisabled catches the rest.
  }
}
migrateLegacyClutterFlag();

async function getClutterThreshold() {
  try {
    const settings = await getSettings();
    const value = Number(settings?.clutterThreshold);
    return Number.isFinite(value) && value > 0 ? value : CLUTTER_THRESHOLD_FALLBACK;
  } catch {
    return CLUTTER_THRESHOLD_FALLBACK;
  }
}

// Fast-path: update the badge immediately on tab events without waiting for the
// 3-second debounced clutter check. The badge should feel reactive even if the
// toast is intentionally throttled.
async function updateBadgeFromTabs() {
  try {
    const disabled = await isClutterDisabled();
    const threshold = await getClutterThreshold();
    if (disabled) { setBadge(0, threshold); return; }
    const tabs = await queryTabs({});
    setBadge(tabs.length, threshold);
  } catch {
    // Best-effort.
  }
}

async function showPanelClutter(tabCount) {
  // Write clutter state; the panel script picks it up and renders. If the
  // panel is already mounted (e.g. previous state still visible), the storage
  // change re-renders it in place.
  return setPanelState({ mode: "clutter", tabCount });
}

function isInjectablePageUrl(url) {
  if (!url) return false;
  // chrome.scripting.executeScript only works on regular web pages. Skip
  // privileged URLs Chrome will reject anyway.
  return /^https?:/.test(url);
}

async function checkClutter() {
  try {
    const disabled = await isClutterDisabled();
    const threshold = await getClutterThreshold();
    const tabs = await queryTabs({});
    const tabCount = tabs.length;

    setBadge(disabled ? 0 : tabCount, threshold);

    if (disabled) return;

    const sessionState = (await chrome.storage.session?.get?.(CLUTTER_ALERTED_KEY)) || {};
    const alreadyAlerted = Boolean(sessionState[CLUTTER_ALERTED_KEY]);

    if (tabCount < threshold) {
      // Once we've dropped enough below threshold, clear the alerted flag so the
      // next time the user climbs back above we'll show the toast again.
      if (alreadyAlerted && tabCount < threshold - CLUTTER_HYSTERESIS) {
        await chrome.storage.session?.set?.({ [CLUTTER_ALERTED_KEY]: false });
      }
      return;
    }

    if (alreadyAlerted) return; // edge-triggered: don't re-show until they dip and climb again

    const shown = await showPanelClutter(tabCount);
    if (shown) {
      await chrome.storage.session?.set?.({ [CLUTTER_ALERTED_KEY]: true });
    }
    // If we couldn't show the toast (privileged page), DON'T set alerted —
    // we'll try again on the next event when the user switches to a regular tab.
  } catch (err) {
    // Best-effort — the clutter watcher should never break the rest of the extension.
    console.warn("[Neat Freak] Clutter watcher threw:", err?.message || err);
  }
}

// "Tidy now" from the toast — kick off a Smart save directly instead of opening
// the popup. The whole point of the toast is to act with one click; opening the
// popup would feel like the toast just relocated, not actually did something.
async function handleClutterToastTidy() {
  try {
    await saveTabs({ scope: "smart" });
    return {};
  } catch (err) {
    // If the save fails for any reason (no candidates, etc.), fall back to
    // opening the manager so the user has SOME path forward.
    console.warn("[Neat Freak] Tidy-from-toast save failed:", err?.message || err);
    await openManager();
    return {};
  }
}

// The badge updates synchronously off tab events (no 3s wait) so it feels
// reactive. The toast check is still debounced via scheduleClutterCheck.
function onTabCountChanged() {
  updateBadgeFromTabs();
  scheduleClutterCheck();
}

if (chrome.tabs?.onCreated) {
  chrome.tabs.onCreated.addListener(onTabCountChanged);
}
if (chrome.tabs?.onRemoved) {
  chrome.tabs.onRemoved.addListener(onTabCountChanged);
}
if (chrome.runtime?.onStartup) {
  chrome.runtime.onStartup.addListener(() => onTabCountChanged());
}
// Initial paint on SW boot (covers extension reload + first install).
onTabCountChanged();

// chrome.alarms wakes the MV3 service worker on a schedule, even if it's gone
// idle and the setTimeout-based debounce got killed. This is the reliable
// safety net — tab events kick a fast check (3s debounce), alarms catch the
// case where the SW died mid-debounce or tabs were already at the threshold
// when the SW spun down.
if (chrome.alarms?.create) {
  chrome.alarms.create(CLUTTER_ALARM_NAME, {
    delayInMinutes: 1,
    periodInMinutes: CLUTTER_ALARM_PERIOD_MIN
  });
}
if (chrome.alarms?.onAlarm) {
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === CLUTTER_ALARM_NAME) scheduleClutterCheck();
  });
}

const ONBOARDED_KEY = "neatFreakOnboardedAt";

async function markOnboarded() {
  await new Promise((resolve, reject) => {
    chrome.storage.local.set({ [ONBOARDED_KEY]: nowIso() }, () => {
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(error.message));
      else resolve();
    });
  });
  return {};
}

async function hasOnboarded() {
  return new Promise((resolve) => {
    chrome.storage.local.get({ [ONBOARDED_KEY]: "" }, (result) => {
      resolve(Boolean(result?.[ONBOARDED_KEY]));
    });
  });
}

async function openWelcomeTab() {
  const url = chrome.runtime.getURL("welcome.html");
  await createTab({ url, active: true });
}

if (chrome.runtime.onInstalled) {
  chrome.runtime.onInstalled.addListener(async (details) => {
    if (details.reason !== "install") return;
    if (await hasOnboarded()) return;
    openWelcomeTab().catch(() => undefined);
  });
}

async function closeTabIds(tabIds) {
  const ids = [...new Set(tabIds.filter(Number.isFinite))];
  if (!ids.length) return;
  await Promise.all(ids.map((id) => removeTabs([id]).catch(() => undefined)));
}

function queryTabs(query) {
  return new Promise((resolve, reject) => {
    chrome.tabs.query(query, (tabs) => {
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(error.message));
      else resolve(tabs || []);
    });
  });
}

function createTab(createProperties) {
  return new Promise((resolve, reject) => {
    chrome.tabs.create(createProperties, (tab) => {
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(error.message));
      else resolve(tab);
    });
  });
}

function removeTabs(tabIds) {
  return new Promise((resolve, reject) => {
    chrome.tabs.remove(tabIds, () => {
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(error.message));
      else resolve();
    });
  });
}

function executeScript(details) {
  return new Promise((resolve, reject) => {
    chrome.scripting.executeScript(details, (result) => {
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(error.message));
      else resolve(result);
    });
  });
}

async function mapLimit(items, limit, mapper) {
  const results = [];
  const executing = new Set();

  for (const item of items) {
    const promise = Promise.resolve().then(() => mapper(item));
    results.push(promise);
    executing.add(promise);
    const clean = () => executing.delete(promise);
    promise.then(clean, clean);
    if (executing.size >= limit) await Promise.race(executing);
  }

  return Promise.all(results);
}
