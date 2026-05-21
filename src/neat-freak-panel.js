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
    </style>
    <div class="card" role="status" aria-live="polite" id="card">
      <button class="close" data-action="dismiss" aria-label="Dismiss" type="button">&times;</button>
      <div class="row">
        <img class="mascot" id="mascot" src="" alt="" aria-hidden="true">
        <div class="body">
          <p class="title" id="title">Loading…</p>
          <p class="sub" id="sub"></p>
        </div>
      </div>
      <div class="actions" id="actions"></div>
    </div>
  `;
}

function applyState(host, state) {
  const shadow = host.shadowRoot;
  if (!shadow) return;

  if (!state || state.mode === "hidden") {
    cancelAutoDismiss();
    dismissPanel(host);
    return;
  }

  const card = shadow.getElementById("card");
  card.classList.remove("leaving");
  card.className = `card state-${state.mode}`;

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
    scheduleAutoDismiss(host);
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
    scheduleAutoDismiss(host);
    return;
  }
}

function setMascot(imgEl, url) {
  if (imgEl.src !== url) imgEl.src = url;
}

function handlePanelClick(host, event) {
  const target = event.target;
  const action = target instanceof HTMLElement ? target.dataset.action : "";
  if (!action) return;
  if (action === "dismiss") {
    cancelAutoDismiss();
    chrome.runtime.sendMessage({ type: "PANEL_DISMISS" }).catch(() => undefined);
    dismissPanel(host);
  } else if (action === "tidy") {
    cancelAutoDismiss();
    chrome.runtime.sendMessage({ type: "PANEL_TIDY_NOW" }).catch(() => undefined);
    // Don't dismiss — background will transition us to saving → done.
  } else if (action === "open-manager") {
    cancelAutoDismiss();
    const sessionId = target.dataset.sessionId || "";
    chrome.runtime.sendMessage({ type: "PANEL_OPEN_MANAGER", sessionId }).catch(() => undefined);
    dismissPanel(host);
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
