import { categorizeTabs, testLlm } from "./categorizer.js";
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
    default:
      throw new Error("Unknown Neat Freak message.");
  }
}

async function getPopupState() {
  const settings = await getSettings();
  const sessions = await getSessions();
  const preview = await previewTabs({
    includePinned: settings.defaultIncludePinned,
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
}

async function saveTabs(options) {
  const settings = await getSettings();
  const captureOptions = {
    includePinned: Boolean(options.includePinned ?? settings.defaultIncludePinned),
    reviewBeforeClose: Boolean(options.reviewBeforeClose ?? settings.defaultReviewBeforeClose),
    scope: options.scope || settings.defaultScope || "allWindows"
  };

  emitProgress({ step: "scanning" });
  const { candidates, skipped } = await getCandidateTabs(captureOptions);
  if (!candidates.length) {
    throw new Error("No savable tabs found. Chrome internal pages and extension pages are skipped.");
  }

  emitProgress({ step: "capturing", tabCount: candidates.length });
  const tabs = await buildSavedTabs(candidates, settings);

  const willUseLlm = settings.llmEnabled && settings.apiKey;
  emitProgress({ step: "grouping", tabCount: tabs.length, llm: Boolean(willUseLlm) });
  const { categories, meta } = await categorizeTabs(tabs, settings);

  emitProgress({ step: "saving" });
  const session = {
    id: createId("session"),
    categories,
    closeStatus: captureOptions.reviewBeforeClose ? "review" : "closed",
    closedAt: captureOptions.reviewBeforeClose ? "" : nowIso(),
    createdAt: nowIso(),
    pendingTabIds: captureOptions.reviewBeforeClose ? candidates.map((tab) => tab.id).filter(Number.isFinite) : [],
    scope: captureOptions.scope,
    skipped,
    tabs,
    title: createSessionTitle(candidates),
    updatedAt: nowIso(),
    categorization: meta
  };

  await addSession(session);
  notifySessionReady(session, meta);
  emitProgress({
    step: "done",
    sessionId: session.id,
    tabCount: tabs.length,
    groupCount: (categories || []).filter((c) => (c.tabIds || []).length >= 2).length,
    looseCount: (categories || []).filter((c) => (c.tabIds || []).length === 1).length,
    llm: Boolean(meta?.method?.includes("llm"))
  });

  if (options.openManager !== false) {
    await openManager(session.id);
  }

  if (!captureOptions.reviewBeforeClose) {
    await closeTabIds(candidates.map((tab) => tab.id));
  }

  return { session };
}

async function getCandidateTabs(options) {
  const query = options.scope === "allWindows" ? {} : { currentWindow: true };
  const tabs = await queryTabs(query);
  const skipped = [];
  const candidates = [];

  for (const tab of tabs) {
    const reason = getSkipReason(tab, options.includePinned);
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

function getSkipReason(tab, includePinned) {
  if (!tab?.id || !tab.url) return "missing-url";
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
  const result = await executeScript({
    target: { tabId },
    func: collectPageSummary,
    args: [Number(maxChars || 720)]
  });
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
    model: "gpt-5-mini",
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
  const url = chrome.runtime.getURL(`manager.html${sessionId ? `#${encodeURIComponent(sessionId)}` : ""}`);
  await createTab({ url, active: true });
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
    ? "Grouped with gpt-5-mini. Click to open the manager."
    : "Grouped locally. Click to open the manager.";

  try {
    chrome.notifications.create(`${NOTIFICATION_PREFIX}${session.id}`, {
      type: "basic",
      iconUrl: chrome.runtime.getURL("assets/icon-128.png"),
      title: `Neat Freak — ${summary}`,
      message,
      priority: 1,
      requireInteraction: false
    });
  } catch {
    // Notification creation can fail if the OS denied the permission. Don't break the save.
  }
}

if (chrome.notifications?.onClicked) {
  chrome.notifications.onClicked.addListener((notificationId) => {
    if (!notificationId.startsWith(NOTIFICATION_PREFIX)) return;
    const sessionId = notificationId.slice(NOTIFICATION_PREFIX.length);
    openManager(sessionId).catch(() => undefined);
    chrome.notifications.clear(notificationId);
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
