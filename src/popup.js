import { formatDateTime } from "./utils.js";

const summaryEl = document.querySelector("#open-tab-summary");
const recentEl = document.querySelector("#recent-sessions");
const statusEl = document.querySelector("#status-line");
const saveButton = document.querySelector("#save-tabs");
const saveModeCopy = document.querySelector("#save-mode-copy");
const reviewInput = document.querySelector("#review-before-close");
const pinnedInput = document.querySelector("#include-pinned");
const scopeButtons = [...document.querySelectorAll("[data-scope]")];
const defaultStateEl = document.querySelector("#default-state");
const progressEl = document.querySelector("#save-progress");
const progressStepEls = [...progressEl.querySelectorAll("[data-step]")];
const progressHintEl = progressEl.querySelector(".progress-hint");
const doneEl = document.querySelector("#save-done");
const doneTitleEl = document.querySelector("#done-title");
const doneSubtitleEl = document.querySelector("#done-subtitle");
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
const controlsEl = document.querySelector("#popup-controls");

let selectedScope = "allWindows";
let lastResultSessionId = "";
let searchDebounce = null;
let lastQuery = "";
let lastMode = "local";

init();

async function init() {
  bindEvents();
  await refresh();
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
  reviewInput.addEventListener("change", updateSaveModeCopy);
  saveButton.addEventListener("click", saveTabs);
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
  scopeButtons.forEach((button) => button.classList.toggle("active", button.dataset.scope === selectedScope));
  renderPreview(preview);
  updateSaveModeCopy();
  renderRecentSessions(sessions || []);
  setStatus(settings.apiKey ? "LLM grouping is ready." : "Add an API key in settings for LLM grouping.");
}

async function refreshPreview() {
  const response = await send("PREVIEW_TABS", {
    options: {
      includePinned: pinnedInput.checked,
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
      reviewBeforeClose: reviewInput.checked,
      scope: selectedScope,
      openManager: false
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
  const folders = categories.filter((c) => (c.tabIds || []).length >= 2).length;
  const loose = categories.filter((c) => (c.tabIds || []).length === 1).length;
  showDoneState({
    sessionId: session?.id,
    tabCount: session?.tabs?.length || 0,
    groupCount: folders,
    looseCount: loose,
    llm: session?.categorization?.method?.includes("llm")
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
}

function exitProgressState() {
  progressEl.setAttribute("hidden", "");
  doneEl.setAttribute("hidden", "");
  defaultStateEl.removeAttribute("hidden");
}

function handleProgress(message) {
  if (message.step === "done") {
    showDoneState({
      sessionId: message.sessionId,
      tabCount: message.tabCount || 0,
      groupCount: message.groupCount || 0,
      looseCount: message.looseCount || 0,
      llm: Boolean(message.llm)
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
    activeLabel.textContent = message.llm ? "Asking gpt-5-mini" : "Grouping locally";
  } else {
    activeLabel.textContent = STEP_LABELS[message.step] || message.step;
  }
}

function showDoneState({ sessionId, tabCount, groupCount, looseCount, llm }) {
  lastResultSessionId = sessionId || "";
  progressEl.setAttribute("hidden", "");
  defaultStateEl.setAttribute("hidden", "");
  doneEl.removeAttribute("hidden");

  doneTitleEl.textContent = `${tabCount} tab${tabCount === 1 ? "" : "s"} tucked away`;
  const folderText = `${groupCount} folder${groupCount === 1 ? "" : "s"}`;
  const looseText = looseCount ? ` · ${looseCount} loose` : "";
  const llmText = llm ? " · gpt-5-mini" : "";
  doneSubtitleEl.textContent = `${folderText}${looseText}${llmText}`;
}

function renderPreview(preview) {
  const count = preview?.count || 0;
  const skipped = preview?.skippedCount || 0;
  const domainText = preview?.domains?.length ? ` from ${preview.domains.join(", ")}` : "";
  summaryEl.textContent = `${count} savable tab${count === 1 ? "" : "s"}${domainText}${skipped ? `; ${skipped} skipped` : ""}`;
}

function renderRecentSessions(sessions) {
  if (!sessions.length) {
    recentEl.innerHTML = `<p class="empty-small">No saved sessions yet.</p>`;
    return;
  }

  recentEl.innerHTML = sessions.map((session) => {
    const method = session.categorization?.method?.includes("llm") ? "LLM" : session.categorization?.method?.includes("graph") ? "Graph" : "Local";
    const tabCount = session.tabs?.length || 0;
    return `
      <button class="recent-session" type="button" data-session-id="${escapeHtml(session.id)}">
        <span>
          <strong>${escapeHtml(formatDateTime(session.createdAt))}</strong>
          <small>${tabCount} tab${tabCount === 1 ? "" : "s"}</small>
        </span>
        <em>${method}</em>
      </button>
    `;
  }).join("");

  recentEl.querySelectorAll("[data-session-id]").forEach((button) => {
    button.addEventListener("click", () => send("OPEN_MANAGER", { sessionId: button.dataset.sessionId }));
  });
}

function updateSaveModeCopy() {
  saveModeCopy.textContent = reviewInput.checked
    ? "Groups first, then review before closing"
    : "Groups and closes saved tabs";
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
  controlsEl.removeAttribute("hidden");
  defaultStateEl.removeAttribute("hidden");
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
  controlsEl.setAttribute("hidden", "");
  defaultStateEl.setAttribute("hidden", "");
  searchResultsEl.removeAttribute("hidden");
  if (mode === "smart") {
    searchHint.textContent = "Asking gpt-5-mini…";
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
  return `<p class="search-empty">Asking gpt-5-mini to rerank…</p>`;
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
