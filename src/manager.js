import { faviconFallback, formatDateTime, sortSessions } from "./utils.js";

const container = document.querySelector("#sessions-container");
const statsEl = document.querySelector("#manager-stats");
const searchInput = document.querySelector("#session-search");
const searchHintEl = document.querySelector("#manager-search-hint");
const searchResultsEl = document.querySelector("#manager-search-results");
const importInput = document.querySelector("#import-file");
const snackbarEl = document.querySelector("#manager-snackbar");
const snackbarSettingsBtn = document.querySelector("#snackbar-settings");
const snackbarDismissBtn = document.querySelector("#snackbar-dismiss");
const saveBannerEl = document.querySelector("#manager-save-banner");

const SNACKBAR_DISMISS_KEY = "neatFreakNoKeySnackbarDismissed";
const STEP_LABELS = {
  scanning: "Scanning open tabs…",
  capturing: "Capturing URLs…",
  grouping: "Grouping…",
  saving: "Saving session…"
};

let saveBannerHideTimer = null;

let sessions = [];
let searchDebounce = null;
let activeQuery = "";
let activeMode = "local";

init();

async function init() {
  bindEvents();
  await refresh();
}

function bindEvents() {
  searchInput.addEventListener("input", () => {
    const query = searchInput.value;
    scheduleLocalSearch(query);
  });
  searchInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      runSearch(searchInput.value, "smart");
    } else if (event.key === "Escape") {
      searchInput.value = "";
      clearSearchUi();
    }
  });
  document.querySelector("#open-options").addEventListener("click", () => send("OPEN_OPTIONS"));
  document.querySelector("#open-help").addEventListener("click", openHelp);
  document.querySelector("#help-close").addEventListener("click", closeHelp);
  document.querySelector("#help-overlay").addEventListener("click", (event) => {
    if (event.target === event.currentTarget) closeHelp();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    if (!document.querySelector("#help-overlay").hasAttribute("hidden")) {
      closeHelp();
    } else if (!document.querySelector("#backup-popover").hasAttribute("hidden")) {
      closeBackupPopover();
    }
  });
  snackbarSettingsBtn.addEventListener("click", () => send("OPEN_OPTIONS"));
  snackbarDismissBtn.addEventListener("click", () => {
    try { sessionStorage.setItem(SNACKBAR_DISMISS_KEY, "1"); } catch { /* ignore */ }
    snackbarEl.setAttribute("hidden", "");
  });

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === "SAVE_PROGRESS") handleSaveProgress(message);
  });
  document.querySelector("#capture-now").addEventListener("click", async () => {
    const response = await send("SAVE_TABS", {
      options: {
        openManager: false,
        scope: "allWindows"
      }
    });
    if (!response.ok) showToast(response.error, "error");
    if (response.ok && response.session?.id) {
      location.hash = response.session.id;
    }
    await refresh();
  });
  document.querySelector("#export-sessions").addEventListener("click", () => {
    closeBackupPopover();
    exportSessions();
  });
  document.querySelector("#import-sessions").addEventListener("click", () => {
    closeBackupPopover();
    importInput.click();
  });
  importInput.addEventListener("change", importSessions);

  document.querySelector("#open-backup").addEventListener("click", (event) => {
    event.stopPropagation();
    toggleBackupPopover();
  });
  document.addEventListener("click", (event) => {
    const popover = document.querySelector("#backup-popover");
    if (popover.hasAttribute("hidden")) return;
    if (event.target.closest("#backup-popover") || event.target.closest("#open-backup")) return;
    closeBackupPopover();
  });

  container.addEventListener("click", async (event) => {
    const button = event.target.closest("[data-action]");
    if (!button) return;
    event.preventDefault();
    event.stopPropagation();
    button.dataset.loading = "true";
    button.setAttribute("aria-busy", "true");
    const { action, sessionId, categoryId, tabId, categoryName, tabCount } = button.dataset;
    try {
      await handleAction(action, { sessionId, categoryId, tabId, categoryName, tabCount });
    } finally {
      // refresh() typically replaces the DOM, but clear the flag in case the button persisted.
      button.removeAttribute("aria-busy");
      delete button.dataset.loading;
    }
  });
}

async function refresh() {
  const response = await send("GET_SESSIONS");
  if (!response.ok) {
    container.innerHTML = emptyState(response.error || "Could not load sessions.");
    return;
  }
  sessions = sortSessions(response.sessions || []);
  render();
  refreshSnackbar();
}

async function refreshSnackbar() {
  let dismissed = false;
  try { dismissed = sessionStorage.getItem(SNACKBAR_DISMISS_KEY) === "1"; } catch { /* ignore */ }
  if (dismissed) {
    snackbarEl.setAttribute("hidden", "");
    return;
  }
  const response = await send("GET_SETTINGS");
  if (!response.ok) return;
  const { llmEnabled, apiKey } = response.settings || {};
  if (llmEnabled && !apiKey) {
    snackbarEl.removeAttribute("hidden");
  } else {
    snackbarEl.setAttribute("hidden", "");
  }
}

function render() {
  const tabCount = sessions.reduce((sum, session) => sum + (session.tabs?.length || 0), 0);
  statsEl.textContent = `${sessions.length} session${sessions.length === 1 ? "" : "s"} · ${tabCount} saved tab${tabCount === 1 ? "" : "s"}`;

  if (!sessions.length) {
    container.innerHTML = emptyState("No sessions saved yet.");
    return;
  }

  const highlightedId = decodeURIComponent(location.hash.replace(/^#/, ""));
  container.innerHTML = sessions.map((session) => renderSession(session, highlightedId)).join("");
}

function scheduleLocalSearch(query) {
  clearTimeout(searchDebounce);
  if (!query.trim()) {
    clearSearchUi();
    return;
  }
  searchDebounce = setTimeout(() => runSearch(query, "local"), 160);
}

function clearSearchUi() {
  activeQuery = "";
  activeMode = "local";
  searchResultsEl.setAttribute("hidden", "");
  searchResultsEl.innerHTML = "";
  container.removeAttribute("hidden");
  searchHintEl.setAttribute("hidden", "");
  searchHintEl.innerHTML = "Press <kbd>↵</kbd> for smart search";
}

async function runSearch(rawQuery, mode) {
  const query = String(rawQuery || "").trim();
  if (!query) {
    clearSearchUi();
    return;
  }

  activeQuery = query;
  activeMode = mode;
  searchHintEl.removeAttribute("hidden");
  searchResultsEl.removeAttribute("hidden");
  container.setAttribute("hidden", "");

  if (mode === "smart") {
    searchHintEl.textContent = "Asking gpt-5.4-mini…";
    searchResultsEl.innerHTML = `<p class="manager-search-empty">Asking gpt-5.4-mini to rerank matches…</p>`;
  } else if (!searchResultsEl.innerHTML) {
    searchResultsEl.innerHTML = `<p class="manager-search-empty">Searching…</p>`;
  }

  const response = await send("SEARCH_TABS", { query, mode });
  // Discard stale responses
  if (activeQuery !== query || activeMode !== mode) return;

  if (!response.ok) {
    searchResultsEl.innerHTML = `<p class="manager-search-empty">${escapeHtml(response.error || "Search failed.")}</p>`;
    searchHintEl.textContent = "Search failed";
    return;
  }

  const results = response.results || [];
  const modeUsed = response.mode || "local";
  if (modeUsed === "smart") {
    searchHintEl.innerHTML = `Smart search results · <kbd>↵</kbd> to rerun`;
  } else if (response.error) {
    searchHintEl.textContent = response.error;
  } else {
    searchHintEl.innerHTML = `Press <kbd>↵</kbd> for smart search`;
  }

  if (!results.length) {
    searchResultsEl.innerHTML = `<p class="manager-search-empty">No saved tabs match “${escapeHtml(query)}”.</p>`;
    return;
  }

  searchResultsEl.innerHTML = renderManagerSearchHeader(results.length, modeUsed) + results.map((tab) => renderManagerSearchResult(tab, modeUsed)).join("");
}

function renderManagerSearchHeader(count, mode) {
  const label = mode === "smart" ? "gpt-5.4-mini ranked" : "Best matches";
  return `<div class="manager-search-meta">${count} result${count === 1 ? "" : "s"} · ${escapeHtml(label)}</div>`;
}

function renderManagerSearchResult(tab, mode) {
  const favicon = tab.favIconUrl
    ? `<img src="${escapeAttribute(tab.favIconUrl)}" alt="">`
    : `<span>${escapeHtml(faviconFallback(tab.domain))}</span>`;
  const meta = [];
  if (tab.folderName) meta.push(escapeHtml(tab.folderName));
  if (tab.sessionCreatedAt) meta.push(escapeHtml(formatDateTime(tab.sessionCreatedAt)));
  if (tab.domain) meta.push(escapeHtml(tab.domain));
  const reason = mode === "smart" && tab.smartReason
    ? `<small class="manager-search-reason">${escapeHtml(tab.smartReason)}</small>`
    : "";
  return `
    <a class="manager-search-result" href="${escapeAttribute(tab.url)}" data-search-url="${escapeAttribute(tab.url)}" data-session-id="${escapeAttribute(tab.sessionId || "")}" target="_blank" rel="noreferrer">
      <span class="favicon">${favicon}</span>
      <span class="manager-search-main">
        <strong>${escapeHtml(tab.title || tab.url)}</strong>
        <small>${meta.join(" · ")}</small>
        ${reason}
      </span>
    </a>
  `;
}

function renderSession(session, highlightedId) {
  const tabCount = session.tabs?.length || 0;
  const tabMap = new Map((session.tabs || []).map((tab) => [tab.id, tab]));
  const categories = session.categories || [];

  // Sort: folders (2+ tabs) first by size, then singletons by tab title
  const folders = categories
    .filter((c) => (c.tabIds || []).length >= 2)
    .sort((a, b) => (b.tabIds?.length || 0) - (a.tabIds?.length || 0));
  const singletonRows = categories
    .filter((c) => (c.tabIds || []).length === 1)
    .map((c) => tabMap.get(c.tabIds[0]))
    .filter(Boolean);

  const pendingCount = session.pendingTabIds?.length || 0;
  const method = session.categorization?.method || "";
  const llmUsed = method.includes("llm");

  return `
    <article class="session-card ${session.id === highlightedId ? "highlighted" : ""}">
      <header class="session-row">
        <div class="session-title-block">
          <h2>${escapeHtml(formatDateTime(session.createdAt))}</h2>
          <p>${tabCount} tab${tabCount === 1 ? "" : "s"} · ${folders.length} folder${folders.length === 1 ? "" : "s"}${singletonRows.length ? ` · ${singletonRows.length} loose` : ""}${llmUsed ? " · LLM" : ""}</p>
        </div>
        <div class="session-row-actions">
          ${pendingCount ? `<button class="attention-button" data-action="close-saved" data-session-id="${escapeHtml(session.id)}" type="button">Close ${pendingCount} live tab${pendingCount === 1 ? "" : "s"}</button>` : ""}
          <button class="icon-button hover-only" data-action="restore-session" data-session-id="${escapeHtml(session.id)}" type="button" title="Open all tabs from this session" aria-label="Restore session">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 3h7v7"></path><path d="M21 3 12 12"></path><path d="M5 5h6"></path><path d="M5 19h14v-6"></path></svg>
          </button>
          <button class="icon-button hover-only" data-action="recategorize" data-session-id="${escapeHtml(session.id)}" type="button" title="Re-run grouping" aria-label="Recategorize">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 12a9 9 0 0 1 15.7-6"></path><path d="M21 4v5h-5"></path><path d="M21 12a9 9 0 0 1-15.7 6"></path><path d="M3 20v-5h5"></path></svg>
          </button>
          <button class="icon-button hover-only danger" data-action="delete-session" data-session-id="${escapeHtml(session.id)}" type="button" title="Delete session" aria-label="Delete session">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 7h12"></path><path d="M9 7V5h6v2"></path><path d="M9 11v6"></path><path d="M15 11v6"></path><path d="M8 7l1 13h6l1-13"></path></svg>
          </button>
        </div>
      </header>
      ${renderSessionError(session.categorization?.error)}
      <div class="session-list">
        ${folders.map((category) => renderFolder(session, category, tabMap)).join("")}
        ${singletonRows.map((tab) => renderStandaloneTab(session.id, tab)).join("")}
      </div>
    </article>
  `;
}

function renderFolder(session, category, tabMap) {
  const tabs = (category.tabIds || []).map((tabId) => tabMap.get(tabId)).filter(Boolean);
  return `
    <details class="folder">
      <summary class="folder-header">
        <span class="folder-disclosure" aria-hidden="true">
          <svg viewBox="0 0 24 24"><path d="m9 6 6 6-6 6"></path></svg>
        </span>
        <span class="folder-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z"></path></svg>
        </span>
        <span class="folder-name">${escapeHtml(category.name)}</span>
        <span class="folder-count">${tabs.length}</span>
        <span class="folder-actions hover-only">
          <button class="icon-button small" data-action="restore-group" data-session-id="${escapeHtml(session.id)}" data-category-id="${escapeHtml(category.id)}" type="button" title="Open all in this folder" aria-label="Open folder">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 3h7v7"></path><path d="M21 3 12 12"></path><path d="M5 5h6"></path><path d="M5 19h14v-6"></path></svg>
          </button>
          <button class="icon-button small danger" data-action="delete-group" data-session-id="${escapeHtml(session.id)}" data-category-id="${escapeHtml(category.id)}" data-category-name="${escapeAttribute(category.name || "this folder")}" data-tab-count="${tabs.length}" type="button" title="Delete folder" aria-label="Delete folder">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 7h12"></path><path d="M9 7V5h6v2"></path><path d="M9 11v6"></path><path d="M15 11v6"></path><path d="M8 7l1 13h6l1-13"></path></svg>
          </button>
        </span>
      </summary>
      <div class="folder-children">
        ${tabs.map((tab) => renderTabRow(session.id, category.id, tab)).join("")}
      </div>
    </details>
  `;
}

function renderStandaloneTab(sessionId, tab) {
  return renderTabRow(sessionId, "", tab, { standalone: true });
}

function renderTabRow(sessionId, categoryId, tab, opts = {}) {
  const favicon = tab.favIconUrl
    ? `<img src="${escapeAttribute(tab.favIconUrl)}" alt="">`
    : `<span>${escapeHtml(faviconFallback(tab.domain))}</span>`;
  const standaloneClass = opts.standalone ? " standalone" : "";
  return `
    <div class="tab-row${standaloneClass}" data-category-id="${escapeHtml(categoryId)}">
      <div class="favicon">${favicon}</div>
      <div class="tab-main">
        <a href="${escapeAttribute(tab.url)}" target="_blank" rel="noreferrer">${escapeHtml(tab.title || tab.url)}</a>
        <small>${escapeHtml(tab.domain || tab.url)}</small>
      </div>
      <div class="tab-row-actions hover-only">
        <button class="icon-button small" title="Open tab" aria-label="Open tab" data-action="restore-tab" data-session-id="${escapeHtml(sessionId)}" data-tab-id="${escapeHtml(tab.id)}" type="button">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 3h7v7"></path><path d="M21 3 12 12"></path><path d="M5 5h6"></path><path d="M5 19h14v-6"></path></svg>
        </button>
        <button class="icon-button small danger" title="Delete saved tab" aria-label="Delete saved tab" data-action="delete-tab" data-session-id="${escapeHtml(sessionId)}" data-tab-id="${escapeHtml(tab.id)}" type="button">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 7h12"></path><path d="M9 7V5h6v2"></path><path d="M9 11v6"></path><path d="M15 11v6"></path><path d="M8 7l1 13h6l1-13"></path></svg>
        </button>
      </div>
    </div>
  `;
}

async function handleAction(action, detail) {
  const actionMap = {
    "close-saved": ["CLOSE_SAVED_TABS", { sessionId: detail.sessionId }],
    "restore-session": ["RESTORE_SESSION", { sessionId: detail.sessionId }],
    "restore-group": ["RESTORE_GROUP", { sessionId: detail.sessionId, categoryId: detail.categoryId }],
    "restore-tab": ["RESTORE_TAB", { sessionId: detail.sessionId, tabId: detail.tabId }],
    "delete-tab": ["DELETE_TAB", { sessionId: detail.sessionId, tabId: detail.tabId }],
    "recategorize": ["RECATEGORIZE_SESSION", { sessionId: detail.sessionId }]
  };

  if (action === "delete-session") {
    const session = sessions.find((item) => item.id === detail.sessionId);
    const label = session ? `the session saved ${formatDateTime(session.createdAt)}` : "this session";
    if (!confirm(`Delete ${label} and its ${session?.tabs?.length || 0} saved tabs?`)) return;
    const response = await send("DELETE_SESSION", { sessionId: detail.sessionId });
    if (!response.ok) showToast(response.error, "error");
    await refresh();
    return;
  }

  if (action === "delete-group") {
    const count = Number(detail.tabCount) || 0;
    const tabLabel = `${count} saved tab${count === 1 ? "" : "s"}`;
    const name = detail.categoryName || "this group";
    if (!confirm(`Delete the "${name}" group and its ${tabLabel}? Open tabs in your browser aren't affected.`)) return;
    const response = await send("DELETE_GROUP", { sessionId: detail.sessionId, categoryId: detail.categoryId });
    if (!response.ok) showToast(response.error, "error");
    await refresh();
    return;
  }

  const mapped = actionMap[action];
  if (!mapped) return;
  const [type, payload] = mapped;
  const response = await send(type, payload);
  if (!response.ok) showToast(response.error, "error");
  await refresh();
}

async function exportSessions() {
  const blob = new Blob([JSON.stringify(sessions, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `tab-atlas-${new Date().toISOString().slice(0, 10)}.json`;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function importSessions() {
  const file = importInput.files?.[0];
  if (!file) return;
  const text = await file.text();
  const parsed = JSON.parse(text);
  const response = await send("IMPORT_SESSIONS", { sessions: parsed });
  if (!response.ok) showToast(response.error, "error");
  importInput.value = "";
  await refresh();
}

function toggleBackupPopover() {
  const popover = document.querySelector("#backup-popover");
  const button = document.querySelector("#open-backup");
  const isOpen = !popover.hasAttribute("hidden");
  if (isOpen) {
    closeBackupPopover();
  } else {
    popover.removeAttribute("hidden");
    button.setAttribute("aria-expanded", "true");
  }
}

function closeBackupPopover() {
  const popover = document.querySelector("#backup-popover");
  const button = document.querySelector("#open-backup");
  popover.setAttribute("hidden", "");
  button.setAttribute("aria-expanded", "false");
}

function openHelp() {
  const overlay = document.querySelector("#help-overlay");
  overlay.removeAttribute("hidden");
  overlay.setAttribute("aria-hidden", "false");
  document.querySelector("#help-close").focus();
}

function closeHelp() {
  const overlay = document.querySelector("#help-overlay");
  overlay.setAttribute("hidden", "");
  overlay.setAttribute("aria-hidden", "true");
  document.querySelector("#open-help").focus();
}

function handleSaveProgress(message) {
  if (saveBannerHideTimer) {
    clearTimeout(saveBannerHideTimer);
    saveBannerHideTimer = null;
  }

  if (message.step === "done") {
    const tabCount = message.tabCount || 0;
    const groupCount = message.groupCount || 0;
    const looseCount = message.looseCount || 0;
    const llm = message.llm;
    const detail = [
      `${groupCount} folder${groupCount === 1 ? "" : "s"}`,
      looseCount ? `${looseCount} loose` : null,
      llm ? "gpt-5.4-mini" : null
    ].filter(Boolean).join(" · ");

    saveBannerEl.classList.remove("loading");
    saveBannerEl.classList.add("done");
    saveBannerEl.removeAttribute("hidden");
    saveBannerEl.innerHTML = `
      <span class="save-banner-check" aria-hidden="true">✓</span>
      <span class="save-banner-text"><strong>${tabCount} tab${tabCount === 1 ? "" : "s"} tucked away</strong> · ${escapeHtml(detail)}</span>
    `;
    if (message.sessionId) {
      location.hash = encodeURIComponent(message.sessionId);
    }
    refresh().catch(() => undefined);
    saveBannerHideTimer = setTimeout(() => {
      saveBannerEl.setAttribute("hidden", "");
      saveBannerEl.classList.remove("done");
    }, 5000);
    return;
  }

  let label = STEP_LABELS[message.step] || "Working…";
  if (message.step === "capturing" && Number(message.tabCount) > 0) {
    label = `Capturing ${message.tabCount} URL${message.tabCount === 1 ? "" : "s"}…`;
  } else if (message.step === "grouping") {
    label = message.llm ? "Asking gpt-5.4-mini to group your tabs…" : "Building groups locally…";
  }

  saveBannerEl.classList.add("loading");
  saveBannerEl.classList.remove("done");
  saveBannerEl.removeAttribute("hidden");
  saveBannerEl.innerHTML = `
    <span class="save-banner-spinner" aria-hidden="true"></span>
    <span class="save-banner-text">${escapeHtml(label)}</span>
  `;
}

function renderSessionError(error) {
  if (!error) return "";
  // The "needs API key" hint is shown once via the top-level snackbar — don't repeat it per session.
  if (/api key in settings/i.test(error)) return "";
  return `<p class="warning-line">${escapeHtml(error)}</p>`;
}

function emptyState(message) {
  return `
    <section class="empty-state">
      <h2>${escapeHtml(message)}</h2>
      <p>Save your current window from the popup or this manager page to create grouped tab sessions.</p>
    </section>
  `;
}

function showToast(message, tone = "normal") {
  statsEl.textContent = message;
  statsEl.dataset.tone = tone;
}

function send(type, payload = {}) {
  return chrome.runtime.sendMessage({ type, ...payload });
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#39;"
  })[character]);
}

function escapeAttribute(value) {
  return escapeHtml(value).replace(/`/g, "&#96;");
}
