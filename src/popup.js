import { formatDateTime } from "./utils.js";

const recentEl = document.querySelector("#recent-sessions");
const statusEl = document.querySelector("#status-line");
const saveButton = document.querySelector("#save-tabs");
const saveModeCopy = document.querySelector("#save-mode-copy");
const saveButtonLabel = document.querySelector("#save-button-label");
const reviewInput = document.querySelector("#review-before-close");
const pinnedInput = document.querySelector("#include-pinned");
const keepCurrentTabInput = document.querySelector("#keep-current-tab");
const scopeButtons = [...document.querySelectorAll("[data-scope]")];
const captureOptionsToggle = document.querySelector("#toggle-capture-options");
const captureOptionsEl = document.querySelector("#capture-options");
const defaultStateEl = document.querySelector("#default-state");
const progressEl = document.querySelector("#save-progress");
const progressStepEls = [...progressEl.querySelectorAll("[data-step]")];
const progressHintEl = progressEl.querySelector(".progress-hint");
const doneEl = document.querySelector("#save-done");
const doneTitleEl = document.querySelector("#done-title");
const doneSubtitleEl = document.querySelector("#done-subtitle");
const doneFoldersEl = document.querySelector("#done-folders");
const closeLiveBtn = document.querySelector("#close-live-tabs");
const openResultButton = document.querySelector("#open-result");

const STEP_ORDER = ["scanning", "capturing", "grouping", "saving"];
const STEP_LABELS = {
  scanning: "Scanning open tabs",
  capturing: "Capturing URLs",
  grouping: "Grouping",
  saving: "Saving"
};

const searchInput = document.querySelector("#popup-search");
const searchClear = document.querySelector("#popup-search-clear");
const searchHint = document.querySelector("#popup-search-hint");
const searchResultsEl = document.querySelector("#popup-search-results");

let selectedScope = "allWindows";
let lastResultSessionId = "";
let searchDebounce = null;
let lastQuery = "";
let lastMode = "local";
let progressWatchdog = null;
const PROGRESS_WATCHDOG_MS = 90 * 1000;

init();

async function init() {
  bindEvents();
  await refresh();
  await recoverInFlightSave();
}

async function recoverInFlightSave() {
  try {
    const session = chrome.storage?.session;
    if (!session) return;
    const { neatFreakSaveState: state } = await session.get("neatFreakSaveState");
    if (!state) return;
    const elapsed = Date.now() - (state.t || 0);

    if (state.step === "done") {
      // Only re-show "done" if it was very recent — otherwise we'd flash a stale message.
      if (elapsed > 30 * 1000) return;
      showDoneState({
        sessionId: state.sessionId,
        tabCount: state.tabCount || 0,
        groupCount: state.groupCount || 0,
        looseCount: state.looseCount || 0,
        llm: Boolean(state.llm),
        folders: Array.isArray(state.folders) ? state.folders : [],
        pendingCount: state.pendingCount || 0,
        reviewMode: Boolean(state.reviewMode)
      });
      return;
    }

    // For in-progress steps, only show progress if the save is still active.
    if (elapsed > 5 * 60 * 1000) return;
    enterProgressState();
    handleProgress(state);
  } catch {
    // No-op — recovery is best-effort.
  }
}

function bindEvents() {
  scopeButtons.forEach((button) => {
    button.addEventListener("click", async () => {
      selectedScope = button.dataset.scope;
      scopeButtons.forEach((item) => item.classList.toggle("active", item === button));
      await refreshPreview();
    });
  });

  pinnedInput.addEventListener("change", refreshPreview);
  keepCurrentTabInput.addEventListener("change", refreshPreview);
  reviewInput.addEventListener("change", () => undefined);
  saveButton.addEventListener("click", saveTabs);
  captureOptionsToggle.addEventListener("click", toggleCaptureOptions);
  document.querySelector("#brand-home").addEventListener("click", () => {
    send("OPEN_MANAGER");
    window.close();
  });
  document.querySelector("#open-manager").addEventListener("click", () => send("OPEN_MANAGER"));
  document.querySelector("#open-options").addEventListener("click", () => send("OPEN_OPTIONS"));
  openResultButton.addEventListener("click", () => {
    if (lastResultSessionId) {
      send("OPEN_MANAGER", { sessionId: lastResultSessionId });
    } else {
      send("OPEN_MANAGER");
    }
    window.close();
  });

  closeLiveBtn.addEventListener("click", async () => {
    if (!lastResultSessionId) return;
    closeLiveBtn.disabled = true;
    closeLiveBtn.textContent = "Closing…";
    const response = await send("CLOSE_SAVED_TABS", { sessionId: lastResultSessionId });
    if (!response.ok) {
      closeLiveBtn.disabled = false;
      closeLiveBtn.textContent = "Close live tabs";
      setStatus(response.error || "Couldn't close live tabs.", "error");
      return;
    }
    closeLiveBtn.setAttribute("hidden", "");
    setStatus("Live tabs closed. Original tabs are now in the saved session.");
  });

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type !== "SAVE_PROGRESS") return;
    handleProgress(message);
  });

  searchInput.addEventListener("input", () => {
    const query = searchInput.value;
    searchClear.toggleAttribute("hidden", !query);
    scheduleLocalSearch(query);
  });

  searchInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      runSearch(searchInput.value, "smart");
    } else if (event.key === "Escape") {
      clearSearch();
    }
  });

  searchClear.addEventListener("click", clearSearch);
}

async function refresh() {
  const response = await send("GET_POPUP_STATE");
  if (!response.ok) {
    setStatus(response.error, "error");
    return;
  }

  const { settings, preview, sessions } = response;
  selectedScope = settings.defaultScope || "allWindows";
  reviewInput.checked = Boolean(settings.defaultReviewBeforeClose);
  pinnedInput.checked = Boolean(settings.defaultIncludePinned);
  keepCurrentTabInput.checked = Boolean(settings.defaultKeepCurrentTab);
  scopeButtons.forEach((button) => button.classList.toggle("active", button.dataset.scope === selectedScope));
  renderPreview(preview);
  renderRecentSessions(sessions || []);
  setStatus(settings.apiKey ? "LLM grouping is ready." : "Add an API key in settings for LLM grouping.");
}

async function refreshPreview() {
  const response = await send("PREVIEW_TABS", {
    options: {
      includePinned: pinnedInput.checked,
      keepCurrentTab: keepCurrentTabInput.checked,
      scope: selectedScope
    }
  });
  if (response.ok) renderPreview(response.preview);
}

async function saveTabs() {
  saveButton.disabled = true;
  enterProgressState();

  const response = await send("SAVE_TABS", {
    options: {
      includePinned: pinnedInput.checked,
      keepCurrentTab: keepCurrentTabInput.checked,
      reviewBeforeClose: reviewInput.checked,
      scope: selectedScope,
      openManager: true
    }
  });

  saveButton.disabled = false;
  if (!response.ok) {
    exitProgressState();
    setStatus(response.error || "Save failed.", "error");
    return;
  }

  // If the SAVE_PROGRESS "done" event arrived first, the done UI is already shown.
  // Otherwise show it now from the response.
  if (!doneEl.hasAttribute("hidden")) return;
  const session = response.session;
  const categories = session?.categories || [];
  const folderObjs = categories
    .filter((c) => (c.tabIds || []).length >= 2)
    .map((c) => ({ id: c.id, name: c.name, count: c.tabIds.length }));
  const loose = categories.filter((c) => (c.tabIds || []).length === 1).length;
  showDoneState({
    sessionId: session?.id,
    tabCount: session?.tabs?.length || 0,
    groupCount: folderObjs.length,
    looseCount: loose,
    llm: session?.categorization?.method?.includes("llm"),
    folders: folderObjs,
    pendingCount: session?.pendingTabIds?.length || 0,
    reviewMode: session?.closeStatus === "review",
    keepCount: session?.categorization?.keepCount || 0,
    smartMode: session?.categorization?.method?.startsWith("smart-")
      ? (session.categorization.method === "smart-llm" ? "llm" : "heuristic")
      : null,
    smartError: session?.categorization?.error || ""
  });
}

function enterProgressState() {
  defaultStateEl.setAttribute("hidden", "");
  doneEl.setAttribute("hidden", "");
  progressEl.removeAttribute("hidden");
  setStatus("");
  progressStepEls.forEach((el) => {
    el.dataset.state = "pending";
    const label = el.querySelector(".step-label");
    if (label) label.textContent = STEP_LABELS[el.dataset.step] || el.dataset.step;
  });
  progressHintEl.textContent = "You can close this — Neat Freak will ping you when it's done.";
  armWatchdog();
}

function exitProgressState() {
  clearWatchdog();
  progressEl.setAttribute("hidden", "");
  doneEl.setAttribute("hidden", "");
  defaultStateEl.removeAttribute("hidden");
}

function armWatchdog() {
  clearWatchdog();
  progressWatchdog = setTimeout(showStuckRecovery, PROGRESS_WATCHDOG_MS);
}

function clearWatchdog() {
  if (progressWatchdog) {
    clearTimeout(progressWatchdog);
    progressWatchdog = null;
  }
}

function showStuckRecovery() {
  progressHintEl.innerHTML = `Taking longer than usual. <button type="button" class="link-button inline-link" id="stuck-open-manager">Open manager →</button>`;
  const btn = document.querySelector("#stuck-open-manager");
  if (btn) {
    btn.addEventListener("click", () => {
      send("OPEN_MANAGER");
      window.close();
    });
  }
}

function handleProgress(message) {
  // Reset the watchdog on every progress event — save is making real progress.
  armWatchdog();
  if (message.step === "done") {
    clearWatchdog();
    showDoneState({
      sessionId: message.sessionId,
      tabCount: message.tabCount || 0,
      groupCount: message.groupCount || 0,
      looseCount: message.looseCount || 0,
      llm: Boolean(message.llm),
      folders: Array.isArray(message.folders) ? message.folders : [],
      pendingCount: message.pendingCount || 0,
      reviewMode: Boolean(message.reviewMode),
      keepCount: message.keepCount || 0,
      smartMode: message.smartMode || null,
      smartError: message.smartError || ""
    });
    return;
  }

  if (progressEl.hasAttribute("hidden")) progressEl.removeAttribute("hidden");
  defaultStateEl.setAttribute("hidden", "");

  const incomingIndex = STEP_ORDER.indexOf(message.step);
  if (incomingIndex < 0) return;

  progressStepEls.forEach((el, idx) => {
    if (idx < incomingIndex) el.dataset.state = "done";
    else if (idx === incomingIndex) el.dataset.state = "active";
    else el.dataset.state = "pending";
  });

  const activeEl = progressStepEls[incomingIndex];
  const activeLabel = activeEl?.querySelector(".step-label");
  if (!activeLabel) return;

  if (message.step === "capturing" && Number(message.tabCount) > 0) {
    activeLabel.textContent = `Capturing ${message.tabCount} URL${message.tabCount === 1 ? "" : "s"}`;
  } else if (message.step === "grouping") {
    activeLabel.textContent = message.llm ? "Asking gpt-5.4-mini" : "Grouping locally";
  } else {
    activeLabel.textContent = STEP_LABELS[message.step] || message.step;
  }
}

function showDoneState({ sessionId, tabCount, groupCount, looseCount, llm, folders, pendingCount, reviewMode, keepCount = 0, smartMode = null, smartError = "" }) {
  lastResultSessionId = sessionId || "";
  progressEl.setAttribute("hidden", "");
  defaultStateEl.setAttribute("hidden", "");
  doneEl.removeAttribute("hidden");

  if (smartMode && tabCount === 0 && keepCount > 0) {
    doneTitleEl.textContent = "Nothing's stale yet";
    doneSubtitleEl.textContent = "All your tabs look fresh — no cleanup needed right now.";
  } else {
    doneTitleEl.textContent = `${tabCount} tab${tabCount === 1 ? "" : "s"} tucked away`;
    const parts = [];
    parts.push(`${groupCount} folder${groupCount === 1 ? "" : "s"}`);
    if (looseCount) parts.push(`${looseCount} loose`);
    if (smartMode === "heuristic" && smartError) parts.push("heuristic (LLM unavailable)");
    else if (smartMode === "heuristic") parts.push("heuristic");
    else if (smartMode === "llm" || llm) parts.push("gpt-5.4-mini");
    if (keepCount) parts.push(`${keepCount} kept open`);
    doneSubtitleEl.textContent = parts.join(" · ");
  }

  const folderList = Array.isArray(folders) ? folders : [];
  if (folderList.length) {
    doneFoldersEl.innerHTML = folderList.map((folder) => `
      <li class="done-folder">
        <span class="done-folder-name">${escapeHtml(folder.name || "Folder")}</span>
        <span class="done-folder-count">${folder.count} tab${folder.count === 1 ? "" : "s"}</span>
      </li>
    `).join("");
    doneFoldersEl.removeAttribute("hidden");
  } else {
    doneFoldersEl.innerHTML = "";
    doneFoldersEl.setAttribute("hidden", "");
  }

  if (reviewMode && pendingCount > 0) {
    closeLiveBtn.textContent = `Close ${pendingCount} live tab${pendingCount === 1 ? "" : "s"}`;
    closeLiveBtn.disabled = false;
    closeLiveBtn.removeAttribute("hidden");
  } else {
    closeLiveBtn.setAttribute("hidden", "");
  }
}

function renderPreview(preview) {
  const count = preview?.count || 0;
  const skipped = preview?.skippedCount || 0;
  const isSmart = selectedScope === "smart";

  if (count === 0) {
    saveButtonLabel.textContent = "Nothing to tidy";
    if (skipped) {
      saveModeCopy.textContent = `${skipped} tab${skipped === 1 ? "" : "s"} skipped (pinned, current, or unsupported)`;
    } else {
      saveModeCopy.textContent = "No open tabs are eligible to save";
    }
  } else if (isSmart) {
    saveButtonLabel.textContent = "Tidy my tabs";
    saveModeCopy.textContent = `${count} tab${count === 1 ? "" : "s"} eligible — Smart will pick`;
  } else {
    saveButtonLabel.textContent = "Tidy my tabs";
    let copy = `${count} tab${count === 1 ? "" : "s"} to save`;
    if (skipped) copy += `, ${skipped} skipped`;
    saveModeCopy.textContent = copy;
  }
  saveButton.toggleAttribute("disabled", count === 0);
}

function toggleCaptureOptions() {
  const isOpen = !captureOptionsEl.hasAttribute("hidden");
  captureOptionsEl.toggleAttribute("hidden", isOpen);
  captureOptionsToggle.setAttribute("aria-expanded", String(!isOpen));
  captureOptionsToggle.classList.toggle("open", !isOpen);
}

function renderRecentSessions(sessions) {
  if (!sessions.length) {
    recentEl.innerHTML = `<p class="empty-small">No saved sessions yet.</p>`;
    return;
  }

  recentEl.innerHTML = sessions.map((session) => {
    const tabCount = session.tabs?.length || 0;
    return `
      <button class="recent-session" type="button" data-session-id="${escapeHtml(session.id)}">
        <span>
          <strong>${escapeHtml(formatDateTime(session.createdAt))}</strong>
          <small>${tabCount} tab${tabCount === 1 ? "" : "s"}</small>
        </span>
      </button>
    `;
  }).join("");

  recentEl.querySelectorAll("[data-session-id]").forEach((button) => {
    button.addEventListener("click", () => send("OPEN_MANAGER", { sessionId: button.dataset.sessionId }));
  });
}

function setStatus(message, tone = "normal") {
  statusEl.textContent = message || "";
  statusEl.dataset.tone = tone;
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

function scheduleLocalSearch(query) {
  clearTimeout(searchDebounce);
  if (!query.trim()) {
    clearSearchUi();
    return;
  }
  searchDebounce = setTimeout(() => runSearch(query, "local"), 140);
}

function clearSearch() {
  searchInput.value = "";
  searchClear.setAttribute("hidden", "");
  clearSearchUi();
  searchInput.focus();
}

function clearSearchUi() {
  searchResultsEl.setAttribute("hidden", "");
  searchResultsEl.innerHTML = "";
  recentEl.removeAttribute("hidden");
  searchHint.textContent = "Press ↵ for smart search";
  lastQuery = "";
  lastMode = "local";
}

async function runSearch(rawQuery, mode) {
  const query = String(rawQuery || "").trim();
  if (!query) {
    clearSearchUi();
    return;
  }

  lastQuery = query;
  lastMode = mode;
  recentEl.setAttribute("hidden", "");
  searchResultsEl.removeAttribute("hidden");
  if (mode === "smart") {
    searchHint.textContent = "Asking gpt-5.4-mini…";
    searchResultsEl.innerHTML = renderSearchLoading();
  } else if (!searchResultsEl.innerHTML) {
    searchResultsEl.innerHTML = `<p class="search-empty">Searching…</p>`;
  }

  const response = await send("SEARCH_TABS", { query, mode });
  // Discard stale responses
  if (lastQuery !== query || lastMode !== mode) return;

  if (!response.ok) {
    searchResultsEl.innerHTML = `<p class="search-empty">${escapeHtml(response.error || "Search failed.")}</p>`;
    searchHint.textContent = "Search failed";
    return;
  }

  const results = response.results || [];
  const modeUsed = response.mode || "local";
  searchHint.textContent = modeUsed === "smart"
    ? "Smart search results"
    : (response.error ? `Local results — ${response.error}` : "Press ↵ for smart search");

  if (!results.length) {
    searchResultsEl.innerHTML = `<p class="search-empty">No saved tabs match “${escapeHtml(query)}”.</p>`;
    return;
  }

  searchResultsEl.innerHTML = results.map((tab) => renderSearchResult(tab, modeUsed)).join("");
  searchResultsEl.querySelectorAll("[data-search-url]").forEach((node) => {
    node.addEventListener("click", (event) => {
      event.preventDefault();
      chrome.tabs.create({ url: node.dataset.searchUrl, active: true });
    });
  });
}

function renderSearchLoading() {
  return `<p class="search-empty">Asking gpt-5.4-mini to rerank…</p>`;
}

function renderSearchResult(tab, mode) {
  const favicon = tab.favIconUrl
    ? `<img src="${escapeAttribute(tab.favIconUrl)}" alt="">`
    : `<span>${escapeHtml((tab.domain || "?").slice(0, 1).toUpperCase())}</span>`;
  const reason = mode === "smart" && tab.smartReason
    ? `<small class="search-reason">${escapeHtml(tab.smartReason)}</small>`
    : "";
  return `
    <a class="search-result" href="${escapeAttribute(tab.url)}" data-search-url="${escapeAttribute(tab.url)}" target="_blank" rel="noreferrer">
      <span class="favicon small">${favicon}</span>
      <span class="search-main">
        <strong>${escapeHtml(tab.title || tab.url)}</strong>
        <small>${escapeHtml(tab.folderName || tab.domain || "")}</small>
        ${reason}
      </span>
    </a>
  `;
}
