// Unified floating panel. Replaces clutter-toast.js + done-toast.js with a
// single persistent element that transitions between modes in place:
//
//   clutter  →  stressed mascot, "N tabs open", amber Tidy now button
//   saving   →  stressed mascot wobbling, "Tidying your tabs", per-step sub
//   done     →  calm mascot, "N tabs tucked away", teal Open manager button
//
// State lives in chrome.storage.session.neatFreakPanelState. The panel mounts
// once per page and listens for chrome.storage.onChanged — when background
// writes a new state, the panel re-renders in place (no dismiss + re-injection
// flicker). Background re-runs this script via chrome.scripting.executeScript
// every time it sets a new state; the IIFE is idempotent — if the host element
// is already in the DOM, we just re-read state and re-render.

const HOST_ID = "__neat-freak-panel__";
const STATE_KEY = "neatFreakPanelState";
const AUTO_DISMISS_MS = 8000;
let autoDismissTimer = null;

// Phase 2B: local-only expanded-mode flag. Not stored — expansion is "the user
// is interacting with this surface right now," which is tab-local intent, not
// extension-wide state. Other tabs' panels stay collapsed even if this one's
// expanded.
let expandedMode = false;
let currentState = null;
let outsideClickHandler = null;
let selectedScope = "smart"; // initial; overwritten when settings load

(async () => {
  let host = document.getElementById(HOST_ID);
  const isNewMount = !host;

  if (isNewMount) {
    host = createPanelHost();
    document.documentElement.appendChild(host);
    bindStorageListener(host);
  }

  const state = await readState();
  applyState(host, state);
})();

async function readState() {
  try {
    const result = await chrome.storage.session.get(STATE_KEY);
    return result?.[STATE_KEY] || { mode: "hidden" };
  } catch {
    return { mode: "hidden" };
  }
}

function bindStorageListener(host) {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "session") return;
    if (!changes[STATE_KEY]) return;
    const newState = changes[STATE_KEY].newValue || { mode: "hidden" };
    applyState(host, newState);
  });
}

function createPanelHost() {
  const host = document.createElement("div");
  host.id = HOST_ID;
  host.style.cssText = [
    "all: initial",
    "position: fixed",
    "top: 16px",
    "right: 16px",
    "z-index: 2147483647",
    "color-scheme: light"
  ].join("; ");
  const shadow = host.attachShadow({ mode: "open" });
  shadow.innerHTML = panelMarkup();
  shadow.addEventListener("click", (event) => handlePanelClick(host, event));
  return host;
}

function panelMarkup() {
  // The full CSS is inlined into the shadow root. Inherits the visual language
  // refined in the previous clutter-toast.js iteration — cream card, amber top
  // bar, free-standing mascot with teal drop-shadow.
  return `
    <style>
      :host { all: initial; }
      .card {
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", sans-serif;
        position: relative;
        width: min(340px, calc(100vw - 32px));
        background: #fdfcf8;
        color: #1a2421;
        border: 1px solid #e8dfc7;
        border-radius: 14px;
        box-shadow: 0 18px 40px -6px rgba(15, 118, 110, 0.22), 0 4px 12px rgba(0, 0, 0, 0.08);
        padding: 16px 16px 14px;
        overflow: hidden;
        animation: slidein 0.28s cubic-bezier(0.2, 0.9, 0.3, 1.2);
      }
      .card::before {
        content: "";
        position: absolute;
        top: 0; left: 0; right: 0;
        height: 3px;
        background: linear-gradient(90deg, var(--bar-from, #f4bd45) 0%, var(--bar-from, #f4bd45) 60%, var(--bar-to, #f6cd6d) 100%);
        transition: background 280ms ease;
      }
      .card.state-done {
        --bar-from: #0f766e;
        --bar-to: #14b8a6;
      }

      @keyframes slidein {
        from { transform: translateX(380px); opacity: 0; }
        to   { transform: translateX(0);     opacity: 1; }
      }
      @keyframes slideout {
        from { transform: translateX(0);     opacity: 1; }
        to   { transform: translateX(380px); opacity: 0; }
      }
      @keyframes mascot-tilt {
        0%, 100% { transform: rotate(-3deg); }
        50%      { transform: rotate(3deg); }
      }
      @keyframes mascot-organize {
        0%   { transform: rotate(-6deg) translateY(0); }
        25%  { transform: rotate(4deg)  translateY(-1px); }
        50%  { transform: rotate(-2deg) translateY(0); }
        75%  { transform: rotate(6deg)  translateY(-1px); }
        100% { transform: rotate(-6deg) translateY(0); }
      }
      @keyframes mascot-settle {
        0%   { transform: scale(0.92); }
        60%  { transform: scale(1.05); }
        100% { transform: scale(1); }
      }
      .card.leaving { animation: slideout 0.2s ease-in forwards; }

      .row { display: flex; gap: 14px; align-items: flex-start; }

      .mascot {
        width: 60px;
        height: 60px;
        flex-shrink: 0;
        margin-top: 2px;
        filter: drop-shadow(0 2px 4px rgba(15, 118, 110, 0.18));
        transform-origin: 50% 90%;
      }
      .card.state-clutter .mascot {
        animation: mascot-tilt 2.4s ease-in-out 0.3s 2;
      }
      .card.state-saving .mascot {
        animation: mascot-organize 1.05s ease-in-out infinite;
      }
      .card.state-done .mascot {
        animation: mascot-settle 0.4s ease-out;
      }

      .body { flex: 1; min-width: 0; padding-top: 4px; }
      .title { font-size: 14px; font-weight: 600; line-height: 1.25; margin: 0 0 2px; color: #1a2421; }
      .sub { font-size: 13px; color: #4a5651; margin: 0; line-height: 1.4; display: flex; align-items: center; gap: 6px; }

      .progress-dots { display: inline-flex; gap: 4px; }
      .progress-dots span {
        width: 4px; height: 4px;
        border-radius: 50%;
        background: #4a5651;
        animation: dot 1.2s ease-in-out infinite;
      }
      .progress-dots span:nth-child(2) { animation-delay: 0.18s; }
      .progress-dots span:nth-child(3) { animation-delay: 0.36s; }
      @keyframes dot {
        0%, 80%, 100% { opacity: 0.2; }
        40%           { opacity: 1;   }
      }

      .close {
        position: absolute;
        top: 8px; right: 8px;
        cursor: pointer;
        background: transparent;
        border: 0;
        color: #8a948f;
        font-size: 16px;
        line-height: 1;
        width: 24px; height: 24px;
        display: flex; align-items: center; justify-content: center;
        border-radius: 6px;
        padding: 0;
        font-family: inherit;
      }
      .close:hover { color: #1a2421; background: rgba(26, 36, 33, 0.06); }
      .close:focus-visible { outline: 2px solid #f4bd45; outline-offset: 1px; }

      .actions {
        display: flex;
        align-items: center;
        justify-content: flex-end;
        gap: 8px;
        margin-top: 12px;
        padding-top: 10px;
        border-top: 1px dashed #e8dfc7;
      }

      .primary {
        cursor: pointer;
        background: var(--primary-bg, #f4bd45);
        color: var(--primary-fg, #1a2421);
        border: 0;
        padding: 9px 16px;
        border-radius: 8px;
        font-size: 13px;
        font-weight: 700;
        font-family: inherit;
        letter-spacing: 0.01em;
        box-shadow: 0 1px 0 rgba(146, 95, 0, 0.18), inset 0 -1px 0 rgba(146, 95, 0, 0.18);
        transition: transform 0.08s ease, background 0.12s ease, box-shadow 0.12s ease, opacity 0.12s ease;
      }
      .primary:hover { background: var(--primary-bg-hover, #ecb02d); }
      .primary:active { transform: translateY(1px); }
      .primary:focus-visible { outline: 2px solid #0f766e; outline-offset: 2px; }
      .primary[disabled] {
        cursor: default;
        opacity: 0.6;
        transform: none;
      }
      .primary[disabled]:hover { background: var(--primary-bg, #f4bd45); }

      .card.state-done .primary {
        --primary-bg: #0f766e;
        --primary-fg: #ffffff;
        --primary-bg-hover: #115e59;
        box-shadow: 0 1px 0 rgba(7, 60, 56, 0.22), inset 0 -1px 0 rgba(7, 60, 56, 0.22);
      }

      /* ========== Expanded view ========== */

      .row[data-clickable-body="true"] { cursor: pointer; }
      .card.expanded .row[data-clickable-body="true"] { cursor: default; }

      .card.expanded {
        width: min(420px, calc(100vw - 32px));
        transition: width 200ms ease;
      }
      .card.expanded .actions {
        /* The primary action belongs in the expanded content (Tidy my tabs).
           Hide the collapsed-state action button to avoid two save buttons. */
        display: none;
      }

      .eyebrow {
        font-size: 9px;
        font-weight: 700;
        letter-spacing: 0.18em;
        color: #8a948f;
        margin: 0 0 4px;
        text-transform: uppercase;
      }

      .expanded-content {
        margin-top: 14px;
        padding-top: 14px;
        border-top: 1px dashed #e8dfc7;
        display: flex;
        flex-direction: column;
        gap: 14px;
        max-height: 60vh;
        overflow-y: auto;
        /* Subtle entrance */
        animation: fadein 180ms ease-out;
      }
      @keyframes fadein {
        from { opacity: 0; transform: translateY(-4px); }
        to   { opacity: 1; transform: translateY(0); }
      }

      .scope-picker {
        display: inline-flex;
        gap: 4px;
        padding: 3px;
        background: #f2eedf;
        border-radius: 10px;
      }
      .scope-button {
        flex: 1;
        cursor: pointer;
        background: transparent;
        color: #4a5651;
        border: 0;
        padding: 7px 12px;
        border-radius: 7px;
        font-size: 12px;
        font-weight: 600;
        font-family: inherit;
        transition: background 120ms ease, color 120ms ease;
      }
      .scope-button:hover { color: #1a2421; }
      .scope-button.active {
        background: #ffffff;
        color: #1a2421;
        box-shadow: 0 1px 2px rgba(0, 0, 0, 0.08);
      }

      .preview-line {
        font-size: 13px;
        color: #4a5651;
        margin: 0;
      }

      .tidy-cta {
        cursor: pointer;
        width: 100%;
        background: #0f766e;
        color: #ffffff;
        border: 0;
        padding: 11px 16px;
        border-radius: 10px;
        font-size: 14px;
        font-weight: 700;
        font-family: inherit;
        box-shadow: 0 2px 0 rgba(7, 60, 56, 0.22), inset 0 -1px 0 rgba(7, 60, 56, 0.22);
        transition: background 120ms ease, transform 0.08s ease;
      }
      .tidy-cta:hover { background: #115e59; }
      .tidy-cta:active { transform: translateY(1px); }
      .tidy-cta:disabled { opacity: 0.6; cursor: default; }

      .more-options {
        font-size: 12px;
        color: #4a5651;
      }
      .more-options summary {
        cursor: pointer;
        list-style: none;
        font-weight: 600;
        padding: 4px 0;
        user-select: none;
      }
      .more-options summary::-webkit-details-marker { display: none; }
      .more-options summary::before {
        content: "▸ ";
        font-size: 10px;
        margin-right: 4px;
        transition: transform 120ms ease;
        display: inline-block;
      }
      .more-options[open] summary::before { content: "▾ "; }
      .check-row {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 4px 0;
        cursor: pointer;
        font-weight: 400;
        color: #1a2421;
      }
      .check-row input { margin: 0; }

      .sessions-section { display: flex; flex-direction: column; gap: 8px; }
      .sessions-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
      }
      .sessions-header h3 {
        font-size: 11px;
        font-weight: 700;
        letter-spacing: 0.12em;
        color: #8a948f;
        margin: 0;
        text-transform: uppercase;
      }
      .link-button {
        background: transparent;
        border: 0;
        color: #0f766e;
        font-size: 11px;
        font-weight: 600;
        font-family: inherit;
        cursor: pointer;
        padding: 2px 4px;
      }
      .link-button:hover { text-decoration: underline; }
      .session-list { display: flex; flex-direction: column; gap: 6px; }
      .session-card {
        background: #ffffff;
        border: 1px solid #e8dfc7;
        border-radius: 10px;
        padding: 10px 12px;
        display: flex;
        flex-direction: column;
        gap: 4px;
      }
      .session-card-row {
        display: flex;
        align-items: baseline;
        justify-content: space-between;
        gap: 8px;
      }
      .session-card-title {
        font-size: 13px;
        font-weight: 600;
        color: #1a2421;
        margin: 0;
      }
      .session-card-meta {
        font-size: 11px;
        color: #8a948f;
      }
      .session-card-folders {
        font-size: 12px;
        color: #4a5651;
        line-height: 1.4;
      }
      .session-restore {
        align-self: flex-start;
        margin-top: 4px;
        cursor: pointer;
        background: transparent;
        border: 1px solid #d9e0dc;
        color: #1a2421;
        padding: 4px 10px;
        border-radius: 6px;
        font-size: 11px;
        font-weight: 600;
        font-family: inherit;
      }
      .session-restore:hover { background: #f6f3e8; }

      .session-empty {
        font-size: 12px;
        color: #8a948f;
        font-style: italic;
        padding: 8px 4px;
      }
    </style>
    <div class="card" role="status" aria-live="polite" id="card">
      <button class="close" data-action="dismiss" aria-label="Dismiss" type="button">&times;</button>
      <div class="row" data-clickable-body="true">
        <img class="mascot" id="mascot" src="" alt="" aria-hidden="true">
        <div class="body">
          <p class="eyebrow" id="eyebrow" hidden>NEAT FREAK</p>
          <p class="title" id="title">Loading…</p>
          <p class="sub" id="sub"></p>
        </div>
      </div>
      <div class="actions" id="actions"></div>

      <!-- Expanded-only content. Hidden until the user clicks the body. -->
      <div class="expanded-content" id="expanded-content" hidden>
        <div class="scope-picker" id="scope-picker">
          <button class="scope-button" data-scope="smart" type="button">Smart</button>
          <button class="scope-button" data-scope="allWindows" type="button">All windows</button>
          <button class="scope-button" data-scope="currentWindow" type="button">Current</button>
        </div>
        <p class="preview-line" id="preview-line">Loading preview…</p>
        <button class="tidy-cta" data-action="tidy-expanded" type="button">Tidy my tabs</button>

        <details class="more-options">
          <summary>More options</summary>
          <label class="check-row">
            <input type="checkbox" id="opt-include-pinned"> <span>Include pinned tabs</span>
          </label>
          <label class="check-row">
            <input type="checkbox" id="opt-keep-current"> <span>Keep current tab open</span>
          </label>
          <label class="check-row">
            <input type="checkbox" id="opt-review"> <span>Review before closing</span>
          </label>
        </details>

        <section class="sessions-section">
          <header class="sessions-header">
            <h3 id="sessions-heading">Recent sessions</h3>
            <button class="link-button" data-action="open-manager-link" type="button">Open manager →</button>
          </header>
          <div class="session-list" id="session-list"></div>
        </section>
      </div>
    </div>
  `;
}

function applyState(host, state) {
  const shadow = host.shadowRoot;
  if (!shadow) return;
  currentState = state;

  if (!state || state.mode === "hidden") {
    cancelAutoDismiss();
    expandedMode = false;
    unbindOutsideClickHandler();
    dismissPanel(host);
    return;
  }

  const card = shadow.getElementById("card");
  card.classList.remove("leaving");
  // Preserve the .expanded class through state transitions so a user mid-expansion
  // doesn't get yanked back to collapsed when, say, saving completes → done.
  const wasExpanded = card.classList.contains("expanded");
  card.className = `card state-${state.mode}${wasExpanded ? " expanded" : ""}`;

  // Saving state is transient and we don't want the user expanding into a
  // half-loaded view; force collapse if we end up there.
  if (state.mode === "saving" && expandedMode) {
    collapseExpansion(host, { restartAutoDismiss: false });
  }

  // Show the eyebrow only when expanded — it identifies the panel as Neat Freak
  // since the card is integrated into the page rather than chrome-managed.
  const eyebrowEl = shadow.getElementById("eyebrow");
  if (eyebrowEl) eyebrowEl.hidden = !expandedMode;

  const titleEl = shadow.getElementById("title");
  const subEl = shadow.getElementById("sub");
  const mascotEl = shadow.getElementById("mascot");
  const actionsEl = shadow.getElementById("actions");

  const calmUrl = chrome.runtime.getURL("assets/mascot-calm.svg");
  const stressedUrl = chrome.runtime.getURL("assets/mascot-stressed-128.png");

  cancelAutoDismiss();

  if (state.mode === "clutter") {
    setMascot(mascotEl, stressedUrl);
    const count = Number(state.tabCount) || 0;
    titleEl.textContent = `${count} tabs open`;
    subEl.textContent = "Want me to tidy up?";
    actionsEl.innerHTML = `<button class="primary" data-action="tidy" type="button">Tidy now</button>`;
    // Only auto-dismiss when collapsed. If the user has explicitly expanded,
    // they're interacting — don't pull the rug out.
    if (!expandedMode) scheduleAutoDismiss(host);
    return;
  }

  if (state.mode === "saving") {
    setMascot(mascotEl, stressedUrl);
    titleEl.textContent = "Tidying your tabs";
    const label = (state.label && String(state.label)) || "Organizing";
    subEl.innerHTML = `${escapeText(label)}<span class="progress-dots"><span></span><span></span><span></span></span>`;
    actionsEl.innerHTML = `<button class="primary" disabled type="button">Working…</button>`;
    // Saving doesn't auto-dismiss — completion transitions us to done.
    return;
  }

  if (state.mode === "done") {
    setMascot(mascotEl, calmUrl);
    const tabCount = Number(state.tabCount) || 0;
    titleEl.textContent = `${tabCount} tab${tabCount === 1 ? "" : "s"} tucked away`;
    const parts = [];
    if (state.groupCount) parts.push(`${state.groupCount} folder${state.groupCount === 1 ? "" : "s"}`);
    if (state.looseCount) parts.push(`${state.looseCount} loose`);
    if (state.keepCount)  parts.push(`${state.keepCount} kept open`);
    subEl.textContent = parts.join(" · ") || "Ready in your saved sessions.";
    const sid = String(state.sessionId || "");
    actionsEl.innerHTML = `<button class="primary" data-action="open-manager" data-session-id="${escapeAttr(sid)}" type="button">Open manager</button>`;
    if (!expandedMode) scheduleAutoDismiss(host);
    // If we entered done while expanded (e.g. user expanded mid-save), refresh
    // the recent-sessions list so the just-saved session appears.
    if (expandedMode) loadExpandedData(host);
    return;
  }
}

function setMascot(imgEl, url) {
  if (imgEl.src !== url) imgEl.src = url;
}

function handlePanelClick(host, event) {
  const target = event.target;
  const elTarget = target instanceof HTMLElement ? target : null;
  const action = elTarget?.dataset?.action || "";

  // No action attribute — check if the body was clicked to trigger expand.
  if (!action) {
    if (!expandedMode && elTarget && elTarget.closest("[data-clickable-body]")) {
      // Saving state shouldn't expand — it's transient.
      if (currentState && currentState.mode !== "saving" && currentState.mode !== "hidden") {
        expandPanel(host);
      }
    }
    return;
  }

  // Collapsed action buttons
  if (action === "dismiss") {
    cancelAutoDismiss();
    chrome.runtime.sendMessage({ type: "PANEL_DISMISS" }).catch(() => undefined);
    dismissPanel(host);
    return;
  }
  if (action === "tidy") {
    cancelAutoDismiss();
    chrome.runtime.sendMessage({ type: "PANEL_TIDY_NOW" }).catch(() => undefined);
    return;
  }
  if (action === "open-manager") {
    cancelAutoDismiss();
    const sessionId = elTarget.dataset.sessionId || "";
    chrome.runtime.sendMessage({ type: "PANEL_OPEN_MANAGER", sessionId }).catch(() => undefined);
    dismissPanel(host);
    return;
  }

  // Expanded-view actions
  if (action === "scope") {
    const newScope = elTarget.dataset.scopeValue;
    if (newScope) {
      selectedScope = newScope;
      updateScopeButtons(host);
      refreshPreview(host);
    }
    return;
  }
  if (action === "tidy-expanded") {
    triggerExpandedSave(host);
    return;
  }
  if (action === "open-manager-link") {
    chrome.runtime.sendMessage({ type: "PANEL_OPEN_MANAGER" }).catch(() => undefined);
    return;
  }
  if (action === "restore-session") {
    const sessionId = elTarget.dataset.sessionId || "";
    chrome.runtime.sendMessage({ type: "RESTORE_SESSION", sessionId }).catch(() => undefined);
    return;
  }
}

// ========== Expanded view logic ==========

function expandPanel(host) {
  expandedMode = true;
  cancelAutoDismiss();
  const shadow = host.shadowRoot;
  const card = shadow.getElementById("card");
  card.classList.add("expanded");
  shadow.getElementById("expanded-content").hidden = false;
  const eyebrowEl = shadow.getElementById("eyebrow");
  if (eyebrowEl) eyebrowEl.hidden = false;
  bindOutsideClickHandler(host);
  loadExpandedData(host);
}

function collapseExpansion(host, opts = {}) {
  if (!expandedMode) return;
  expandedMode = false;
  const shadow = host.shadowRoot;
  const card = shadow.getElementById("card");
  card.classList.remove("expanded");
  const expandedContent = shadow.getElementById("expanded-content");
  if (expandedContent) expandedContent.hidden = true;
  const eyebrowEl = shadow.getElementById("eyebrow");
  if (eyebrowEl) eyebrowEl.hidden = true;
  unbindOutsideClickHandler();
  // After collapsing, restart auto-dismiss for trigger-opened collapsed states.
  const restart = opts.restartAutoDismiss !== false;
  if (restart && currentState && (currentState.mode === "clutter" || currentState.mode === "done")) {
    scheduleAutoDismiss(host);
  }
}

function bindOutsideClickHandler(host) {
  unbindOutsideClickHandler();
  outsideClickHandler = (event) => {
    const path = event.composedPath ? event.composedPath() : [];
    if (path.includes(host)) return; // click inside the panel
    collapseExpansion(host);
  };
  // Use capture so we beat page handlers that might stop propagation.
  document.addEventListener("click", outsideClickHandler, true);
}

function unbindOutsideClickHandler() {
  if (!outsideClickHandler) return;
  document.removeEventListener("click", outsideClickHandler, true);
  outsideClickHandler = null;
}

async function loadExpandedData(host) {
  try {
    const response = await chrome.runtime.sendMessage({ type: "GET_POPUP_STATE" });
    if (!response?.ok) return;
    // Initial selectedScope from user's default
    if (response.settings?.defaultScope) {
      selectedScope = response.settings.defaultScope;
    }
    renderScopePicker(host);
    renderPreview(host, response.preview);
    renderMoreOptions(host, response.settings);
    renderSessions(host, response.sessions || []);
  } catch (err) {
    console.warn("[Neat Freak] Load expanded data failed:", err?.message || err);
  }
}

function renderScopePicker(host) {
  const shadow = host.shadowRoot;
  const picker = shadow.getElementById("scope-picker");
  if (!picker) return;
  // Re-render with data-action wired (the static markup doesn't have it yet)
  picker.innerHTML = `
    <button class="scope-button${selectedScope === "smart" ? " active" : ""}" data-action="scope" data-scope-value="smart" type="button">Smart</button>
    <button class="scope-button${selectedScope === "allWindows" ? " active" : ""}" data-action="scope" data-scope-value="allWindows" type="button">All windows</button>
    <button class="scope-button${selectedScope === "currentWindow" ? " active" : ""}" data-action="scope" data-scope-value="currentWindow" type="button">Current</button>
  `;
}

function updateScopeButtons(host) {
  renderScopePicker(host);
}

function renderPreview(host, preview) {
  const shadow = host.shadowRoot;
  const el = shadow.getElementById("preview-line");
  if (!el) return;
  const count = Number(preview?.count) || 0;
  const domains = Array.isArray(preview?.domains) ? preview.domains : [];
  if (!count) {
    el.textContent = "No savable tabs.";
    return;
  }
  const domainText = domains.length
    ? ` across ${domains.length} domain${domains.length === 1 ? "" : "s"}`
    : "";
  el.textContent = `${count} tab${count === 1 ? "" : "s"}${domainText}.`;
}

function renderMoreOptions(host, settings) {
  const shadow = host.shadowRoot;
  const includePinned = shadow.getElementById("opt-include-pinned");
  const keepCurrent = shadow.getElementById("opt-keep-current");
  const review = shadow.getElementById("opt-review");
  if (includePinned) includePinned.checked = Boolean(settings?.defaultIncludePinned);
  if (keepCurrent) keepCurrent.checked = settings?.defaultKeepCurrentTab !== false;
  if (review) review.checked = Boolean(settings?.defaultReviewBeforeClose);
}

function renderSessions(host, sessions) {
  const shadow = host.shadowRoot;
  const list = shadow.getElementById("session-list");
  if (!list) return;
  if (!sessions.length) {
    list.innerHTML = `<p class="session-empty">No saved sessions yet. Hit "Tidy my tabs" to make your first one.</p>`;
    return;
  }
  list.innerHTML = sessions.slice(0, 3).map((session) => {
    const tabCount = session.tabs?.length || 0;
    const cats = (session.categories || []).filter((c) => (c.tabIds || []).length >= 2);
    const folderSummary = cats.length
      ? cats.slice(0, 3).map((c) => escapeText(c.name || "Folder")).join(" · ")
      : "Single tabs";
    const when = formatRelativeTime(session.createdAt);
    return `
      <div class="session-card">
        <div class="session-card-row">
          <p class="session-card-title">${tabCount} tab${tabCount === 1 ? "" : "s"}</p>
          <span class="session-card-meta">${escapeText(when)}</span>
        </div>
        <div class="session-card-folders">${folderSummary}</div>
        <button class="session-restore" data-action="restore-session" data-session-id="${escapeAttr(session.id)}" type="button">Reopen all</button>
      </div>
    `;
  }).join("");
}

function formatRelativeTime(iso) {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  const diffSec = Math.floor((Date.now() - t) / 1000);
  if (diffSec < 60) return "just now";
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`;
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h ago`;
  return `${Math.floor(diffSec / 86400)}d ago`;
}

async function refreshPreview(host) {
  try {
    const includePinned = host.shadowRoot.getElementById("opt-include-pinned")?.checked || false;
    const keepCurrentTab = host.shadowRoot.getElementById("opt-keep-current")?.checked !== false;
    const response = await chrome.runtime.sendMessage({
      type: "PREVIEW_TABS",
      options: { scope: selectedScope, includePinned, keepCurrentTab }
    });
    if (response?.ok) renderPreview(host, response.preview);
  } catch {
    // Best-effort.
  }
}

async function triggerExpandedSave(host) {
  const shadow = host.shadowRoot;
  const includePinned = shadow.getElementById("opt-include-pinned")?.checked || false;
  const keepCurrentTab = shadow.getElementById("opt-keep-current")?.checked !== false;
  const reviewBeforeClose = shadow.getElementById("opt-review")?.checked || false;
  // Collapse first — saving feedback lives in the collapsed state.
  collapseExpansion(host, { restartAutoDismiss: false });
  try {
    await chrome.runtime.sendMessage({
      type: "SAVE_TABS",
      options: {
        scope: selectedScope,
        includePinned,
        keepCurrentTab,
        reviewBeforeClose,
        openManager: false
      }
    });
    // background.saveTabs drives the saving → done state transitions for us.
  } catch (err) {
    console.warn("[Neat Freak] Expanded save failed:", err?.message || err);
  }
}

function scheduleAutoDismiss(host) {
  cancelAutoDismiss();
  autoDismissTimer = setTimeout(() => {
    chrome.runtime.sendMessage({ type: "PANEL_DISMISS" }).catch(() => undefined);
    dismissPanel(host);
  }, AUTO_DISMISS_MS);
}

function cancelAutoDismiss() {
  if (autoDismissTimer) {
    clearTimeout(autoDismissTimer);
    autoDismissTimer = null;
  }
}

function dismissPanel(host) {
  const card = host.shadowRoot?.getElementById("card");
  if (!card) { host.remove(); return; }
  card.classList.add("leaving");
  setTimeout(() => host.remove(), 220);
}

function escapeAttr(value) {
  return String(value).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;"
  }[c]));
}

function escapeText(value) {
  return String(value).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
}
