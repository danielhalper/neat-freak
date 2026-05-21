// Unified floating panel. Replaces clutter-toast.js + done-toast.js with a
// single persistent element that transitions between modes in place:
//
//   clutter  →  stressed mascot, "N tabs open", amber Tidy now button
//   saving   →  stressed mascot wobbling, "Tidying your tabs", per-step sub
//   done     →  calm mascot, "N tabs tucked away", teal Open manager button
//
// State lives in chrome.storage.session.neatFreakPanelState. After the first
// inject on a tab, the script sets a window flag so subsequent executeScript
// calls (which background fires on every setPanelState) become no-ops; the
// storage.onChanged listener registered during first init handles all future
// state changes. Page navigation resets the isolated world, so the flag
// naturally clears and the next inject re-initializes from scratch.
//
// The whole module is wrapped in an IIFE so the const/let declarations don't
// re-declare and throw on repeated executeScript invocations.

(function neatFreakPanelInit() {
  // Per-isolated-world guard. Set on the window of the isolated world (not the
  // page); persists across executeScript calls until page navigation.
  if (window.__neatFreakPanelInitialized) return;
  window.__neatFreakPanelInitialized = true;

  const HOST_ID = "__neat-freak-panel__";
  const STATE_KEY = "neatFreakPanelState";
  const AUTO_DISMISS_MS = 8000;
  let autoDismissTimer = null;

  // Local-only expanded-mode flag. Not stored — expansion is "the user is
  // interacting with this surface right now," tab-local intent.
  let expandedMode = false;
  let currentState = null;
  let outsideClickHandler = null;
  let selectedScope = "smart";
  let lastLoadedSessions = [];

  // When the extension is reloaded (chrome://extensions Reload, version
  // bump from install, etc.), this content script becomes orphaned — its
  // chrome.* references throw "Extension context invalidated" on every
  // call. We detect this by checking chrome.runtime?.id and tear ourselves
  // down so the page isn't left with a broken panel.
  function isExtensionValid() {
    try {
      return Boolean(chrome?.runtime?.id);
    } catch {
      return false;
    }
  }

  function teardownOrphaned() {
    try {
      const host = document.getElementById(HOST_ID);
      if (host) host.remove();
    } catch { /* ignore */ }
    if (outsideClickHandler) {
      try { document.removeEventListener("click", outsideClickHandler, true); } catch { /* ignore */ }
      outsideClickHandler = null;
    }
    if (autoDismissTimer) {
      try { clearTimeout(autoDismissTimer); } catch { /* ignore */ }
      autoDismissTimer = null;
    }
    // Mark this isolated world as needing re-init in case a fresh inject
    // happens (e.g. the reloaded extension calls executeScript again).
    try { window.__neatFreakPanelInitialized = false; } catch { /* ignore */ }
  }

  // Best-effort sendMessage that swallows "Extension context invalidated"
  // failures and tears down on detection.
  function safeSendMessage(message) {
    if (!isExtensionValid()) { teardownOrphaned(); return Promise.resolve(); }
    try {
      return chrome.runtime.sendMessage(message).catch(() => {
        if (!isExtensionValid()) teardownOrphaned();
      });
    } catch {
      teardownOrphaned();
      return Promise.resolve();
    }
  }

  // Initial render and listener setup. Subsequent storage changes go through
  // the listener (not via re-injection).
  (async () => {
    // Kick off brand font load in parallel with initial render. Strict-CSP
    // pages (Google Slides, Docs, etc.) block @font-face URL loads from
    // chrome-extension:// origins, so we fetch the woff2 ourselves and
    // construct a FontFace from the binary — no font-src CSP applies.
    ensureBrandFont().catch(() => undefined);

    const state = await readState();
    bindStorageListener();
    if (state && state.mode && state.mode !== "hidden") {
      const host = ensureHost();
      applyState(host, state);
    }
  })();

  async function ensureBrandFont() {
    // Document-level guard so we only load the font once per isolated world.
    if (window.__neatFreakBrandFontLoaded) return;
    if (!isExtensionValid()) return;
    try {
      const url = chrome.runtime.getURL("assets/fonts/PermanentMarker-Regular.woff2");
      const response = await fetch(url);
      if (!response.ok) throw new Error(`status ${response.status}`);
      const buffer = await response.arrayBuffer();
      const face = new FontFace("Permanent Marker", buffer, {
        style: "normal",
        weight: "400",
        display: "swap"
      });
      await face.load();
      document.fonts.add(face);
      window.__neatFreakBrandFontLoaded = true;
    } catch (err) {
      // Falls back to the next entry in the font-family chain (Georgia, etc.).
      console.warn("[Neat Freak] Permanent Marker load failed:", err?.message || err);
    }
  }

  async function readState() {
    if (!isExtensionValid()) { teardownOrphaned(); return { mode: "hidden" }; }
    try {
      const result = await chrome.storage.session.get(STATE_KEY);
      return result?.[STATE_KEY] || { mode: "hidden" };
    } catch {
      if (!isExtensionValid()) teardownOrphaned();
      return { mode: "hidden" };
    }
  }

  function bindStorageListener() {
    chrome.storage.onChanged.addListener((changes, area) => {
      // Extension reload orphans this listener; bail out gracefully.
      if (!isExtensionValid()) { teardownOrphaned(); return; }
      if (area !== "session") return;
      if (!changes[STATE_KEY]) return;
      const newState = changes[STATE_KEY].newValue || { mode: "hidden" };
      let host = document.getElementById(HOST_ID);
      if (!host && newState.mode !== "hidden") host = ensureHost();
      if (host) applyState(host, newState);
    });
  }

  // Safe wrapper for awaited sendMessage. Returns null on failure (instead of
  // throwing) and tears down on extension invalidation.
  async function safeSendMessageAwait(message) {
    if (!isExtensionValid()) { teardownOrphaned(); return null; }
    try {
      return await chrome.runtime.sendMessage(message);
    } catch {
      if (!isExtensionValid()) teardownOrphaned();
      return null;
    }
  }

  async function safeStorageSessionSet(value) {
    if (!isExtensionValid()) { teardownOrphaned(); return false; }
    try {
      await chrome.storage.session?.set?.(value);
      return true;
    } catch {
      if (!isExtensionValid()) teardownOrphaned();
      return false;
    }
  }

  function ensureHost() {
    let host = document.getElementById(HOST_ID);
    if (!host) {
      host = createPanelHost();
      document.documentElement.appendChild(host);
    } else if (!document.documentElement.contains(host)) {
      document.documentElement.appendChild(host);
    }
    return host;
  }

function createPanelHost() {
  const host = document.createElement("div");
  host.id = HOST_ID;
  host.style.cssText = [
    "all: initial",
    "position: fixed",
    "top: 12px",
    "right: 12px", // sits close to the right edge to feel anchored to the toolbar icon
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
  //
  // Brand font (Permanent Marker) is loaded once at panel init via the
  // FontFace API (see ensureBrandFont). That adds it to document.fonts,
  // which shadow DOMs automatically inherit. No @font-face here — the
  // URL-based load would be blocked by font-src CSP on pages like Slides.
  return `
    <style>
      :host { all: initial; }
      .card {
        /* Match the popup's --font variable so the panel renders identically. */
        font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        position: relative;
        /* Single width across collapsed and expanded — the card just grows
           vertically when expanded, no horizontal morph needed. */
        width: min(360px, calc(100vw - 32px));
        background: #fdfcf8;
        color: #1a2421;
        border: 1px solid #e8dfc7;
        border-radius: 14px;
        box-shadow: 0 18px 40px -6px rgba(15, 118, 110, 0.22), 0 4px 12px rgba(0, 0, 0, 0.08);
        padding: 12px 14px 14px;
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
        top: 10px; right: 10px;
        cursor: pointer;
        background: #ffffff;
        border: 1px solid #e8dfc7;
        color: #4a5651;
        width: 26px; height: 26px;
        display: flex; align-items: center; justify-content: center;
        border-radius: 50%;
        padding: 0;
        font-family: inherit;
        box-shadow: 0 1px 2px rgba(0, 0, 0, 0.06);
        transition: color 120ms ease, border-color 120ms ease, box-shadow 120ms ease;
      }
      .close svg { width: 12px; height: 12px; display: block; }
      .close:hover {
        color: #1a2421;
        border-color: #d9ce9a;
        box-shadow: 0 2px 6px rgba(0, 0, 0, 0.10);
      }
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

      /* .card.expanded no longer overrides width — collapsed and expanded
         share the same horizontal footprint. Height grows naturally via the
         expanded-content section. */
      /* When expanded, the brand header inside .expanded-content takes over the
         "what is this" cue, and the Tidy CTA replaces the collapsed action
         button. Hide both collapsed-view bits so they don't stack on top of
         the expanded layout. */
      .card.expanded .row,
      .card.expanded .actions {
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
        /* No top divider needed — the collapsed view (.row + .actions) is
           hidden when expanded, so there's nothing to divide from. */
        display: flex;
        flex-direction: column;
        gap: 14px;
        max-height: 60vh;
        overflow-y: auto;
        animation: fadein 180ms ease-out;
      }
      /* Class rule above is more specific than UA [hidden] — explicit override
         needed, otherwise the section never actually hides when toggled. */
      .expanded-content[hidden] { display: none; }
      @keyframes fadein {
        from { opacity: 0; transform: translateY(-4px); }
        to   { opacity: 1; transform: translateY(0); }
      }

      /* Scope picker — pill container with rounded segmented buttons,
         white-filled active state. Matches the popup's compact variant. */
      .scope-picker {
        background: #eef4f2;
        border: 1px solid #d3ded9;
        border-radius: 999px;
        display: inline-flex;
        gap: 2px;
        padding: 2px;
        flex-shrink: 0;
      }
      .scope-button {
        flex: 0 0 auto;
        cursor: pointer;
        background: transparent;
        color: #63706b;
        border: 0;
        border-radius: 999px;
        padding: 0 14px;
        height: 28px;            /* container's 2px padding × 2 + 28 = 32px total */
        font-size: 12px;
        font-weight: 650;
        font-family: inherit;
        white-space: nowrap;
        transition: background 120ms ease, color 120ms ease;
      }
      .scope-button:hover { color: #17201d; }
      .scope-button.active {
        background: #ffffff;
        color: #17201d;
        box-shadow: 0 1px 4px rgba(23, 32, 29, 0.08);
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

      /* Pinned (just-saved) session — subtle teal accent so it's the obvious
         "this is what just happened" target. */
      .session-card.pinned-saved {
        border-color: #b9e3df;
        background: #f0faf8;
        box-shadow: inset 3px 0 0 #0f766e;
      }
      .session-pin-label {
        font-size: 9px;
        font-weight: 700;
        letter-spacing: 0.12em;
        color: #0f766e;
        text-transform: uppercase;
      }

      .session-card-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        cursor: pointer;
        user-select: none;
      }
      .session-card[data-session-expanded="false"] .folder-list { display: none; }
      .folder-tab.singleton {
        background: rgba(0, 0, 0, 0.02);
      }
      /* Top-level recent singleton row — sibling of folder-row, needs the
         same chrome (rounded background + padding) since it's not nested. */
      .folder-tab.recent-singleton {
        background: rgba(0, 0, 0, 0.02);
        padding: 8px 10px;
        border-radius: 8px;
        gap: 8px;
      }
      .folder-tab.recent-singleton:hover { background: rgba(0, 0, 0, 0.05); }
      .folder-tab.recent-singleton .folder-tab-favicon {
        width: 16px; height: 16px;
      }
      .session-card-header-text {
        display: flex;
        flex-direction: column;
        gap: 2px;
        min-width: 0;
      }
      .session-card-meta-row {
        display: flex;
        gap: 6px;
        align-items: baseline;
      }
      .session-open-all {
        background: transparent;
        border: 1px solid #d9e0dc;
        color: #1a2421;
        padding: 4px 10px;
        border-radius: 6px;
        font-size: 11px;
        font-weight: 600;
        font-family: inherit;
        cursor: pointer;
        flex-shrink: 0;
      }
      .session-open-all:hover { background: #f6f3e8; }
      .session-card.pinned-saved .session-open-all {
        border-color: #0f766e;
        color: #0f766e;
      }
      .session-card.pinned-saved .session-open-all:hover {
        background: #e0f2ef;
      }

      .folder-list { display: flex; flex-direction: column; gap: 4px; margin-top: 6px; }
      .folder-row {
        border-radius: 8px;
        background: rgba(0, 0, 0, 0.02);
        transition: background 120ms ease;
      }
      .folder-row:hover { background: rgba(0, 0, 0, 0.04); }
      .folder-summary {
        display: flex;
        align-items: center;
        gap: 6px;
        padding: 6px 8px;
        cursor: pointer;
        user-select: none;
      }
      .folder-disclosure {
        font-size: 10px;
        color: #8a948f;
        transition: transform 140ms ease;
        width: 10px;
        display: inline-block;
      }
      .folder-row[data-folder-expanded="true"] .folder-disclosure {
        transform: rotate(90deg);
      }
      .folder-name {
        flex: 1;
        font-size: 12px;
        font-weight: 600;
        color: #1a2421;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        min-width: 0;
      }
      .folder-count {
        font-size: 10px;
        color: #8a948f;
        font-variant-numeric: tabular-nums;
        background: rgba(0, 0, 0, 0.05);
        padding: 1px 6px;
        border-radius: 99px;
      }
      .folder-open-all {
        background: transparent;
        border: 0;
        color: #0f766e;
        font-size: 11px;
        font-weight: 600;
        font-family: inherit;
        cursor: pointer;
        padding: 2px 4px;
      }
      .folder-open-all:hover { text-decoration: underline; }

      .folder-tabs {
        display: none;
        list-style: none;
        margin: 0;
        padding: 4px 8px 8px 24px;
        gap: 2px;
        flex-direction: column;
      }
      .folder-row[data-folder-expanded="true"] .folder-tabs { display: flex; }
      .folder-tab {
        display: flex;
        align-items: center;
        gap: 6px;
        padding: 4px 6px;
        border-radius: 5px;
        cursor: pointer;
        background: transparent;
        border: 0;
        font-family: inherit;
        text-align: left;
        width: 100%;
        color: #1a2421;
        font-size: 12px;
        line-height: 1.3;
      }
      .folder-tab:hover { background: #ffffff; }
      .folder-tab-favicon {
        width: 14px;
        height: 14px;
        flex-shrink: 0;
        border-radius: 3px;
        background: #e8dfc7;
      }
      .folder-tab-title {
        flex: 1;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        min-width: 0;
      }

      .singletons-line {
        font-size: 11px;
        color: #8a948f;
        padding: 4px 8px;
        font-style: italic;
      }

      /* ========== Expanded view: brand header & layout ========== */
      .exp-header {
        display: flex;
        align-items: center;
        gap: 10px;
      }
      .exp-brand-mascot {
        width: 32px;
        height: 32px;
        flex-shrink: 0;
        display: inline-flex;
        align-items: center;
        justify-content: center;
      }
      .exp-brand-mascot svg {
        width: 100%;
        height: 100%;
        border-radius: 7px;
        display: block;
      }
      .exp-wordmark {
        margin: 0;
        font-size: 24px;
        font-weight: 400;
        font-family: "Permanent Marker", Georgia, "Times New Roman", serif;
        letter-spacing: 0.01em;
        line-height: 1.0;
        flex: 1;
        color: #1a2421;
      }
      .exp-wordmark span:first-child {
        display: inline-block;
        transform: rotate(-1.5deg);
      }
      .exp-wordmark-accent {
        color: #f4bd45;
        display: inline-block;
        transform: rotate(1deg) translateY(1px);
      }
      .exp-icon-btn {
        background: transparent;
        border: 1px solid #e8dfc7;
        color: #4a5651;
        width: 32px;
        height: 32px;
        border-radius: 8px;
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        font-family: inherit;
      }
      .exp-icon-btn:hover { background: #f6f3e8; color: #1a2421; }

      .exp-tagline {
        margin: 0;
        font-size: 13px;
        color: #4a5651;
        line-height: 1.4;
      }

      /* Scope picker on the left grows naturally; More options sits on the
         right and never shrinks. Removed justify-content: space-between in
         favor of gap + auto margin so the toggle is always pinned right with
         no risk of overflowing the row. */
      .scope-row {
        display: flex;
        align-items: center;
        gap: 10px;
      }
      .more-options-toggle {
        background: #ffffff;
        border: 1px solid #d3ded9;
        color: #4a5651;
        width: 32px;
        height: 32px;
        border-radius: 50%;
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 0;
        flex-shrink: 0;
        margin-left: auto;
        /* Defensive — make sure no later-painted sibling can intercept the
           click. The button was occasionally unresponsive on narrow widths
           when other elements briefly overlapped during re-render. */
        position: relative;
        z-index: 2;
        transition: color 120ms ease, background 120ms ease, border-color 120ms ease;
      }
      .more-options-toggle svg { width: 14px; height: 14px; display: block; pointer-events: none; }
      .more-options-toggle:hover {
        color: #1a2421;
        background: #f6f3e8;
      }
      .more-options-toggle[aria-expanded="true"] {
        background: #f4bd45;
        border-color: #f4bd45;
        color: #1a2421;
      }

      .more-options-panel {
        padding: 10px 12px;
        background: rgba(0, 0, 0, 0.035);
        border-radius: 8px;
        display: flex;
        flex-direction: column;
        gap: 2px;
        font-size: 13px;
      }
      .more-options-panel[hidden] { display: none; }
      .more-options-panel .check-row {
        font-size: 13px;
        line-height: 1.35;
        padding: 5px 0;
      }
      .more-options-panel .check-row input[type="checkbox"] {
        width: 14px;
        height: 14px;
        margin: 0;
        accent-color: #0f766e;
      }
      .more-options-settings-link {
        margin-top: 6px;
        padding: 6px 0 2px;
        background: transparent;
        border: 0;
        border-top: 1px dashed rgba(0, 0, 0, 0.12);
        color: #0f766e;
        font-size: 12px;
        font-weight: 600;
        font-family: inherit;
        cursor: pointer;
        text-align: left;
      }
      .more-options-settings-link:hover { color: #115e59; }

      /* Subtitle for the Tidy CTA showing eligible tab count */
      .tidy-cta {
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 2px;
        padding: 13px 16px;
      }
      .tidy-cta-title {
        font-size: 15px;
        font-weight: 700;
      }
      .tidy-cta-sub {
        font-size: 12px;
        font-weight: 500;
        opacity: 0.85;
      }

      /* Search input */
      .search-wrap {
        position: relative;
        margin-top: 4px;
      }
      .search-icon {
        position: absolute;
        left: 10px;
        top: 50%;
        transform: translateY(-50%);
        color: #8a948f;
        pointer-events: none;
      }
      .search-input {
        width: 100%;
        background: rgba(0, 0, 0, 0.04);
        border: 1px solid transparent;
        border-radius: 8px;
        padding: 8px 10px 8px 30px;
        font-size: 13px;
        font-family: inherit;
        color: #1a2421;
        outline: none;
        transition: background 120ms ease, border-color 120ms ease;
        box-sizing: border-box;
      }
      .search-input::placeholder { color: #8a948f; }
      .search-input:focus {
        background: #ffffff;
        border-color: #0f766e;
      }

      .search-hint {
        margin: 0;
        font-size: 11px;
        color: #8a948f;
      }
      .search-hint kbd {
        display: inline-block;
        background: rgba(0, 0, 0, 0.06);
        border-radius: 4px;
        padding: 0 4px;
        font-family: ui-monospace, SFMono-Regular, monospace;
        font-size: 10px;
      }

      /* Footer removed — Settings link lives inside the More options panel. */
    </style>
    <div class="card" role="status" aria-live="polite" id="card">
      <button class="close" data-action="dismiss" aria-label="Dismiss" type="button">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <line x1="6" y1="6" x2="18" y2="18"></line>
          <line x1="6" y1="18" x2="18" y2="6"></line>
        </svg>
      </button>
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
        <!-- Compact brand header matching the popup's visual framework -->
        <header class="exp-header">
          <!-- Inlined SVG (rather than <img src=chrome-extension://...>) so
               strict-CSP pages like Google Slides don't block the load via
               img-src directive. -->
          <span class="exp-brand-mascot" aria-hidden="true">
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 160 160">
              <rect width="160" height="160" rx="36" fill="#0f766e"/>
              <path d="M30 56 L72 48" stroke="#093f3b" stroke-width="7" stroke-linecap="round"/>
              <path d="M92 48 L130 58" stroke="#093f3b" stroke-width="7" stroke-linecap="round"/>
              <circle cx="56" cy="82" r="22" fill="#f7f8f6"/>
              <circle cx="63" cy="86" r="10" fill="#093f3b"/>
              <circle cx="65" cy="83" r="3" fill="#ffffff"/>
              <circle cx="108" cy="84" r="25" fill="#f7f8f6"/>
              <circle cx="100" cy="88" r="11" fill="#093f3b"/>
              <circle cx="102" cy="85" r="3" fill="#ffffff"/>
              <path d="M64 128 Q80 138 96 128" fill="none" stroke="#093f3b" stroke-width="7" stroke-linecap="round"/>
              <rect x="77" y="130" width="6" height="6" rx="1" fill="#f7f8f6"/>
              <path d="M134 28 L138 40 L150 44 L138 48 L134 60 L130 48 L118 44 L130 40 Z" fill="#f4bd45"/>
              <path d="M24 96 Q22 102 26 106 Q30 102 28 96 Z" fill="#f4bd45" opacity="0.9"/>
            </svg>
          </span>
          <h1 class="exp-wordmark"><span>Neat</span> <span class="exp-wordmark-accent">Freak</span></h1>
        </header>
        <p class="exp-tagline">Stash open tabs into folders, free up RAM.</p>

        <div class="scope-row">
          <div class="scope-picker" id="scope-picker">
            <button class="scope-button" data-action="scope" data-scope-value="smart" type="button">Smart</button>
            <button class="scope-button" data-action="scope" data-scope-value="allWindows" type="button">All windows</button>
            <button class="scope-button" data-action="scope" data-scope-value="currentWindow" type="button">Current</button>
          </div>
          <button class="more-options-toggle" data-action="toggle-more-options" type="button" aria-expanded="false" title="More options" aria-label="More options">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <line x1="4" y1="6" x2="20" y2="6"></line>
              <line x1="4" y1="12" x2="20" y2="12"></line>
              <line x1="4" y1="18" x2="20" y2="18"></line>
              <circle cx="10" cy="6" r="2" fill="currentColor"></circle>
              <circle cx="14" cy="12" r="2" fill="currentColor"></circle>
              <circle cx="8" cy="18" r="2" fill="currentColor"></circle>
            </svg>
          </button>
        </div>
        <div class="more-options-panel" id="more-options-panel" hidden>
          <label class="check-row">
            <input type="checkbox" id="opt-include-pinned"> <span>Include pinned tabs</span>
          </label>
          <label class="check-row">
            <input type="checkbox" id="opt-keep-current"> <span>Keep current tab open</span>
          </label>
          <label class="check-row">
            <input type="checkbox" id="opt-review"> <span>Review before closing</span>
          </label>
          <button class="more-options-settings-link" data-action="open-options-link" type="button">
            More settings →
          </button>
        </div>

        <button class="tidy-cta" data-action="tidy-expanded" type="button">
          <span class="tidy-cta-title">Tidy my tabs</span>
          <span class="tidy-cta-sub" id="tidy-cta-sub"></span>
        </button>

        <section class="sessions-section">
          <header class="sessions-header">
            <h3 id="sessions-heading">RECENT</h3>
            <button class="link-button" data-action="open-manager-link" type="button">Open manager</button>
          </header>
          <div class="search-wrap">
            <svg class="search-icon" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <circle cx="11" cy="11" r="7"></circle>
              <path d="m21 21-4.4-4.4"></path>
            </svg>
            <input class="search-input" id="panel-search" type="search" placeholder="Search saved tabs, or ask a question…" autocomplete="off">
          </div>
          <p class="search-hint" id="panel-search-hint">Press <kbd>↵</kbd> for smart search</p>
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
  // half-loaded view; force-collapse the expanded UI if we end up there.
  // Use suppressExpansionUI (not collapseExpansion) so the panel keeps
  // showing the new saving state — collapseExpansion's idle-mode branch
  // would dismiss the panel entirely.
  if (state.mode === "saving" && expandedMode) {
    suppressExpansionUI(host);
  }

  // Idle mode = user opened the panel via the toolbar icon (no clutter / done
  // context). Auto-expand and skip auto-dismiss — the user is here on purpose.
  if (state.mode === "idle" && !expandedMode) {
    expandPanel(host);
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

  if (state.mode === "idle") {
    // User-opened, no triggering event. Calm mascot, neutral copy, no action
    // button — the user is here for the expanded UI, not the collapsed pill.
    setMascot(mascotEl, calmUrl);
    titleEl.textContent = "Neat Freak";
    subEl.textContent = "Ready when you are.";
    actionsEl.innerHTML = "";
    // No auto-dismiss for user-opened states.
    return;
  }

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
    if (tabCount === 0) {
      // "Nothing to tidy" path — user clicked Tidy when there were no
      // eligible tabs. Quick acknowledgment, no action button, auto-dismiss.
      titleEl.textContent = "All clean";
      subEl.textContent = "Nothing to tidy right now.";
      actionsEl.innerHTML = "";
    } else {
      titleEl.textContent = `${tabCount} tab${tabCount === 1 ? "" : "s"} tucked away`;
      const parts = [];
      if (state.groupCount) parts.push(`${state.groupCount} folder${state.groupCount === 1 ? "" : "s"}`);
      if (state.looseCount) parts.push(`${state.looseCount} loose`);
      if (state.keepCount)  parts.push(`${state.keepCount} kept open`);
      subEl.textContent = parts.join(" · ") || "Ready in your saved sessions.";
      const sid = String(state.sessionId || "");
      actionsEl.innerHTML = `<button class="primary" data-action="open-manager" data-session-id="${escapeAttr(sid)}" type="button">Open manager</button>`;
    }
    if (!expandedMode) scheduleAutoDismiss(host);
    // If we entered done while expanded (e.g. user expanded mid-save), refresh
    // the recent-sessions list so the just-saved session appears.
    if (expandedMode && tabCount > 0) loadExpandedData(host);
    return;
  }
}

function setMascot(imgEl, url) {
  if (imgEl.src !== url) imgEl.src = url;
}

function handlePanelClick(host, event) {
  const target = event.target;
  if (!(target instanceof HTMLElement)) return;
  // Find the nearest action-bearing element. The button-inside-summary case
  // (folder Open-all inside a click-to-toggle row) works because closest()
  // matches the inner button first, not the wrapping row.
  const actionEl = target.closest("[data-action]");
  const action = actionEl?.dataset?.action || "";

  // No action attribute — check if the body was clicked to trigger expand.
  if (!action) {
    if (!expandedMode && target.closest("[data-clickable-body]")) {
      if (currentState && currentState.mode !== "saving" && currentState.mode !== "hidden") {
        expandPanel(host);
      }
    }
    return;
  }

  // Collapsed action buttons
  if (action === "dismiss") {
    cancelAutoDismiss();
    safeSendMessage({ type: "PANEL_DISMISS" });
    dismissPanel(host);
    return;
  }
  if (action === "tidy") {
    cancelAutoDismiss();
    safeSendMessage({ type: "PANEL_TIDY_NOW" });
    return;
  }
  if (action === "open-manager") {
    cancelAutoDismiss();
    const sessionId = actionEl.dataset.sessionId || "";
    safeSendMessage({ type: "PANEL_OPEN_MANAGER", sessionId });
    dismissPanel(host);
    return;
  }

  // Expanded-view actions
  if (action === "scope") {
    const newScope = actionEl.dataset.scopeValue;
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
    safeSendMessage({ type: "PANEL_OPEN_MANAGER" });
    return;
  }
  if (action === "open-options-link") {
    safeSendMessage({ type: "OPEN_OPTIONS" });
    return;
  }
  if (action === "toggle-more-options") {
    const panel = host.shadowRoot.getElementById("more-options-panel");
    const isOpen = actionEl.getAttribute("aria-expanded") === "true";
    actionEl.setAttribute("aria-expanded", String(!isOpen));
    if (panel) panel.hidden = isOpen;
    return;
  }
  if (action === "restore-session") {
    const sessionId = actionEl.dataset.sessionId || "";
    const tabCount = Number(actionEl.dataset.tabCount) || 0;
    if (shouldConfirmReopen(sessionId)) {
      const tabLabel = `${tabCount} tab${tabCount === 1 ? "" : "s"}`;
      if (!confirm(`Reopen all ${tabLabel} you just tucked away?`)) return;
    }
    safeSendMessage({ type: "RESTORE_SESSION", sessionId });
    return;
  }
  if (action === "restore-group") {
    const sessionId = actionEl.dataset.sessionId || "";
    const categoryId = actionEl.dataset.categoryId || "";
    const tabCount = Number(actionEl.dataset.tabCount) || 0;
    if (shouldConfirmReopen(sessionId)) {
      const tabLabel = `${tabCount} tab${tabCount === 1 ? "" : "s"}`;
      if (!confirm(`Reopen all ${tabLabel} from this folder?`)) return;
    }
    safeSendMessage({ type: "RESTORE_GROUP", sessionId, categoryId });
    return;
  }
  if (action === "restore-tab") {
    const sessionId = actionEl.dataset.sessionId || "";
    const tabId = actionEl.dataset.tabId || "";
    if (sessionId && tabId) {
      safeSendMessage({ type: "RESTORE_TAB", sessionId, tabId });
    }
    return;
  }
  if (action === "toggle-folder") {
    const row = actionEl.closest(".folder-row");
    if (row) {
      const expanded = row.dataset.folderExpanded === "true";
      row.dataset.folderExpanded = expanded ? "false" : "true";
    }
    return;
  }
  if (action === "toggle-session") {
    const card = actionEl.closest(".session-card");
    if (card) {
      const expanded = card.dataset.sessionExpanded === "true";
      card.dataset.sessionExpanded = expanded ? "false" : "true";
    }
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

// State-driven UI suppression. Does NOT decide on dismissal — just hides the
// expanded view's DOM and unbinds outside-click. Use when an underlying mode
// transition (e.g. → saving) requires collapsing without dismissing.
function suppressExpansionUI(host) {
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
}

// User-initiated collapse (outside-click, × in idle mode). For idle, the
// collapsed view is meaningless — dismiss the whole panel. For other modes,
// just suppress the expansion UI and restart the auto-dismiss timer.
function collapseExpansion(host, opts = {}) {
  if (!expandedMode) return;

  if (currentState?.mode === "idle") {
    expandedMode = false;
    unbindOutsideClickHandler();
    cancelAutoDismiss();
    safeSendMessage({ type: "PANEL_DISMISS" });
    dismissPanel(host);
    return;
  }

  suppressExpansionUI(host);
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
    // Brand mascot is now an inline SVG (see panelMarkup); no img src to set.
    const response = await safeSendMessageAwait({ type: "GET_POPUP_STATE" });
    if (!response?.ok) return;
    if (response.settings?.defaultScope) {
      selectedScope = response.settings.defaultScope;
    }
    renderScopePicker(host);
    renderPreview(host, response.preview);
    renderMoreOptions(host, response.settings);
    renderSessions(host, response.sessions || []);
    bindSearchInput(host);
  } catch (err) {
    console.warn("[Neat Freak] Load expanded data failed:", err?.message || err);
  }
}

let searchDebounceTimer = null;
function bindSearchInput(host) {
  const input = host.shadowRoot.getElementById("panel-search");
  if (!input || input.dataset.bound === "true") return;
  input.dataset.bound = "true";
  input.addEventListener("input", () => {
    clearTimeout(searchDebounceTimer);
    const query = input.value;
    searchDebounceTimer = setTimeout(() => runSearch(host, query, "local"), 220);
  });
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      runSearch(host, input.value, "smart");
    } else if (event.key === "Escape") {
      input.value = "";
      runSearch(host, "", "local");
    }
  });
}

async function runSearch(host, query, mode) {
  const shadow = host.shadowRoot;
  const trimmed = String(query || "").trim();
  const list = shadow.getElementById("session-list");
  const hint = shadow.getElementById("panel-search-hint");
  if (!trimmed) {
    // Empty query → restore the default sessions view.
    if (hint) hint.innerHTML = `Press <kbd>↵</kbd> for smart search`;
    renderSessions(host, lastLoadedSessions);
    return;
  }
  if (mode === "smart") {
    if (hint) hint.textContent = "Asking AI…";
  } else {
    if (hint) hint.innerHTML = `Press <kbd>↵</kbd> for smart search`;
  }
  try {
    const response = await safeSendMessageAwait({ type: "SEARCH_TABS", query: trimmed, mode });
    if (!response?.ok) return;
    const results = response.results || [];
    if (!results.length) {
      list.innerHTML = `<p class="session-empty">No saved tabs match "${escapeText(trimmed)}".</p>`;
      return;
    }
    list.innerHTML = results.slice(0, 12).map((tab) => {
      const fav = tab.favIconUrl
        ? `<img class="folder-tab-favicon" src="${escapeAttr(tab.favIconUrl)}" alt="" onerror="this.style.visibility='hidden'">`
        : `<span class="folder-tab-favicon"></span>`;
      const title = escapeText(tab.title || tab.url || "Untitled");
      const folder = tab.folderName ? `<span class="search-folder">${escapeText(tab.folderName)}</span>` : "";
      return `
        <button class="folder-tab" data-action="restore-tab" data-session-id="${escapeAttr(tab.sessionId)}" data-tab-id="${escapeAttr(tab.tabId)}" type="button" title="${escapeAttr(tab.url || "")}">
          ${fav}<span class="folder-tab-title">${title}</span>${folder}
        </button>
      `;
    }).join("");
  } catch (err) {
    if (hint) hint.textContent = "Search failed.";
    console.warn("[Neat Freak] Search failed:", err?.message || err);
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
  // The standalone .preview-line element was removed when we adopted the
  // popup-equivalent layout; the eligible-tab info now lives in the Tidy
  // CTA subtitle. Keep this function as the single update point.
  const shadow = host.shadowRoot;
  const sub = shadow.getElementById("tidy-cta-sub");
  if (!sub) return;
  const count = Number(preview?.count) || 0;
  if (!count) {
    sub.textContent = "No savable tabs in scope";
    return;
  }
  const label = scopeBlurb(selectedScope);
  sub.textContent = `${count} tab${count === 1 ? "" : "s"} eligible${label ? ` — ${label}` : ""}`;
}

function scopeBlurb(scope) {
  switch (scope) {
    case "smart": return "Smart will pick";
    case "allWindows": return "all windows";
    case "currentWindow": return "current window";
    default: return "";
  }
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
  lastLoadedSessions = sessions;
  if (!sessions.length) {
    list.innerHTML = `<p class="session-empty">No saved sessions yet. Hit "Tidy my tabs" to make your first one.</p>`;
    return;
  }

  // Flat recency-ranked list of "items" — each item is either a folder
  // (multi-tab category, rendered as accordion) or a standalone tab (rendered
  // as a URL row). Iterate sessions newest-first, then categories by size
  // descending within each session, until we have MAX_ITEMS. The first few
  // items are naturally the most recently saved, so the just-saved session
  // surfaces at the top without any special pinning.
  const MAX_ITEMS = 6;
  const items = [];
  for (const session of sessions) {
    const tabsById = new Map((session.tabs || []).map((t) => [t.id, t]));
    const cats = (session.categories || [])
      .slice()
      .sort((a, b) => (b.tabIds?.length || 0) - (a.tabIds?.length || 0));
    for (const cat of cats) {
      if (items.length >= MAX_ITEMS) break;
      const tabIds = cat.tabIds || [];
      if (tabIds.length >= 2) {
        items.push({ kind: "folder", sessionId: session.id, category: cat, tabsById });
      } else if (tabIds.length === 1) {
        const tab = tabsById.get(tabIds[0]);
        if (tab) items.push({ kind: "tab", sessionId: session.id, tab });
      }
    }
    if (items.length >= MAX_ITEMS) break;
  }

  list.innerHTML = items.map(renderRecentItem).join("");
}

function renderRecentItem(item) {
  const sid = escapeAttr(item.sessionId);
  if (item.kind === "folder") {
    return renderFolderRow(item.category, item.tabsById, sid, false);
  }
  return renderSingletonRow(item.tab, sid);
}

function renderSingletonRow(tab, sid) {
  const title = escapeText(tab.title || tab.url || "Untitled");
  const fav = tab.favIconUrl
    ? `<img class="folder-tab-favicon" src="${escapeAttr(tab.favIconUrl)}" alt="" onerror="this.style.visibility='hidden'">`
    : `<span class="folder-tab-favicon"></span>`;
  return `
    <button class="folder-tab recent-singleton" data-action="restore-tab" data-session-id="${sid}" data-tab-id="${escapeAttr(tab.id)}" type="button" title="${escapeAttr(tab.url || "")}">
      ${fav}<span class="folder-tab-title">${title}</span>
    </button>
  `;
}

function renderSessionCard(session, isPinned) {
  const tabCount = session.tabs?.length || 0;
  const whenAbs = formatAbsoluteTime(session.createdAt);
  const sid = escapeAttr(session.id);

  const allCats = session.categories || [];
  const folders = allCats
    .filter((c) => (c.tabIds || []).length >= 2)
    .slice()
    .sort((a, b) => (b.tabIds?.length || 0) - (a.tabIds?.length || 0));
  const singletonCats = allCats.filter((c) => (c.tabIds || []).length === 1);

  const tabsById = new Map((session.tabs || []).map((t) => [t.id, t]));
  const foldersHtml = folders.map((folder) => renderFolderRow(folder, tabsById, sid, isPinned)).join("");

  // Singletons render as URL rows directly — no folder wrapper, no "+N loose"
  // summary. The user wants individual items to be visible as URLs.
  const singletonsHtml = singletonCats.map((cat) => {
    const tab = tabsById.get(cat.tabIds[0]);
    if (!tab) return "";
    const title = escapeText(tab.title || tab.url || "Untitled");
    const fav = tab.favIconUrl
      ? `<img class="folder-tab-favicon" src="${escapeAttr(tab.favIconUrl)}" alt="" onerror="this.style.visibility='hidden'">`
      : `<span class="folder-tab-favicon"></span>`;
    return `
      <button class="folder-tab singleton" data-action="restore-tab" data-session-id="${sid}" data-tab-id="${escapeAttr(tab.id)}" type="button" title="${escapeAttr(tab.url || "")}">
        ${fav}<span class="folder-tab-title">${title}</span>
      </button>
    `;
  }).join("");

  const pinnedClass = isPinned ? " pinned-saved" : "";
  // Session is expanded by default only when it's the just-saved one; everything
  // else stays collapsed (compact list — date + tab count) until clicked.
  const expanded = isPinned ? "true" : "false";

  return `
    <div class="session-card${pinnedClass}" data-session-expanded="${expanded}">
      <div class="session-card-header" data-action="toggle-session">
        <div class="session-card-header-text">
          <p class="session-card-title">${escapeText(whenAbs)}</p>
          <p class="session-card-meta">${tabCount} tab${tabCount === 1 ? "" : "s"}</p>
        </div>
        <button class="session-open-all" data-action="restore-session" data-session-id="${sid}" data-tab-count="${tabCount}" type="button">Open all</button>
      </div>
      <div class="folder-list">
        ${foldersHtml}
        ${singletonsHtml}
      </div>
    </div>
  `;
}

function formatAbsoluteTime(iso) {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  const d = new Date(t);
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  let hours = d.getHours();
  const ampm = hours >= 12 ? "PM" : "AM";
  hours = hours % 12 || 12;
  const mins = String(d.getMinutes()).padStart(2, "0");
  return `${months[d.getMonth()]} ${d.getDate()}, ${hours}:${mins} ${ampm}`;
}

function renderFolderRow(folder, tabsById, sid, expandByDefault) {
  const folderName = escapeText(folder.name || "Folder");
  const tabCount = (folder.tabIds || []).length;
  const cid = escapeAttr(folder.id);
  const expanded = expandByDefault ? "true" : "false";

  const tabsHtml = (folder.tabIds || []).map((tabId) => {
    const tab = tabsById.get(tabId);
    if (!tab) return "";
    const title = escapeText(tab.title || tab.url || "Untitled");
    const fav = tab.favIconUrl
      ? `<img class="folder-tab-favicon" src="${escapeAttr(tab.favIconUrl)}" alt="" onerror="this.style.visibility='hidden'">`
      : `<span class="folder-tab-favicon"></span>`;
    return `
      <li>
        <button class="folder-tab" data-action="restore-tab" data-session-id="${sid}" data-tab-id="${escapeAttr(tab.id)}" type="button" title="${escapeAttr(tab.url || "")}">
          ${fav}<span class="folder-tab-title">${title}</span>
        </button>
      </li>
    `;
  }).join("");

  return `
    <div class="folder-row" data-folder-expanded="${expanded}">
      <div class="folder-summary" data-action="toggle-folder">
        <span class="folder-disclosure" aria-hidden="true">▸</span>
        <span class="folder-name">${folderName}</span>
        <span class="folder-count">${tabCount}</span>
        <button class="folder-open-all" data-action="restore-group" data-session-id="${sid}" data-category-id="${cid}" data-tab-count="${tabCount}" type="button">Open all</button>
      </div>
      <ul class="folder-tabs">${tabsHtml}</ul>
    </div>
  `;
}

// True when reopening should warn the user — protects against immediately
// undoing a save by clicking "Open all" on the just-saved session.
function shouldConfirmReopen(sessionId) {
  const session = lastLoadedSessions.find((s) => s.id === sessionId);
  if (!session?.createdAt) return false;
  const ageMs = Date.now() - Date.parse(session.createdAt);
  return Number.isFinite(ageMs) && ageMs >= 0 && ageMs < 60_000;
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
  const includePinned = host.shadowRoot.getElementById("opt-include-pinned")?.checked || false;
  const keepCurrentTab = host.shadowRoot.getElementById("opt-keep-current")?.checked !== false;
  const response = await safeSendMessageAwait({
    type: "PREVIEW_TABS",
    options: { scope: selectedScope, includePinned, keepCurrentTab }
  });
  if (response?.ok) renderPreview(host, response.preview);
}

async function triggerExpandedSave(host) {
  const shadow = host.shadowRoot;
  const includePinned = shadow.getElementById("opt-include-pinned")?.checked || false;
  const keepCurrentTab = shadow.getElementById("opt-keep-current")?.checked !== false;
  const reviewBeforeClose = shadow.getElementById("opt-review")?.checked || false;

  // Skip the loading state if there's nothing eligible. The preview count
  // the user just saw can go stale between render and click, so re-query
  // fresh right before deciding.
  const previewResponse = await safeSendMessageAwait({
    type: "PREVIEW_TABS",
    options: { scope: selectedScope, includePinned, keepCurrentTab }
  });
  const eligible = Number(previewResponse?.preview?.count) || 0;
  if (eligible === 0) {
    await safeStorageSessionSet({
      neatFreakPanelState: { mode: "done", tabCount: 0 }
    });
    return;
  }

  // Pre-emptively write saving state from the panel side so the visual
  // transition (expanded → collapsed saving with mascot animation) happens
  // immediately. Without this, the panel would briefly flash the prior mode's
  // collapsed view, OR — in idle mode — collapseExpansion would dismiss the
  // panel entirely before saveTabs starts emitting progress.
  const stateWritten = await safeStorageSessionSet({
    neatFreakPanelState: { mode: "saving", label: "Tidying your tabs" }
  });
  if (!stateWritten) {
    suppressExpansionUI(host);
  }

  await safeSendMessageAwait({
    type: "SAVE_TABS",
    options: {
      scope: selectedScope,
      includePinned,
      keepCurrentTab,
      reviewBeforeClose,
      openManager: false
    }
  });
  // background.saveTabs's emitProgress writes per-step labels to the panel
  // state; addSession → showPanelDone transitions to done at the end.
}

function scheduleAutoDismiss(host) {
  cancelAutoDismiss();
  autoDismissTimer = setTimeout(() => {
    safeSendMessage({ type: "PANEL_DISMISS" });
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

})(); // neatFreakPanelInit IIFE
