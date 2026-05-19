import { faviconFallback, formatDateTime, sortSessions } from "./utils.js";

const container = document.querySelector("#sessions-container");
const statsEl = document.querySelector("#manager-stats");
const searchInput = document.querySelector("#session-search");
const importInput = document.querySelector("#import-file");

let sessions = [];

init();

async function init() {
  bindEvents();
  await refresh();
}

function bindEvents() {
  searchInput.addEventListener("input", render);
  document.querySelector("#open-options").addEventListener("click", () => send("OPEN_OPTIONS"));
  document.querySelector("#restore-everything").addEventListener("click", async () => {
    const response = await send("RESTORE_ALL_SESSIONS");
    if (!response.ok) showToast(response.error, "error");
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
  document.querySelector("#export-sessions").addEventListener("click", exportSessions);
  document.querySelector("#import-sessions").addEventListener("click", () => importInput.click());
  importInput.addEventListener("change", importSessions);

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
}

function render() {
  const query = searchInput.value.trim().toLowerCase();
  const visible = query ? sessions.filter((session) => matchesQuery(session, query)) : sessions;
  const tabCount = sessions.reduce((sum, session) => sum + (session.tabs?.length || 0), 0);
  statsEl.textContent = `${sessions.length} session${sessions.length === 1 ? "" : "s"} · ${tabCount} saved tab${tabCount === 1 ? "" : "s"}`;

  if (!visible.length) {
    container.innerHTML = emptyState(query ? "No sessions match your search." : "No sessions saved yet.");
    return;
  }

  const highlightedId = decodeURIComponent(location.hash.replace(/^#/, ""));
  container.innerHTML = visible.map((session) => renderSession(session, highlightedId)).join("");
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
          <button class="icon-button hover-only" data-action="recategorize" data-session-id="${escapeHtml(session.id)}" type="button" title="Re-run grouping" aria-label="Recategorize">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 12a9 9 0 0 1 15.7-6"></path><path d="M21 4v5h-5"></path><path d="M21 12a9 9 0 0 1-15.7 6"></path><path d="M3 20v-5h5"></path></svg>
          </button>
          <button class="icon-button hover-only danger" data-action="delete-session" data-session-id="${escapeHtml(session.id)}" type="button" title="Delete session" aria-label="Delete session">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 7h12"></path><path d="M9 7V5h6v2"></path><path d="M9 11v6"></path><path d="M15 11v6"></path><path d="M8 7l1 13h6l1-13"></path></svg>
          </button>
        </div>
      </header>
      ${session.categorization?.error ? `<p class="warning-line">${escapeHtml(session.categorization.error)}</p>` : ""}
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

function matchesQuery(session, query) {
  const haystack = [
    session.title,
    ...(session.categories || []).flatMap((category) => [category.name, category.description, ...(category.signals || []), ...(category.relatedGroupNames || [])]),
    ...(session.tabs || []).flatMap((tab) => [tab.title, tab.url, tab.domain])
  ].join(" ").toLowerCase();
  return haystack.includes(query);
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
