import { categorizeTabs, testLlm } from "./categorizer.js";
import { heuristicSignals, runSmartScope } from "./smart-scope.js";
import { createRecommendationService } from "./recommendations.js";
import { createRecommendationBudget } from "./recommendation-budget.js";
import { aiPickFields, trimPlan } from "./tidy-plan.js";
import {
  readCycle, nextNudgeStep, startRun, finishRun, markShown, markClosedByUser, markEngaged,
  endCycle, needsIntentRun, OVER_GOAL_BANDS
} from "./nudge-cycle.js";
import { closeValidatedTabs } from "./safe-close.js";
import { createDiagnostics, diagnosticError, diagnosticDetails, DIAGNOSTICS_KEY } from "./diagnostics.js";
import { createBehaviorLog } from "./behavior-log.js";
import {
  addSession,
  deleteSession,
  enforceRetention,
  getSessions,
  getSettings,
  saveSessions,
  saveSettings,
  updateSession
} from "./storage.js";
import { createId, formatRelativeActive, getDomain, isSavableUrl, nowIso, truncateText } from "./utils.js";

const diagnostics = createDiagnostics({
  read: async () => (await chrome.storage.local.get(DIAGNOSTICS_KEY))[DIAGNOSTICS_KEY],
  write: entries => chrome.storage.local.set({ [DIAGNOSTICS_KEY]: entries }),
  enabled: async () => (await getSettings()).diagnosticsEnabled !== false
});
// Opt-in local tab-habit log (domains and timings only; separate from diagnostics).
const behaviorLog = createBehaviorLog({ storage: chrome.storage.local, queryTabs,
  enabled: async () => (await getSettings()).behaviorLogEnabled === true });
behaviorLog.attach(chrome);

async function routeWithDiagnostics(message) {
  const startedAt = Date.now();
  try {
    const result = await routeMessage(message);
    await diagnostics.record("action", { action: message?.type, ok: true, durationMs: Date.now() - startedAt });
    return result;
  } catch (error) {
    await diagnostics.record("action", { action: message?.type, ok: false, ...diagnosticDetails(error), durationMs: Date.now() - startedAt });
    throw error;
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  routeWithDiagnostics(message)
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

// Settings that only shape a manual "Tidy my tabs" run. Saving them leaves a
// prepared offer in place (see SAVE_SETTINGS).
const MANUAL_TIDY_SETTINGS = new Set(["defaultScope", "defaultIncludePinned", "defaultKeepCurrentTab", "defaultReviewBeforeClose"]);

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
  if (saveInFlight && ["DELETE_SESSION", "DELETE_TAB", "DELETE_GROUP", "IMPORT_SESSIONS", "RECATEGORIZE_SESSION", "PANEL_DISCARD_REVIEW"].includes(message?.type)) {
    throw new Error("A tidy is in progress. Wait for it to finish before editing saved sessions.");
  }
  if (NUDGE_ENGAGEMENT_MESSAGES.has(message?.type)) await noteNudgeEngagement();
  switch (message?.type) {
    case "GET_POPUP_STATE":
      return getPopupState();
    case "PREPARE_RECOMMENDATION":
      return prepareRecommendationOnOpen();
    case "PREVIEW_TABS":
      return { preview: await previewTabs(message.options || {}) };
    case "GET_SESSIONS":
      return { sessions: await getSessions() };
    case "GET_SETTINGS":
      return { settings: await getSettings() };
    case "EXPORT_DIAGNOSTICS": {
      const settings = await getSettings();
      return { diagnostics: {
        ...await diagnostics.exportLog(),
        extensionVersion: chrome.runtime.getManifest?.().version || "unknown",
        settings: { prepareSuggestions: settings.prepareSuggestions === true, llmEnabled: settings.llmEnabled === true,
          collectPageSummaries: settings.collectPageSummaries === true, showClutterNudges: settings.showClutterNudges !== false }
      } };
    }
    case "CLEAR_DIAGNOSTICS":
      await diagnostics.clear();
      return {};
    case "EXPORT_BEHAVIOR_LOG":
      return { behaviorLog: await behaviorLog.exportLog() };
    case "CLEAR_BEHAVIOR_LOG":
      await behaviorLog.clear();
      return {};
    case "BEGIN_TAB_LABELS":
      return { frozenAt: await behaviorLog.beginLabels({ offer: () => recommendations.get() }) };
    case "SAVE_TAB_LABELS":
      return { saved: await behaviorLog.saveLabels(message.labels, { frozenAt: message.frozenAt, signals: heuristicSignals,
        capture: async tabs => buildSavedTabs(tabs, await getSettings()), offer: await recommendations.get().catch(() => null) }) };
    case "SAVE_SETTINGS": {
      const changes = message.settings || {};
      const settings = await saveSettings(changes);
      // The panel's scope switch and manual-tidy options don't feed the
      // prepared offer, so flipping them leaves it standing.
      if (!Object.keys(changes).every(key => MANUAL_TIDY_SETTINGS.has(key))) await recommendations.invalidate();
      scheduleClutterCheck();
      return { settings };
    }
    case "SAVE_TABS":
      return runExclusiveSave(() => saveTabs(message.options || {}));
    case "CLOSE_SAVED_TABS":
      return runExclusiveSave(() => closeSavedTabs(message.sessionId));
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
      return runExclusiveSave(handlePanelTidyNow);
    case "SET_RECOMMENDATION_KEEP":
      return persistRecommendationReview(message);
    case "GET_RECOMMENDATION":
      return { recommendation: await getRecommendationForUi() };
    case "REFRESH_RECOMMENDATION":
      return refreshRecommendationForUi(message);
    case "REVIEW_RECOMMENDATION":
      return reviewRecommendation(message.planId);
    case "EXECUTE_RECOMMENDATION":
      return runExclusiveSave(() => executeRecommendation(message));
    case "DONE_TOAST_OPEN":          // legacy alias
    case "PANEL_OPEN_MANAGER":
      await openManager(message.sessionId || "");
      await setPanelState({ mode: "hidden" });
      return {};
    case "PANEL_DISMISS":
      recommendationUiRevision += 1;
      await reviewUpdateQueue;
      {
        const state = await readPanelState();
        if (state.recommendation && state.keepOpenSessionTabIds?.length) {
          await recommendations.exclude(state.planId, state.keepOpenSessionTabIds).catch(() => undefined);
        }
        // The user closing a nudge card skips its reminder; the card's own
        // 10-second auto-hide (message.auto) does not.
        if (!message.auto && state.mode === "clutter") {
          await updateNudgeCycle(cycle => ({ cycle: markClosedByUser(cycle) })).catch(() => undefined);
        }
      }
      await setPanelState({ mode: "hidden" });
      return {};
    case "PANEL_DISMISS_SAVING":
      // User closed the loader mid-save. Remember it so progress steps stop
      // re-showing it; the save keeps running and the done result still
      // surfaces when finished.
      try { await chrome.storage.session?.set?.({ [SAVE_LOADER_DISMISSED_KEY]: true }); } catch { /* tolerate */ }
      await setPanelState({ mode: "hidden" });
      return {};
    case "PANEL_CONFIRM_REVIEW":
      return runExclusiveSave(() => confirmPanelReview(message.sessionId, message.keepOpenSessionTabIds || []));
    case "PANEL_DISCARD_REVIEW":
      return discardPanelReview(message.sessionId);
    case "OPEN_PANEL_FROM_ICON":
      return openPanelFromIcon();
    default:
      throw new Error("Unknown Neat Freak message.");
  }
}

// Popup-shim entry point. Called from popup.js when the user clicks the
// toolbar icon. Acts as a toggle: if the panel is already visible, dismiss
// it; otherwise open it in idle (user-initiated, expanded) mode. On chrome://
// pages where injection fails, popup.js falls back to rendering the existing
// popup UI inline.
async function openPanelFromIcon() {
  const activeTabs = await queryTabs({ active: true, lastFocusedWindow: true });
  const target = activeTabs[0];
  if (!target?.id || !isInjectablePageUrl(target.url)) {
    return { injected: false };
  }
  // Toggle: if the panel is currently in a user-relevant non-hidden state,
  // close it. Saving is mid-flow so we don't yank it — treat as "leave alone."
  const stored = await new Promise((resolve) => {
    try {
      chrome.storage.session.get("neatFreakPanelState", (r) => resolve(r || {}));
    } catch { resolve({}); }
  });
  const currentMode = stored?.neatFreakPanelState?.mode || "hidden";
  if (currentMode === "review" || currentMode === "saving") {
    return { injected: await ensurePanelMounted() };
  }
  if (currentMode !== "hidden" && currentMode !== "saving") {
    await setPanelState({ mode: "hidden" });
    return { injected: true, closed: true };
  }
  await setPanelState({ mode: "idle" });
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
  // totalTabCount is what drives the mascot mood — preview.count is scoped
  // (e.g. "Smart" might pick 7 of 50), so it can't tell us if the user is
  // overall over their clutter budget.
  let totalTabCount = 0;
  try {
    const allTabs = await queryTabs({});
    totalTabCount = allTabs.length;
  } catch { /* best-effort */ }
  const plan = await recommendations.get();
  const recommendationNeedsRun = needsIntentRun({
    aiOn: aiPreparesSuggestions(settings), plan, now: Date.now(), cycle: await readNudgeCycle()
  });
  return { preview, sessions: sessions.slice(0, 3), settings, totalTabCount, recommendation: recommendationSummary(plan), recommendationNeedsRun };
}

// Background page inspection is opt-in (prepareSuggestions); opening the panel
// only starts an AI run for users who opted in and have AI on.
function aiPreparesSuggestions(settings) {
  return Boolean(settings.prepareSuggestions && settings.llmEnabled && settings.tokenServiceUrl);
}

// Opening the panel with no list, or a list older than 30 minutes, starts a
// run then. It is user-initiated, so it does not use the automatic AI budget.
async function prepareRecommendationOnOpen() {
  const settings = await getSettings();
  const current = await recommendations.get();
  if (saveInFlight || !needsIntentRun({ aiOn: aiPreparesSuggestions(settings), plan: current, now: Date.now(), cycle: await readNudgeCycle() })) {
    return { recommendation: recommendationSummary(current) };
  }
  const revision = recommendationUiRevision;
  const plan = await recommendations.refresh({ force: true });
  if (revision !== recommendationUiRevision || saveInFlight) return { superseded: true };
  return { recommendation: recommendationSummary(plan) };
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

  // Mirror progress into the floating panel's saving state. Skipped if the
  // popup is open (it handles its own progress UI) or if the user dismissed
  // the loader for this save (so it doesn't pop back on the next step).
  if (!isPopupOpen() && payload?.step && payload.step !== "done") {
    const label = progressLabelFor(payload);
    isSaveLoaderDismissed().then(async (dismissed) => {
      if (dismissed || !saveInFlight) return;
      const state = await readPanelState();
      if (["review", "done"].includes(state.mode)) return;
      setPanelState({ mode: "saving", label }).catch(() => undefined);
    });
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

// Short-lived enclave credential, cached in session storage (cleared on browser
// restart). The token service mints a capped key per install per day; we cache
// it so we don't re-mint on every action.
const ENCLAVE_CRED_KEY = "neatFreakEnclaveCred";

async function getEnclaveCredential(settings) {
  if (!settings.tokenServiceUrl) return null;
  try {
    const cached = (await chrome.storage.session.get(ENCLAVE_CRED_KEY))?.[ENCLAVE_CRED_KEY];
    if (cached?.key && cached?.baseUrl && cached.expiresAt > Date.now() + 60_000) return cached;
  } catch { /* session storage unavailable; mint fresh */ }

  const res = await fetch(settings.tokenServiceUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Install-Id": settings.installId || "" },
    body: "{}",
    signal: AbortSignal.timeout(10_000)
  });
  if (!res.ok) throw new Error(`Token service ${res.status}`);
  const data = await res.json();
  if (!data.key || !data.baseUrl) throw new Error("Token service returned no key.");
  const cred = {
    key: data.key,
    baseUrl: data.baseUrl,
    model: data.model || settings.llmModel,
    expiresAt: Number(data.expiresAt) || (Date.now() + 3_600_000)
  };
  try { await chrome.storage.session.set({ [ENCLAVE_CRED_KEY]: cred }); } catch { /* tolerate */ }
  return cred;
}

// Return a settings object carrying a live enclave credential (backendUrl +
// enclaveKey) for the LLM call sites. On any failure it returns settings
// unchanged, so callers transparently fall back to the local heuristic. Only the
// install id is sent to the token service — never tab content.
async function resolveLlmSettings(settings) {
  if (!settings.llmEnabled || !settings.tokenServiceUrl) return settings;
  try {
    const cred = await getEnclaveCredential(settings);
    if (!cred) return settings;
    return { ...settings, backendUrl: cred.baseUrl, enclaveKey: cred.key, llmModel: cred.model || settings.llmModel };
  } catch (error) {
    await diagnostics.record("background_error", diagnosticDetails(error));
    return settings;
  }
}

async function saveTabs(options) {
  await recommendations.invalidate();
  // New save → clear any leftover "loader dismissed" flag so this save's
  // progress panel shows fresh (the user can dismiss it again if they want).
  try { await chrome.storage.session?.remove?.(SAVE_LOADER_DISMISSED_KEY); } catch { /* tolerate */ }

  const settings = await resolveLlmSettings(await getSettings());
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

  emitProgress({ step: "scanning", tabCount: candidates.length });
  emitProgress({ step: "capturing", tabCount: candidates.length });
  const tabs = await buildSavedTabs(candidates, settings);

  const willUseLlm = settings.llmEnabled && settings.backendUrl;
  emitProgress({ step: "grouping", tabCount: tabs.length, llm: Boolean(willUseLlm) });

  let categories;
  let meta;
  let smartResult = null;
  let tabsToClose;

  if (captureOptions.scope === "smart") {
    // Floor: Smart must save enough to leave the user strictly under their
    // clutter threshold. Pinned/chrome:// tabs that Smart can't touch still
    // count against the limit, so we compute against the global tab count.
    const allOpenTabs = await queryTabs({});
    const threshold = Number(settings.clutterThreshold) || 0;
    const minSaveCount = threshold > 0
      ? Math.max(0, allOpenTabs.length - (threshold - 1))
      : 0;
    smartResult = await runSmartScope(tabs, settings, {
      minSaveCount,
      totalOpenTabCount: allOpenTabs.length,
      clutterThreshold: threshold
    });
    // Opt-in tab habits log: what this tidy put away and what the AI picked.
    behaviorLog.offerSnapshot(tabs, { mode: smartResult.mode, tabs: smartResult.saveSet, ...aiPickFields(smartResult, tabs) },
      { manual: true, live: allOpenTabs, signals: heuristicSignals }).catch(() => {});
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

  const tabIdsToClose = tabsToClose
    .map((tab) => tab.originalTabId || tab.id)
    .filter(Number.isFinite);

  // Only auto-open the Manager if closing the final chosen tabs would leave
  // Chrome with no surviving tabs. For Smart, this must happen after the save
  // set is known; otherwise the Manager tab itself can inflate the tab-limit
  // floor and cause one extra tab to close.
  if (!captureOptions.reviewBeforeClose && options.openManager !== false) {
    const survivors = await countSurvivingTabIds(tabIdsToClose);
    if (survivors === 0) {
      await openManager();
    }
  }

  emitProgress({ step: "saving" });
  const session = {
    id: createId("session"),
    browserSessionId: await getBrowserSessionId(),
    categories,
    closeStatus: captureOptions.reviewBeforeClose ? "review" : "closing",
    closedAt: "",
    createdAt: nowIso(),
    pendingTabIds: tabIdsToClose,
    scope: captureOptions.scope,
    includePinned: captureOptions.includePinned,
    keepCurrentTab: captureOptions.keepCurrentTab,
    skipped,
    tabs: smartResult ? tabsToClose : tabs,
    title: createSessionTitle(smartResult ? tabsToClose : candidates),
    updatedAt: nowIso(),
    categorization: meta
  };

  await addSession(session);
  await pruneSavedSessions();
  if (captureOptions.reviewBeforeClose) notifySessionReady(session, meta);
  // Both surfaces read the same state; review never closes browser tabs.
  if (captureOptions.reviewBeforeClose) {
    await showPanelReview(session);
  }
  const folderSummaries = (categories || [])
    .filter((c) => (c.tabIds || []).length >= 2)
    .map((c) => ({ id: c.id, name: c.name, count: c.tabIds.length }));
  if (captureOptions.reviewBeforeClose) emitProgress({
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
    return finishSessionClose(session, session.tabs);
  }

  return { session };
}

// Enforce the saved-session retention policy (count limit + byte backstop).
// Runs after each save and on the periodic alarm. Best-effort — never let a
// pruning hiccup break the save flow.
async function pruneSavedSessions() {
  try {
    const settings = await getSettings();
    const sessions = await getSessions();
    const kept = enforceRetention(sessions, settings);
    if (kept.length !== sessions.length) {
      await saveSessions(kept);
    }
  } catch (err) {
    console.warn("[Neat Freak] Session retention prune failed:", err?.message || err);
  }
}

async function countSurvivingTabIds(tabIds) {
  const all = await queryTabs({});
  const closingIds = new Set(tabIds.filter(Number.isFinite));
  return all.filter((tab) => !closingIds.has(tab.id)).length;
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
  if (tab.incognito) return "incognito";
  if (keepCurrentTab && tab.active) return "current-tab";
  if (tab.pinned && !includePinned) return "pinned";
  if (!isSavableUrl(tab.url)) return "unsupported-url";
  return "";
}

async function buildSavedTabs(tabs, settings, { signalTimeoutMs } = {}) {
  return mapLimit(tabs, 8, async (tab) => {
    const domain = getDomain(tab.url);
    const signals = !tab.discarded && tab.url?.startsWith("http")
      ? await getPageSignals(tab.id, settings.collectPageSummaries ? settings.maxSnippetChars : 0, signalTimeoutMs).catch(() => ({ summary: "", signalsUnavailable: !tab.discarded }))
      : { summary: "", hasUnsavedInput: false };

    return {
      id: createId("tab"),
      active: Boolean(tab.active),
      audible: Boolean(tab.audible),
      domain,
      favIconUrl: tab.favIconUrl || "",
      // True when the user has typed into a form/draft on the page that isn't
      // submitted. Smart scope treats this as a hard keep — closing the tab would
      // lose that work for good (restore only reopens the URL).
      hasUnsavedInput: Boolean(signals.hasUnsavedInput),
      signalsUnavailable: Boolean(signals.signalsUnavailable),
      index: Number.isFinite(tab.index) ? tab.index : 0,
      // lastAccessed is the only signal Smart scope has for "is this tab actually in use?".
      // Without it, every tab looks brand-new (null), and the LLM can't tell stale from fresh —
      // which is exactly what caused recently-opened tabs to get closed.
      lastAccessed: Number.isFinite(tab.lastAccessed) ? tab.lastAccessed : undefined,
      originalTabId: tab.id,
      pageSummary: signals.summary,
      pinned: Boolean(tab.pinned),
      title: tab.title || domain || tab.url,
      url: tab.url,
      windowId: tab.windowId
    };
  });
}

// Suggestion runs wait about 1 second per tab; a tab that does not answer is
// left off the list (signalsUnavailable). Saves and the check right before
// closing keep the 4-second wait.
const SUGGESTION_SIGNAL_TIMEOUT_MS = 1000;

async function getPageSignals(tabId, maxChars, timeoutMs = 4000) {
  // Cap per-tab extraction. If a tab is unresponsive (restricted page,
  // suspended, slow-loading), we'd rather skip its signals than hang the flow.
  const scriptPromise = executeScript({
    target: { tabId, allFrames: true },
    func: collectPageSignals,
    args: [Number(maxChars ?? 720)]
  });
  let timer;
  let result;
  try {
    result = await Promise.race([
      scriptPromise,
      new Promise(resolve => { timer = setTimeout(() => resolve(null), timeoutMs); })
    ]);
  } finally { clearTimeout(timer); }
  const signals = result?.find?.(item => item.frameId === 0)?.result;
  return {
    summary: signals?.summary || "", url: signals?.url || "",
    hasUnsavedInput: Boolean(result?.some?.(item => item.result?.hasUnsavedInput)),
    signalsUnavailable: !signals || Boolean(result?.some?.(item => !item.result || item.result.signalsUnavailable))
  };
}

function collectPageSignals(maxChars) {
  const outsideEditor = element => !element.closest('[contenteditable], [role="textbox"]');
  const readMeta = (name) => document.querySelector(`meta[name="${name}"], meta[property="${name}"]`)?.getAttribute("content") || "";
  const title = document.title || "";
  const description = maxChars > 0 ? readMeta("description") || readMeta("og:description") || readMeta("twitter:description") : "";
  const heading = maxChars > 0 ? document.querySelector("h1") : null;
  const h1 = heading && outsideEditor(heading) ? heading.innerText || "" : "";
  const headings = [...(maxChars > 0 ? document.querySelectorAll("h2, h3") : [])]
    .filter(outsideEditor)
    .slice(0, 6)
    .map((element) => element.innerText)
    .filter(Boolean)
    .join(" | ");
  const paragraphs = [...(maxChars > 0 ? document.querySelectorAll("article p, main p, p") : [])]
    .filter(outsideEditor)
    .slice(0, 8)
    .map((element) => element.innerText)
    .filter((text) => text && text.length > 32)
    .join(" ");
  const summary = maxChars > 0 ? [title, description, h1, headings, paragraphs]
    .filter(Boolean)
    .join(" -- ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxChars) : "";

  // In-progress form input: a visible, editable input/textarea whose value the
  // user changed from its server-rendered default. Closing such a tab would lose
  // typed-but-unsubmitted work (restore only reopens the URL), so Smart scope
  // treats it as a hard keep. Privacy: only the boolean leaves the page — never
  // field contents, and password fields are skipped before their value is read.
  let hasUnsavedInput = false;
  let signalsUnavailable = false;
  try {
    const SKIP_INPUT_TYPES = new Set([
      "password", "hidden", "submit", "button", "reset",
      "image", "range", "color"
    ]);
    const roots = [document];
    for (let i = 0; i < roots.length; i++) {
      for (const el of roots[i].querySelectorAll("*")) {
        if (el.shadowRoot) roots.push(el.shadowRoot);
      }
    }
    for (const el of roots.flatMap(root => [...root.querySelectorAll("input, textarea, select")])) {
      if (el.disabled || el.readOnly) continue;
      const type = (el.getAttribute("type") || el.type || "text").toLowerCase();
      if (el.tagName === "INPUT" && SKIP_INPUT_TYPES.has(type)) continue;
      if (el.offsetParent === null && el.getClientRects().length === 0) continue; // not visible
      if (type === "checkbox" || type === "radio") {
        hasUnsavedInput = el.checked !== el.defaultChecked;
      } else if (type === "file") {
        hasUnsavedInput = Boolean(el.files?.length);
      } else if (el.tagName === "SELECT") {
        const options = [...el.options];
        const defaults = options.map(option => option.defaultSelected);
        if (!el.multiple) {
          const explicit = defaults.lastIndexOf(true);
          const index = explicit >= 0 ? explicit : el.size > 1 ? -1 : options.findIndex(option => !option.disabled && !option.closest("optgroup")?.disabled);
          defaults.fill(false);
          if (index >= 0) defaults[index] = true;
        }
        hasUnsavedInput = options.some((option, index) => option.selected !== defaults[index]);
      } else {
        // Clearing populated text is also an unsaved edit.
        const value = typeof el.value === "string" ? el.value : "";
        hasUnsavedInput = value !== el.defaultValue;
      }
      if (hasUnsavedInput) break;
    }
    // Rich editors have no original value. Conservatively protect visible
    // non-empty editors, including plaintext-only and open shadow DOM editors.
    if (!hasUnsavedInput) {
      hasUnsavedInput = roots.some(root => [...root.querySelectorAll('[contenteditable]:not([contenteditable="false"]), [role="textbox"]')]
        .some(el => el.getClientRects().length && (el.textContent || "").trim().length > 0));
    }
  } catch {
    signalsUnavailable = true;
  }
  return { summary, hasUnsavedInput, signalsUnavailable, url: location.href };
}

async function closeSavedTabs(sessionId) {
  const session = (await getSessions()).find((item) => item.id === sessionId);
  if (!session) throw new Error("Session not found.");
  const pending = new Set(session.pendingTabIds || []);
  return finishSessionClose(session, session.tabs.filter(tab => pending.has(tab.originalTabId)));

}

async function restorableUrls(session, tabs) {
  if (session.browserSessionId !== await getBrowserSessionId() || !session.pendingTabIds?.length) {
    behaviorLog.restored(tabs);
    return tabs.map(tab => tab.url);
  }
  const live = new Map((await queryTabs({})).map(tab => [tab.id, tab]));
  const restorable = tabs.filter(tab => live.get(tab.originalTabId)?.url !== tab.url);
  behaviorLog.restored(restorable);
  return restorable.map(tab => tab.url);
}

async function restoreTabsByIds(sessionId, tabIds) {
  const session = (await getSessions()).find((item) => item.id === sessionId);
  if (!session) throw new Error("Session not found.");
  const wanted = new Set(tabIds);
  const tabs = session.tabs.filter((tab) => wanted.has(tab.id));
  await restoreUrls(await restorableUrls(session, tabs));
  return {};
}

async function restoreGroup(sessionId, categoryId) {
  const session = (await getSessions()).find((item) => item.id === sessionId);
  if (!session) throw new Error("Session not found.");
  const category = session.categories.find((item) => item.id === categoryId);
  if (!category) throw new Error("Group not found.");
  const wanted = new Set(category.tabIds);
  await restoreUrls(await restorableUrls(session, session.tabs.filter((tab) => wanted.has(tab.id))));
  return {};
}

async function restoreSession(sessionId) {
  const session = (await getSessions()).find((item) => item.id === sessionId);
  if (!session) throw new Error("Session not found.");
  await restoreUrls(await restorableUrls(session, session.tabs));
  return {};
}

async function restoreAllSessions() {
  const sessions = await getSessions();
  const urls = (await Promise.all(sessions.map(session => restorableUrls(session, session.tabs || [])))).flat();
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
  const settings = await resolveLlmSettings(await getSettings());
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
  const base = { ...(await getSettings()), ...(settingsOverride || {}) };
  if (!base.tokenServiceUrl) throw new Error("No AI backend is configured.");
  const settings = await resolveLlmSettings(base);
  if (!settings.backendUrl) throw new Error("Couldn't reach the AI backend.");
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

  const base = await getSettings();
  if (!base.tokenServiceUrl) {
    return { results: localRanked.slice(0, 30), mode: "local", error: "Smart search is unavailable right now." };
  }
  const settings = await resolveLlmSettings(base);
  if (!settings.backendUrl) {
    return { results: localRanked.slice(0, 30), mode: "local", error: "Smart search is unavailable right now." };
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
  const payload = candidates.map((tab) => ({
    tabId: tab.tabId,
    title: truncateText(tab.title, 160),
    url: truncateText(tab.url, 180),
    domain: tab.domain,
    folder: tab.folderName,
    summary: truncateText(tab.pageSummary, 320)
  }));

  const body = {
    model: settings.llmModel || "gpt-oss-120b",
    reasoning_effort: "low",
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
  let restoredCount = 0;
  try {
    for (const [index, url] of uniqueUrls.entries()) {
      await createTab({ url, active: index === 0 });
      restoredCount += 1;
    }
  } finally {
    await diagnostics.record("restore_finished", { restoredCount, failedCount: uniqueUrls.length - restoredCount });
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
      title: session.closeStatus === "review" ? `Neat Freak — ${tabCount} tabs ready to review` : `Neat Freak — ${summary}`,
      message: session.closeStatus === "review" ? "Review your saved tabs before closing them." : message,
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
// Session flag: set when the user dismisses the panel DURING a save (× / swipe
// / Close). While set, emitProgress stops re-injecting the "saving" panel so a
// dismissed loader doesn't pop back on the next progress step. Cleared at the
// start of each save. The "done" result still surfaces regardless — it's the
// payoff the user is waiting for, and it finds them on their active tab.
const SAVE_LOADER_DISMISSED_KEY = "neatFreakSaveLoaderDismissed";

function isSaveLoaderDismissed() {
  return new Promise((resolve) => {
    try {
      chrome.storage.session.get(SAVE_LOADER_DISMISSED_KEY, (r) =>
        resolve(Boolean(r && r[SAVE_LOADER_DISMISSED_KEY])));
    } catch { resolve(false); }
  });
}

async function setPanelState(state, { requireWrite = false } = {}) {
  try {
    await chrome.storage.session?.set?.({ [PANEL_STATE_KEY]: state });
  } catch (err) {
    console.warn("[Neat Freak] Panel state write failed:", err?.message || err);
    if (requireWrite) throw new Error("Couldn't open the tab preview. Try again.");
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
  const categories = session.categories || [];
  const groupCount = categories.filter((c) => (c.tabIds || []).length >= 2).length;
  const looseCount = categories.filter((c) => (c.tabIds || []).length === 1).length;
  const tabCount = (session.tabs || []).length;
  const keepCount = smartResult ? (smartResult.keepSet?.length || 0) : 0;
  const settings = await getSettings();

  return setPanelState({
    mode: "done",
    tabCount,
    groupCount,
    looseCount,
    keepCount,
    sessionId: session.id,
    llm: Boolean(meta?.method?.includes("llm")),
    // Drives the inconspicuous "Tidy automatically next time" toggle on the
    // done card: shown only when the LLM is on; its checked state reflects the
    // current review-before-close setting (automatic = review off).
    llmOn: Boolean(settings.llmEnabled && settings.tokenServiceUrl),
    reviewBeforeClose: Boolean(settings.defaultReviewBeforeClose)
  });
}

// Review-before-closing path: tabs are saved but NOT yet closed. Panel shows
// the categorized list with per-item remove buttons + Cancel/Confirm. Confirm
// hits confirmPanelReview below to actually close. Cancel deletes the session.
async function showPanelReview(session) {
  const tabsById = new Map((session.tabs || []).map((t) => [t.id, t]));
  // Single reference instant so every row's "last active" label is relative to
  // the same moment. Review is shown immediately after save and is short-lived,
  // so a label computed here (not live-ticking in the panel) stays accurate.
  const now = Date.now();
  const groups = (session.categories || [])
    .map((cat) => ({
      name: cat.name || "Other",
      tabs: (cat.tabIds || [])
        .map((id) => tabsById.get(id))
        .filter(Boolean)
        .map((tab) => ({
          sessionTabId: tab.id,
          title: tab.title || "",
          domain: tab.domain || getDomain(tab.url || ""),
          url: tab.url || "",
          lastActive: formatRelativeActive(tab.lastAccessed, now)
        }))
    }))
    .filter((g) => g.tabs.length > 0);

  return setPanelState({
    mode: "review",
    sessionId: session.id,
    groups
  });
}

// User confirmed the review. keepOpenSessionTabIds are the session tab IDs
// the user struck through ("don't close these"). Close everything else in
// pendingTabIds, drop the kept tabs from the session, mark closed, then
// transition the panel into the standard done celebration.
async function confirmPanelReview(sessionId, keepOpenSessionTabIds) {
  const session = (await getSessions()).find((item) => item.id === sessionId);
  if (!session) {
    await setPanelState({ mode: "hidden" });
    return { ok: true };
  }

  const keepSet = new Set(keepOpenSessionTabIds || []);
  const selected = session.tabs.filter(tab => !keepSet.has(tab.id));
  behaviorLog.kept(session.tabs.filter(tab => keepSet.has(tab.id)));
  return finishSessionClose(session, selected);

}

// User cancelled the review. The session was created moments ago and the
// tabs are still open in the browser — safe to discard outright.
async function discardPanelReview(sessionId) {
  if (sessionId) {
    try { await deleteSession(sessionId); } catch { /* best-effort */ }
  }
  await setPanelState({ mode: "hidden" });
  return { ok: true };
}

// Tidy now (from the panel's clutter state) — transition through saving and
// done in place rather than dismissing the panel and re-showing a new toast.
async function handlePanelTidyNow() {
  // Skip the loading state entirely when there's nothing to tidy. Going
  // through "saving" just to error out feels worse than a quick "all clean"
  // acknowledgment.
  const settings = await getSettings();
  const { candidates } = await getCandidateTabs({
    scope: "smart",
    includePinned: Boolean(settings.defaultIncludePinned),
    keepCurrentTab: settings.defaultKeepCurrentTab !== false
  });
  if (!candidates.length) {
    await setPanelState({ mode: "done", tabCount: 0 });
    return {};
  }
  await setPanelState({ mode: "saving", label: "Tidying your tabs" });
  try {
    await saveTabs({ scope: "smart" });
  } catch (err) {
    console.warn("[Neat Freak] Tidy-from-panel save failed:", err?.message || err);
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

// ===== Prepared recommendations =====
const RECOMMENDATION_KEY = "neatFreakRecommendation";
let saveInFlight = null;
let recommendationUiRevision = 0;
let reviewUpdateQueue = Promise.resolve();
const recommendationBudget = createRecommendationBudget({
  read: async () => (await chrome.storage.local.get("neatFreakAutomaticAiBudget")).neatFreakAutomaticAiBudget,
  write: value => chrome.storage.local.set({ neatFreakAutomaticAiBudget: value })
});
const recommendations = createRecommendationService({
  read: async () => (await chrome.storage.session.get(RECOMMENDATION_KEY))[RECOMMENDATION_KEY],
  write: value => chrome.storage.session.set({ [RECOMMENDATION_KEY]: value }),
  settings: getSettings,
  queryTabs: async () => (await queryTabs({})).filter(tab => !tab.incognito),
  capture: (tabs, settings) => buildSavedTabs(tabs, settings, { signalTimeoutMs: SUGGESTION_SIGNAL_TIMEOUT_MS }),
  select: selectRecommendation,
  automaticAiAvailable: () => recommendationBudget.available().catch(() => false),
  record: diagnostics.record,
  prepared: ({ tabs, plan, automatic, live }) => behaviorLog.offerSnapshot(tabs, plan, { automatic, live, signals: heuristicSignals }),
  createId: () => createId("plan")
});

async function selectRecommendation(tabs, settings, { automatic } = {}) {
  let localReason = settings.llmEnabled ? "ai-unavailable" : "ai-off";
  let resolved = settings;
  if (tabs.length && settings.llmEnabled) {
    if (automatic && !await recommendationBudget.reserve().catch(() => false)) {
      resolved = { ...settings, llmEnabled: false };
      localReason = "background-limit";
    } else resolved = await resolveLlmSettings(settings);
  }
  const result = await runSmartScope(tabs, resolved, { proactive: true });
  return { ...result, localReason, errorCode: result.error ? diagnosticError(result.error) : undefined };
}

async function runExclusiveSave(operation) {
  if (saveInFlight) throw new Error("A tidy is already in progress.");
  recommendationUiRevision += 1;
  saveInFlight = operation();
  try { return await saveInFlight; }
  catch (error) {
    const state = await readPanelState();
    if (state.mode === "saving") await setPanelState({ mode: "idle", error: error.message });
    throw error;
  }
  finally { saveInFlight = null; }
}

function persistRecommendationReview(message) {
  const update = reviewUpdateQueue.then(async () => {
    const state = await readPanelState();
    if (!saveInFlight && state.recommendation && state.planId === message.planId) {
      await chrome.storage.session.set({ [PANEL_STATE_KEY]: { ...state, keepOpenSessionTabIds: message.keepOpenSessionTabIds || [] } });
      await diagnostics.record("keep_changed", {
        run: state.planId.replace(/^plan-/, "run_"),
        suggestedCount: state.saveCount, keptCount: new Set(message.keepOpenSessionTabIds || []).size
      });
    }
    return {};
  });
  reviewUpdateQueue = update.catch(() => undefined);
  return update;
}

async function readPanelState() {
  return (await chrome.storage.session.get(PANEL_STATE_KEY))[PANEL_STATE_KEY] || { mode: "hidden" };
}

function recommendationGroups(plan) {
  const byId = new Map(plan.tabs.map(tab => [tab.id, tab]));
  return plan.categories.map(group => ({
    name: group.name,
    tabs: group.tabIds.map(id => byId.get(id)).filter(Boolean).map(tab => ({
      sessionTabId: tab.id, title: tab.title, domain: tab.domain, url: tab.url,
      lastActive: formatRelativeActive(tab.lastAccessed, Date.now())
    }))
  })).filter(group => group.tabs.length);
}

function recommendationSummary(plan) {
  if (!plan) return null;
  return {
    planId: plan.id, saveCount: plan.tabs.length, folderCount: plan.categories.length,
    createdAt: plan.createdAt, stale: plan.stale, expired: plan.expired,
    local: plan.mode !== "llm", localReason: plan.localReason,
    reviewRequired: plan.reviewRequired, needsPreparation: false
  };
}

async function getRecommendationForUi() {
  return recommendationSummary(await recommendations.get());
}

async function refreshRecommendationForUi(message) {
  if (saveInFlight) throw new Error("A tidy is already in progress.");
  const revision = ++recommendationUiRevision;
  if (message.planId && message.keepOpenSessionTabIds?.length) {
    await recommendations.exclude(message.planId, message.keepOpenSessionTabIds);
  }
  const previousPlan = await recommendations.get();
  const plan = await recommendations.refresh({ force: true });
  if (revision !== recommendationUiRevision || saveInFlight) return { superseded: true };
  if (message.review && plan?.tabs.length && !plan.expired) await showRecommendationReview(plan);
  else if (message.review) await setPanelState({ mode: "idle" }, { requireWrite: true });
  else {
    const state = await readPanelState();
    if (state.mode === "clutter" && plan) await setPanelState({ ...state, ...recommendationSummary(plan) });
  }
  return { recommendation: recommendationSummary(plan), refreshDeferred: Boolean(previousPlan && plan?.id === previousPlan.id) };
}

async function showRecommendationReview(plan) {
  await recommendations.beginReview(plan.id);
  await diagnostics.record("review_opened", { run: plan.id.replace(/^plan-/, "run_"), suggestedCount: plan.tabs.length, mode: plan.mode, ageMs: Date.now() - plan.createdAt });
  return setPanelState({
    mode: "review", recommendation: true, ...recommendationSummary(plan),
    groups: recommendationGroups(plan)
  }, { requireWrite: true });
}

async function reviewRecommendation(planId) {
  if (saveInFlight) throw new Error("A tidy is already in progress.");
  const revision = ++recommendationUiRevision;
  recommendations.cancelRefresh();
  const plan = await recommendations.get();
  return presentCurrentRecommendation(plan, revision);
}

// A delayed Review checks the current selection. A delayed close may take this
// path too, but can only OPEN review, never close a freshly substituted set.
async function presentCurrentRecommendation(plan, revision) {
  if (!plan || plan.expired || !plan.tabs.length) plan = await recommendations.refresh({ force: true });
  if (revision !== recommendationUiRevision) return {};
  if (plan && !plan.expired && plan.tabs.length) await showRecommendationReview(plan);
  else await setPanelState({ mode: "idle" });
  return { recommendation: recommendationSummary(plan), reviewOpened: Boolean(plan && !plan.expired && plan.tabs.length) };
}

async function executeRecommendation(message) {
  let plan = await recommendations.get();
  if (!plan) {
    throw new Error("No suggestion is ready to close. Choose Find suggestions to review your tabs.");
  }
  behaviorLog.kept(plan.tabs.filter(tab => message.keepOpenSessionTabIds?.includes(tab.id)));
  if (plan.id !== message.planId || plan.expired) {
    if (plan.id === message.planId && message.keepOpenSessionTabIds?.length) {
      plan = await recommendations.exclude(plan.id, message.keepOpenSessionTabIds);
    }
    return presentCurrentRecommendation(plan, recommendationUiRevision);
  }
  if (plan.reviewRequired && !plan.reviewed) throw new Error("Review these local suggestions before closing tabs.");
  if (message.keepOpenSessionTabIds?.length) {
    plan = await recommendations.exclude(plan.id, message.keepOpenSessionTabIds);
  }
  const offered = new Set(message.offeredTabIds || plan.tabs.map(tab => tab.id));
  const tabs = plan.tabs.filter(tab => offered.has(tab.id));
  plan = trimPlan(plan, tabs);
  const requestedCount = Number(message.offeredCount) || message.offeredTabIds?.length || tabs.length;
  const changedCount = Math.max(0, requestedCount - (message.keepOpenSessionTabIds?.length || 0) - tabs.length);
  if (!tabs.length) {
    await recommendations.invalidate();
    await setPanelState({ mode: "done", tabCount: 0, protectedCount: changedCount });
    return {};
  }
  const session = {
    browserSessionId: await getBrowserSessionId(),
    id: createId("session"), title: createSessionTitle(tabs), scope: "smart",
    createdAt: nowIso(), updatedAt: nowIso(), closeStatus: "closing", closedAt: "",
    tabs, categories: plan.categories, pendingTabIds: tabs.map(tab => tab.originalTabId),
    skipped: [], categorization: { method: `smart-${plan.mode}`, saveCount: tabs.length },
    recommendationId: plan.id, changedCount
  };
  // Persist the complete offered URLs before any destructive browser API call.
  await recommendations.claim(plan.id);
  await addSession(session);
  await setPanelState({ mode: "saving", label: "Saving your tabs" });
  return finishSessionClose(session, tabs);
}

async function getBrowserSessionId() {
  const key = "neatFreakBrowserSessionId";
  const data = await chrome.storage.session.get(key);
  if (data[key]) return data[key];
  const id = createId("browser");
  await chrome.storage.session.set({ [key]: id });
  return id;
}

async function finishSessionClose(session, selectedTabs) {
  if (session.browserSessionId !== await getBrowserSessionId()) {
    throw new Error("These saved tabs belong to an earlier browser session. Restore them from the manager; start a new tidy for your current tabs.");
  }
  const pending = new Set(session.pendingTabIds || []);
  selectedTabs = selectedTabs.filter(tab => pending.has(tab.originalTabId));
  const previouslyClosed = session.tabs.filter(tab => !pending.has(tab.originalTabId));
  const selected = trimPlan(session, [...previouslyClosed, ...selectedTabs]);
  if (!selectedTabs.length) {
    if (previouslyClosed.length) {
      await updateSession(session.id, current => ({ ...trimPlan(current, previouslyClosed), closeStatus: "closed", pendingTabIds: [] }));
    } else await deleteSession(session.id);
    await setPanelState({ mode: "done", tabCount: 0 });
    return {};
  }
  // A pending journal survives worker interruption. Never auto-resume closing
  // after a restart; the manager can still restore the already saved URLs.
  const journal = await updateSession(session.id, current => ({
    ...current, ...selected, closeStatus: "closing", closedAt: "",
    pendingTabIds: selectedTabs.map(tab => tab.originalTabId)
  }));
  if (!journal) throw new Error("The saved session is unavailable. No tabs were closed.");
  const outcome = await closeValidatedTabs(selectedTabs, {
    getTab: id => new Promise(resolve => chrome.tabs.get(id, tab => {
      resolve(chrome.runtime.lastError ? null : tab);
    })),
    probe: id => getPageSignals(id, 0),
    remove: id => removeTabs([id])
  }, { protectPinned: !session.includePinned, protectActive: session.scope === "smart" || session.keepCurrentTab !== false });
  await diagnostics.record("close_finished", {
    run: (session.recommendationId || session.id).replace(/^(plan|session)-/, "run_"),
    closedCount: outcome.closed.length, protectedCount: outcome.skipped.length + (session.changedCount || 0),
    failedCount: outcome.failed.length, goneCount: outcome.gone.length
  });
  const retained = [...previouslyClosed, ...outcome.closed, ...outcome.gone, ...outcome.failed];
  if (!retained.length) {
    await deleteSession(session.id);
    await setPanelState({ mode: "done", tabCount: 0, protectedCount: outcome.skipped.length + (session.changedCount || 0) });
    return { session: null };
  }
  const updated = await updateSession(session.id, current => ({
    ...trimPlan(current, retained),
    closeStatus: outcome.failed.length ? "review" : "closed",
    closedAt: outcome.closed.length || outcome.gone.length || previouslyClosed.length ? nowIso() : "",
    pendingTabIds: outcome.failed.map(tab => tab.originalTabId)
  }));
  const doneSession = trimPlan(updated, outcome.closed);
  await showPanelDone(doneSession, updated.categorization, null);
  const state = await readPanelState();
  await setPanelState({ ...state, protectedCount: outcome.skipped.length + (session.changedCount || 0), failedCount: outcome.failed.length });
  emitProgress({ step: "done", sessionId: updated.id, tabCount: outcome.closed.length,
    pendingCount: outcome.failed.length, reviewMode: false });
  await pruneSavedSessions();
  return { session: updated, closedCount: outcome.closed.length, protectedCount: outcome.skipped.length + (session.changedCount || 0), failedCount: outcome.failed.length };
}

// ===== Clutter watcher =====
// Two surfaces, both inside Chrome (never OS-level):
//   1. Icon badge — persistent count when the user is at or above the threshold.
//      Always reactive to tab events, can't be denied by the OS.
//   2. Prepared suggestion — one cycle at a time (src/nudge-cycle.js): over
//      the threshold on a focused, injectable tab → one automatic run → nudge
//      → one reminder 30 minutes later → quiet period with backoff. No
//      scheduled re-runs; between runs the list only shrinks.

const CLUTTER_THRESHOLD_FALLBACK = 20; // used only if reading settings fails
const CLUTTER_DISABLED_KEY = "neatFreakClutterDisabled";
// Nudge cycle and backoff, in local storage so a Chrome restart or extension
// reload does not nudge again straight away.
const NUDGE_CYCLE_KEY = "neatFreakNudgeCycle";
const CLUTTER_BADGE_COLOR = "#dc2626";
const CLUTTER_CHECK_DEBOUNCE_MS = 3000;
const CLUTTER_ALARM_NAME = "neat-freak-clutter-check";
const CLUTTER_ALARM_PERIOD_MIN = 5;
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

function isInjectablePageUrl(url) {
  if (!url) return false;
  // chrome.scripting.executeScript only works on regular web pages. Skip
  // privileged URLs Chrome will reject anyway.
  return /^https?:/.test(url);
}

let clutterInFlight = null;

async function readNudgeCycle() {
  return readCycle((await chrome.storage.local.get(NUDGE_CYCLE_KEY))[NUDGE_CYCLE_KEY]);
}

// Serialized read-modify-write of the cycle. fn returns { cycle, ...extra };
// a falsy cycle leaves the stored state as it was.
let nudgeCycleQueue = Promise.resolve();
function updateNudgeCycle(fn) {
  const next = nudgeCycleQueue.then(async () => {
    const result = (await fn(await readNudgeCycle())) || {};
    if (result.cycle) await chrome.storage.local.set({ [NUDGE_CYCLE_KEY]: result.cycle });
    return result;
  });
  nudgeCycleQueue = next.catch(() => undefined);
  return next;
}

// Opening the list, tidying, pressing Tidy or Refresh: no reminder for this
// cycle, and the quiet period resets to 90 minutes.
const NUDGE_ENGAGEMENT_MESSAGES = new Set([
  "REVIEW_RECOMMENDATION", "EXECUTE_RECOMMENDATION", "REFRESH_RECOMMENDATION",
  "PANEL_TIDY_NOW", "CLUTTER_TOAST_TIDY", "SAVE_TABS", "PANEL_CONFIRM_REVIEW"
]);
async function noteNudgeEngagement() {
  await updateNudgeCycle(cycle => ({ cycle: markEngaged(cycle, Date.now()) })).catch(() => undefined);
}

async function nudgeSurfaceReady(tabs) {
  const focused = await chrome.windows.getLastFocused();
  if (!focused?.focused) return false;
  const target = tabs.find(tab => tab.windowId === focused.id && tab.active);
  return Boolean(target && isInjectablePageUrl(target.url));
}

function checkClutter() {
  if (!clutterInFlight) clutterInFlight = checkClutterOnce().catch(async err => {
    console.warn("[Neat Freak] Recommendation check:", err?.message || err);
    await diagnostics.record("background_error", diagnosticDetails(err));
  }).finally(() => { clutterInFlight = null; });
  return clutterInFlight;
}

async function checkClutterOnce() {
  const settings = await getSettings();
  const tabs = (await queryTabs({})).filter(tab => !tab.incognito);
  const disabled = await isClutterDisabled();
  const threshold = Number(settings.clutterThreshold) || CLUTTER_THRESHOLD_FALLBACK;
  setBadge(disabled ? 0 : tabs.length, threshold);
  // Pruning is cheap and still applies while a review is open or nudges are off.
  let plan = await recommendations.get();
  const state = await readPanelState();
  if (saveInFlight || ["saving", "review", "done"].includes(state.mode)) return;
  if (state.mode === "clutter" && !state.needsPreparation && (!plan || plan.expired || !plan.tabs.length)) {
    // Normal browsing silently retires an unusable offer, not a new warning.
    await setPanelState({ mode: "hidden", retiredSuggestion: true });
    await diagnostics.record("nudge_retired", { reason: !plan ? "unavailable" : plan.expired ? "expired" : "empty" });
    return;
  }
  if (state.mode === "clutter" && plan && !state.needsPreparation) {
    await chrome.storage.session.set({ [PANEL_STATE_KEY]: { ...state, ...recommendationSummary(plan) } });
  }
  await advanceNudgeCycle({ settings, tabs, threshold, disabled, plan, state });
}

// What the cycle needs to know right now. Without background preparation the
// nudge is the count-only card, so "the list" is just being over the limit.
async function nudgeContext({ settings, tabs, threshold, disabled, plan, state }) {
  const overThreshold = tabs.length >= threshold;
  return {
    now: Date.now(), nudgesOn: !disabled, overThreshold, tabCount: tabs.length, goal: threshold,
    surfaceReady: await nudgeSurfaceReady(tabs),
    // A nudge card still on some tab (it pauses off-screen) never blocks the
    // cycle; an open panel, review, save or result does.
    panelBusy: !["hidden", "clutter"].includes(state.mode),
    listCount: !settings.prepareSuggestions ? Number(overThreshold)
      : plan && !plan.expired ? plan.tabs.length : 0
  };
}

async function advanceNudgeCycle(input) {
  const ctx = await nudgeContext(input);
  const decision = await updateNudgeCycle(cycle => {
    const step = nextNudgeStep(cycle, ctx);
    if (step.action === "end") return { step, cycle: endCycle(cycle, step.at, step) };
    if (step.action === "run") return { step, cycle: startRun(cycle, ctx.now, step) };
    return { step };
  });
  if (decision.step.action === "end") {
    if (input.state.mode === "clutter") await setPanelState({ mode: "hidden", retiredSuggestion: true });
    return;
  }
  if (decision.step.action === "show") return showNudge(decision.step.kind, input);
  if (decision.step.action !== "run") return;

  // The cycle's one automatic run. Count-only nudges inspect no pages.
  const runStartedAt = ctx.now;
  let plan = input.plan;
  if (input.settings.prepareSuggestions) {
    const revision = recommendationUiRevision;
    plan = await recommendations.refresh();
    if (saveInFlight || revision !== recommendationUiRevision) {
      // A user action took over; it already set the cycle (engagement).
      await updateNudgeCycle(cycle => ({ cycle: cycle.phase === "running" && cycle.runStartedAt === runStartedAt
        ? endCycle(cycle, Date.now(), { counted: false }) : null }));
      return;
    }
  }
  const listCount = !input.settings.prepareSuggestions ? 1 : plan && !plan.expired ? plan.tabs.length : 0;
  await updateNudgeCycle(cycle => ({ cycle: cycle.phase === "running" && cycle.runStartedAt === runStartedAt
    ? finishRun(cycle, { now: Date.now(), listCount }) : null }));
  // Show it now if the page and panel still allow; otherwise the list waits
  // (pruned, never re-run) for the next check.
  const state = await readPanelState();
  if (saveInFlight || ["saving", "review", "done"].includes(state.mode)) return;
  const tabs = (await queryTabs({})).filter(tab => !tab.incognito);
  const next = await nudgeContext({ ...input, tabs, plan: await recommendations.get(), state });
  const step = nextNudgeStep(await readNudgeCycle(), next);
  if (step.action === "show") return showNudge(step.kind, { ...input, tabs, plan: await recommendations.get(), state });
}

async function showNudge(kind, { settings, tabs, plan }) {
  const countOnly = !settings.prepareSuggestions;
  if (!countOnly && (!plan || plan.expired || !plan.tabs.length)) return;
  const cycle = await readNudgeCycle();
  const shown = await setPanelState(countOnly
    ? { mode: "clutter", tabCount: tabs.length, needsPreparation: true }
    : { mode: "clutter", ...recommendationSummary(plan) });
  if (!shown) return;
  await updateNudgeCycle(current => ({
    cycle: (kind === "first" ? current.phase === "pending" : current.phase === "nudged")
      ? markShown(current, { now: Date.now(), kind, planId: plan?.id, tabCount: tabs.length }) : null
  }));
  await diagnostics.record("nudge_shown", {
    run: plan?.id?.replace(/^plan-/, "run_"), suggestedCount: countOnly ? undefined : plan.tabs.length,
    mode: countOnly ? undefined : plan.mode, nudgeKind: kind, tabCount: tabs.length,
    quietBand: OVER_GOAL_BANDS[cycle.startBand]?.name, doublingStep: cycle.startStep, cycleStart: cycle.cycleTrigger
  });
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
if (chrome.tabs?.onActivated) chrome.tabs.onActivated.addListener(scheduleClutterCheck);
if (chrome.tabs?.onReplaced) chrome.tabs.onReplaced.addListener(scheduleClutterCheck);
if (chrome.tabs?.onUpdated) chrome.tabs.onUpdated.addListener((_id, change) => {
  if (change.url || change.status || "audible" in change || "pinned" in change) scheduleClutterCheck();
});
if (chrome.windows?.onFocusChanged) chrome.windows.onFocusChanged.addListener(scheduleClutterCheck);
if (chrome.runtime?.onStartup) {
  chrome.runtime.onStartup.addListener(() => onTabCountChanged());
}
// Initial paint on SW boot (covers extension reload + first install).
onTabCountChanged();
diagnostics.prune();

// chrome.alarms wakes the MV3 service worker on a schedule, even if it's gone
// idle and the setTimeout-based debounce got killed. This is the reliable
// safety net — tab events kick a fast check (3s debounce), alarms catch the
// case where the SW died mid-debounce or tabs were already at the threshold
// when the SW spun down.
if (chrome.alarms?.get) {
  chrome.alarms.get(CLUTTER_ALARM_NAME).then(alarm => {
    if (alarm?.periodInMinutes === CLUTTER_ALARM_PERIOD_MIN) return;
    return chrome.alarms.create(CLUTTER_ALARM_NAME, { delayInMinutes: 1, periodInMinutes: CLUTTER_ALARM_PERIOD_MIN });
  }).catch(() => undefined);
}
if (chrome.alarms?.onAlarm) {
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name !== CLUTTER_ALARM_NAME) return;
    scheduleClutterCheck();
    diagnostics.prune();
    if (!saveInFlight) pruneSavedSessions().catch(() => undefined);
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
  behaviorLog.markSaved(tabIds); // queued before the onRemoved it labels as a save
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
