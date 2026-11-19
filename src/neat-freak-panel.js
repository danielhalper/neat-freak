// Unified floating panel. Replaces clutter-toast.js + done-toast.js with a
// single persistent element that transitions between modes in place:
//
//   clutter  →  "N tabs ready to tidy", Review (opens the list) and Tidy now
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
  const AUTO_DISMISS_MS = 10000;
  let autoDismissTimer = null;
  // Auto-dismiss is visibility-paused: the countdown only advances while the
  // panel is actually on screen, so the full window is spent in front of the
  // user — not elapsed while they're on another tab or app. See
  // bindVisibilityPause / resumeAutoDismiss below.
  let autoDismissHost = null;
  let autoDismissRemainingMs = 0;
  let autoDismissStartedAt = 0;

  // Popup-context detection: when this script is loaded from popup.html (chrome
  // extension page) instead of injected into a regular tab, we render the
  // panel inline (no fixed positioning, no card border/shadow, no slide-in or
  // outside-click handling). Same UI, same code, different host frame.
  const inPopupContext = (() => {
    try {
      return location.href === chrome.runtime.getURL("popup.html");
    } catch { return false; }
  })();

  // Local-only expanded-mode flag. Not stored — expansion is "the user is
  // interacting with this surface right now," tab-local intent.
  let expandedMode = false;
  const dismissTimers = new WeakMap();
  let currentState = null;
  let outsideClickHandler = null;
  let selectedScope = "smart";
  let lastLoadedSessions = [];
  let latestRecommendation = null;
  let latestSettings = {};
  let recommendationBusy = false;
  let recommendationRequest = 0;
  let pendingKeepWrites = 0;
  let keepWriteQueue = Promise.resolve();
  // The suggested-tabs list is a disclosure on the offer card. Opening it is
  // the review; closing it keeps the review (and Keep choices) but folds the
  // card back to one line. Reset to open whenever a different plan arrives.
  let offerListOpen = true;
  let offerListPlanId = "";
  // Set when Tidy on a local offer opened the list instead of closing, so the
  // card can say why nothing closed yet.
  let offerTidyPendingPlanId = "";
  // The Tidy button's second line: the last eligible-tab count and the scope
  // it was counted for (a prepared offer replaces it; see renderTidySub).
  let lastPreviewCount = 0;
  let lastPreviewScope = "";
  // True from a Tidy press that will stop at a list (review on) until the
  // saving state ends, so the working card says "Checking", not "Tidying".
  let checkingBeforeReview = false;
  // True after a check the user asked for came back with nothing to suggest,
  // until the panel moves on, so the open panel can say so under the button.
  let checkedEmpty = false;
  // True while the run started by opening the panel (no list, or one over 30
  // minutes old) is in flight; the Tidy line reads "Checking your tabs".
  let offerChecking = false;
  const READY_MARK = '<svg width="15" height="15" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="7.2" fill="rgba(255,255,255,.2)" stroke="currentColor" stroke-width="1.2"/><path d="M4.7 8.3l2.2 2.2 4.5-4.8" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>';

  // Mascot mood inputs. Mood = sleeping (0 tabs) / happy (≤ threshold) /
  // nervous (> threshold) / cleaning (saving state) / celebrating (done).
  // totalTabCountValid stays false until loadExpandedData fills it so the
  // first paint doesn't flash "sleeping" with a stale 0.
  let totalTabCount = 0;
  let totalTabCountValid = false;
  let clutterThreshold = 20;
  let currentMood = null;
  // Idle-mode whimsy: ~50% of the time, show the sleeping mascot when the
  // user opens the panel and lets it sit. Wakes up the moment they click
  // anything actionable. idleSleepingRolled prevents re-rolling if applyState
  // fires multiple times within the same idle session.
  let idleSleepingRolled = false;
  let idleSleeping = false;

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
    bindVisibilityPause();
    const hasLiveState = Boolean(state && state.mode && state.mode !== "hidden");
    // In popup context the user clicked the toolbar icon specifically to get the
    // tidy UI, so always mount — show any live state (saving/done/clutter) or
    // fall back to idle. In injected/page context we only appear when there's
    // something to show.
    if (inPopupContext) {
      const host = ensureHost();
      // The popup is the "manage my tabs" surface: show the idle tidy UI by
      // default (and for a live clutter nudge); only the transient
      // saving / done / review states get their own card.
      const transient = hasLiveState && ["saving", "done", "review"].includes(state.mode);
      applyState(host, transient ? state : { mode: "idle" });
    } else if (hasLiveState) {
      const host = ensureHost();
      applyState(host, state);
    }
  })();

  async function ensureBrandFont() {
    // Document-level guard so we only load the font once per isolated world.
    if (window.__neatFreakBrandFontLoaded) return;
    if (!isExtensionValid()) return;
    try {
      const url = chrome.runtime.getURL("assets/fonts/LilitaOne-Regular.woff2");
      const response = await fetch(url);
      if (!response.ok) throw new Error(`status ${response.status}`);
      const buffer = await response.arrayBuffer();
      const face = new FontFace("Lilita One", buffer, {
        style: "normal",
        weight: "400",
        display: "swap"
      });
      await face.load();
      document.fonts.add(face);
      window.__neatFreakBrandFontLoaded = true;
    } catch (err) {
      // Falls back to the next entry in the font-family chain.
      // If the extension reloaded mid-fetch (orphaned content script), the
      // failure is expected — Chrome invalidates the resource URL. Skip
      // the console warning in that case so dev consoles don't fill with
      // noise on every extension reload. Same applies in production when
      // a Web Store update lands while users have tabs open.
      if (isExtensionValid()) {
        console.warn("[Neat Freak] Lilita One load failed:", err?.message || err);
      }
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
      if (changes.neatFreakRecommendation && expandedMode) readCurrentSuggestion();
      if (!changes[STATE_KEY]) return;
      const newState = changes[STATE_KEY].newValue || { mode: "hidden" };
      let host = document.getElementById(HOST_ID);
      if (!host && newState.mode !== "hidden") host = ensureHost();
      // In the popup, a clutter-nudge update should keep showing the tidy UI,
      // not collapse to the in-page clutter pill.
      if (host) applyState(host, (inPopupContext && newState.mode === "clutter") ? { mode: "idle" } : newState);
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
    // In popup context the host lives inside <body> so the popup window
    // wraps it (otherwise it sits as a sibling of body and the cream popup
    // body renders ABOVE the panel — user has to scroll to find the UI).
    // In page-injected context we attach to document.documentElement so the
    // host floats above page content regardless of body styling.
    const parent = inPopupContext ? document.body : document.documentElement;
    let host = document.getElementById(HOST_ID);
    if (!host) {
      host = createPanelHost();
      parent.appendChild(host);
    } else if (!parent.contains(host)) {
      parent.appendChild(host);
    }
    return host;
  }

function createPanelHost() {
  const host = document.createElement("div");
  host.id = HOST_ID;
  // In popup context we render inline (block-level, fills the popup body).
  // In injected/page context we float top-right with high z-index.
  if (inPopupContext) {
    host.style.cssText = [
      "all: initial",
      "display: block",
      "color-scheme: light"
    ].join("; ");
  } else {
    host.style.cssText = [
      "all: initial",
      "position: fixed",
      "top: 12px",
      "right: 12px",
      "z-index: 2147483647",
      "color-scheme: light"
    ].join("; ");
  }
  const shadow = host.attachShadow({ mode: "open" });
  shadow.innerHTML = panelMarkup();
  shadow.addEventListener("click", (event) => handlePanelClick(host, event));
  shadow.addEventListener("change", (event) => handlePanelChange(host, event));
  // Swipe-to-dismiss the collapsed card. Skips popup context, expanded view,
  // and states with explicit actions (saving / review).
  const cardForSwipe = shadow.getElementById("card");
  if (cardForSwipe) bindSwipeToDismiss(host, cardForSwipe);
  // Favicon <img> tags previously used onerror="..." inline to hide
  // themselves when a domain's favicon failed to load. Strict-CSP pages
  // (Slides, etc.) block inline event handlers, so we replace it with a
  // delegated capture-phase listener — `error` events don't bubble, hence
  // the third arg.
  shadow.addEventListener("error", (event) => {
    const target = event.target;
    if (target && target.tagName === "IMG" && target.classList && target.classList.contains("folder-tab-favicon")) {
      target.style.visibility = "hidden";
    }
  }, true);
  // Paint an initial mascot (defaults to happy until state arrives) so the
  // collapsed view never flashes empty.
  updateMascot(host);
  return host;
}

// Persist More options checkbox state so each toggle becomes the default the
// next time the panel opens. Delegated at the shadow root because the
// checkboxes ship in the static markup; one listener covers all three.
function handlePanelChange(host, event) {
  const target = event.target;
  if (!(target instanceof HTMLInputElement) || target.type !== "checkbox") return;
  if (target.id === "opt-auto-tidy") {
    // "Automatic" = skip the review step next time → review-before-close OFF.
    // Stop the done card's auto-dismiss so it doesn't vanish mid-toggle.
    cancelAutoDismiss();
    safeSendMessage({ type: "SAVE_SETTINGS", settings: { defaultReviewBeforeClose: !target.checked } });
    return;
  }
  let key = null;
  if (target.id === "opt-include-pinned") key = "defaultIncludePinned";
  else if (target.id === "opt-keep-current") key = "defaultKeepCurrentTab";
  else if (target.id === "opt-review") key = "defaultReviewBeforeClose";
  if (!key) return;
  safeSendMessage({ type: "SAVE_SETTINGS", settings: { [key]: target.checked } });
  // Pinned/current affect the eligible-tabs preview shown under the Tidy CTA.
  if (key === "defaultIncludePinned" || key === "defaultKeepCurrentTab") {
    refreshPreview(host);
  }
  // Review on/off changes what a press on a prepared list does.
  if (key === "defaultReviewBeforeClose") renderTidySub(host);
}

function panelMarkup() {
  // The full CSS is inlined into the shadow root. Inherits the visual language
  // refined in the previous clutter-toast.js iteration — cream card, amber top
  // bar, free-standing mascot with teal drop-shadow.
  //
  // Brand font (Lilita One) is loaded once at panel init via the FontFace
  // API (see ensureBrandFont). That adds it to document.fonts, which shadow
  // DOMs automatically inherit. No @font-face here — the URL-based load
  // would be blocked by font-src CSP on pages like Slides.
  return `
    <style>
      :host { all: initial; }
      .card {
        /* Match the popup's --font variable so the panel renders identically. */
        font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        position: relative;
        /* border-box so the declared width is the OUTER footprint, including
           padding + border. Without this, collapsed (padding 12/14) would be
           ~28px wider than expanded (padding 0) for the same 360px width. */
        box-sizing: border-box;
        width: min(360px, calc(100vw - 32px));
        /* Teal-cream tint, matching the expanded outer frame so collapsed →
           expanded doesn't flash a background-color change. */
        background: #e8f2ec;
        color: #1a2421;
        border: 1px solid #e8dfc7;
        border-radius: 14px;
        box-shadow: 0 18px 40px -6px rgba(15, 118, 110, 0.22), 0 4px 12px rgba(0, 0, 0, 0.08);
        padding: 12px 14px 14px;
        overflow: hidden;
        animation: slidein 0.28s cubic-bezier(0.2, 0.9, 0.3, 1.2);
      }
      /* In the popup window, the popup chrome IS the card frame — fill the
         body and drop the floating-card treatments. The amber top bar via
         .card::before and the teal-cream interior stay. */
      .card.in-popup {
        width: 100%;
        min-height: 0;
        border: 0;
        border-radius: 0;
        box-shadow: none;
        animation: none;
      }
      /* The default expanded-content caps at 60vh with an inner scrollbar so
         the floating injected card doesn't take over the page. In the popup
         that cap hides the Recent list — there's ~270px of content above
         (brand + tagline + scope row + Tidy CTA + search) and 60vh of a
         590px popup is only ~354px, leaving ~80px of list visible behind a
         near-invisible macOS scrollbar. In popup context, drop the cap and
         let the Chrome popup shell own scrolling. */
      .card.in-popup .expanded-content {
        max-height: none;
        overflow-y: visible;
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
      .card.leaving { animation: slideout 0.2s ease-in forwards; }

      /* Collapsed view mirrors the expanded hero layout: relative-positioned
         frame with the mascot absolutely floated to the top-right and text
         flowing on the left. min-height matches .exp-hero so the mascot
         (which peeks ~13px below row bottom into the actions area) has the
         same vertical footprint in both surfaces. */
      .row {
        display: block;
        position: relative;
        min-height: 96px;
      }

      /* Collapsed-view mascot: identical positioning + sizing to the expanded
         hero's .exp-character-svg — same viewBox (0 0 320 200) so the ambient
         sparkles render, same 56% width / 190px cap, same drop-shadow.
         CSS animations on inner .nf-body-g / .nf-pupils / .nf-finger fire
         automatically via the .nf-state-{mood} class on this element. */
      .mascot {
        position: absolute;
        top: -1px;
        right: 24px;
        width: 56%;
        max-width: 190px;
        height: auto;
        z-index: 2;
        pointer-events: none;
        overflow: visible;
        filter: drop-shadow(0 3px 6px rgba(15, 118, 110, 0.16));
      }

      .body {
        padding-top: 4px;
        /* Reserve the right half for the absolute-positioned mascot so the
           title/sub text never flows under it. */
        padding-right: 50%;
      }
      .title { font-size: 16px; font-weight: 600; line-height: 1.25; margin: 0 0 2px; color: #1a2421; }
      .sub { font-size: 13px; color: #4a5651; margin: 0; line-height: 1.4; display: flex; align-items: center; gap: 6px; }

      /* Indeterminate sliding progress bar for the saving state. A thin track
         + a moving fill ribbon that loops left-to-right. Communicates "work
         in progress" without needing per-step percentages. */
      .progress-bar {
        width: 100%;
        height: 4px;
        background: rgba(0, 0, 0, 0.08);
        border-radius: 999px;
        overflow: hidden;
        /* Flex item in .actions (align-items: center) — let the row center it
           rather than nudging it down, so the footer reads tight + balanced. */
        margin-top: 0;
      }
      .progress-bar::before {
        content: "";
        display: block;
        width: 35%;
        height: 100%;
        background: linear-gradient(90deg, #f4bd45 0%, #f6cd6d 100%);
        border-radius: 999px;
        animation: progress-slide 1.3s cubic-bezier(0.4, 0, 0.2, 1) infinite;
      }
      @keyframes progress-slide {
        0%   { transform: translateX(-100%); }
        100% { transform: translateX(400%); }
      }

      /* Explicit "Close" affordance in the saving state — small muted text
         button under the progress bar. Reinforces that the panel is
         non-blocking; the save keeps running and the result still surfaces. */
      .saving-close {
        display: inline-block;
        margin-top: 0;
        padding: 2px 0;
        background: none;
        border: 0;
        font-family: inherit;
        font-size: 12px;
        color: #63706b;
        cursor: pointer;
        text-decoration: underline;
        text-underline-offset: 2px;
      }
      .saving-close:hover { color: #17201d; }
      .saving-close:focus-visible { outline: 2px solid #f4bd45; outline-offset: 2px; border-radius: 3px; }

      /* The saving and done cards run tighter than the clutter/review cards.
         Pull the monster up to close the dead space under the top bar, shorten
         the row so the divider still meets his feet, and slim the footer's
         vertical padding. Scoped to these two states so clutter/review keep
         their roomier proportions. (The done card's has-auto-tidy variant adds
         its own padding-bottom override below, at higher specificity.) */
      .card.state-saving .mascot,
      .card.state-done .mascot { top: -22px; }
      .card.state-saving .row,
      .card.state-done .row { min-height: 74px; }
      .card.state-saving .actions,
      .card.state-done .actions {
        margin-top: 8px;
        padding-top: 7px;
        padding-bottom: 7px;
      }

      .close {
        position: absolute;
        top: 10px; right: 10px;
        /* Above mascot (z-index: 2) — the mascot SVG overlaps this corner
           and would otherwise shadow the × in hit-testing. */
        z-index: 3;
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
      .close svg { width: 12px; height: 12px; display: block; pointer-events: none; }
      .close:hover {
        color: #1a2421;
        border-color: #d9ce9a;
        box-shadow: 0 2px 6px rgba(0, 0, 0, 0.10);
      }
      .close:focus-visible { outline: 2px solid #f4bd45; outline-offset: 1px; }

      /* Actions row carries the tertiary link on the LEFT and the primary
         CTA on the RIGHT (clutter + done states). space-between pins each
         to its side automatically. Saving state has just a progress bar
         which is width:100% so the layout reads correctly there too.
         The negative margins extend the tray to the card's outer edges
         (the card has padding 12/14/14) so the white footer reads as a
         separate plane from the teal-cream area where the mascot lives —
         echoes the expanded view's exp-hero / exp-inner-card two-tone. */
      .actions {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        margin: 12px -14px -14px;
        padding: 12px 14px 14px;
        background: #fefefc;
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

      /* Wrapper that animates the panel between collapsed (no expanded
         content visible) and expanded (full expanded content shown). Uses
         the grid-template-rows 0fr → 1fr trick which transitions natural
         content height without needing a JS-measured target.
         overflow: hidden lives HERE on the wrapper (not the child) so the
         grid clipping works during the animation while the child's own
         overflow-y: auto remains effective for in-content scrolling. */
      .expand-wrapper {
        display: grid;
        grid-template-rows: 0fr;
        /* Cap the implicit grid column at the wrapper width so long folder names
           / CTAs can't stretch the column past the card and clip the right-edge
           controls (gear, "Open all"). Children shrink/truncate instead. */
        grid-template-columns: minmax(0, 1fr);
        transition: grid-template-rows 260ms cubic-bezier(0.2, 0.9, 0.3, 1.0);
        overflow: hidden;
      }
      .card.expanded .expand-wrapper {
        grid-template-rows: 1fr;
      }
      .expand-wrapper > .expanded-content {
        min-height: 0;       /* allows the 0fr collapse to actually clip to 0 */
        min-width: 0;        /* allow content to shrink to the column, not overflow it */
        /* Intentionally no overflow rule here — let .expanded-content's own
           overflow-y: auto (or .card.in-popup override to visible) drive
           the Recent list's scroll behavior. */
      }
      /* In popup context the idle (tidy) view mounts already-expanded with no
         settle animation. Saving/done/review keep the normal collapsed wrapper
         so they show only their own card, not the tidy UI stacked beneath it. */
      .card.in-popup.state-idle .expand-wrapper {
        grid-template-rows: 1fr;
        transition: none;
      }

      /* Small hyperlink that sits on the LEFT side of the actions row,
         opposite the primary CTA. Used in clutter ("Adjust nudges →") and
         done ("See closed tabs →") states. Muted so it doesn't compete
         with the primary button on the right. */
      .tertiary-link {
        background: transparent;
        border: 0;
        color: #8a948f;
        font-size: 11px;
        font-family: inherit;
        cursor: pointer;
        padding: 0;
        text-decoration: underline;
        text-underline-offset: 2px;
      }
      .tertiary-link:hover { color: #4a5651; }

      /* Review-before-closing list. Sits below .actions, only visible when
         .card.state-review. Hides the normal expand-wrapper (no recent
         sessions UI during a review). Also hides the .actions row, which is
         empty in review mode (CTAs live in .review-footer at the bottom) —
         otherwise it shows as a white-band gap above the list. */
      .card.state-review .expand-wrapper { display: none; }
      .card.state-review .actions { display: none; }
      .card.state-review .review-shell { display: flex; }
      /* A suggested tidy folds back to its one-line offer without leaving
         review: list hidden, Review / Tidy now back in the actions row. */
      .card.state-review.offer-collapsed .review-shell { display: none; }
      .card.state-review.offer-collapsed .actions { display: flex; }
      .card.state-review .row[data-clickable-body="true"] { cursor: pointer; }

      /* Review: a quiet text disclosure just left of Tidy now, so the row has
         one button. margin-left: auto pins the pair to the right of any row.
         The chevron is a pseudo-element so busy-state text swaps keep it. */
      .offer-toggle {
        margin-left: auto;
        margin-right: 6px;
        display: inline-flex;
        align-items: center;
        gap: 6px;
        padding: 8px 4px;
        border: 0;
        border-radius: 6px;
        background: none;
        color: #33413b;
        font: 600 13px/1 inherit;
        font-family: inherit;
        cursor: pointer;
      }
      .offer-toggle::after {
        content: "";
        width: 6px;
        height: 6px;
        border: solid currentColor;
        border-width: 0 1.6px 1.6px 0;
        transform: translateY(-2px) rotate(45deg);
        transition: transform 160ms ease;
      }
      .offer-toggle[aria-expanded="true"]::after { transform: translateY(1px) rotate(-135deg); }
      .offer-toggle:hover { color: #0f766e; }
      .offer-toggle:focus-visible { outline: 2px solid #0f766e; outline-offset: 2px; }
      .review-meta {
        flex-basis: 100%;
        margin: 0;
        color: #8a948f;
        font-size: 11px;
      }
      .review-meta .tertiary-link { font-size: 11px; }
      /* Tidy area: one Tidy button. Under Smart, a status line and the
         suggestions-off notice can sit below it; the status comes first so
         "Checking…" lands right under the button that was pressed. */
      .tidy-area { display: flex; flex-direction: column; }
      .tidy-area.pending { visibility: hidden; }
      .tidy-area > [hidden] { display: none !important; }
      .recommendation-card { display: flex; flex-direction: column; gap: 4px; text-align: center; }
      .recommendation-card:has(> :not(:empty)) { margin-top: 8px; }
      .recommendation-card > :empty { display: none; }
      .recommendation-card .suggestion-status { order: -1; }
      .recommendation-card p { font-size: 12px; line-height: 1.5; color: #6b7772; margin: 0; }
      .suggestion-link { padding: 2px 0; border: 0; background: none; color: #4a5651; font-family: inherit; font-size: 12px; font-weight: 600; line-height: 1.5; text-decoration: underline; text-underline-offset: 2px; cursor: pointer; }
      .suggestion-link:hover { color: #0f766e; }
      .suggestion-link:focus-visible { outline: 2px solid #0f766e; outline-offset: 2px; }
      .panel-error { color: #9b3828; padding: 0 18px 10px; font: 12px/1.5 system-ui; }
      .panel-error:empty { display: none; }
      button:disabled { opacity: .55; cursor: wait; }
      .review-shell {
        display: none;
        flex-direction: column;
        gap: 10px;
        margin-top: 4px;
      }
      .review-body {
        background: #fefefc;
        border: 1px solid #e3ddd2;
        border-radius: 10px;
        max-height: min(420px, 55vh);
        overflow-y: auto;
        padding: 6px 4px 6px 8px;
      }
      /* Cancel / Confirm tidy footer. Sits BELOW the list so the eye order is
         title → list → decide → act, matching standard form conventions. */
      .review-footer {
        align-items: center;
        display: flex;
        flex-wrap: wrap;
        gap: 8px 12px;
        justify-content: space-between;
        padding-top: 4px;
      }
      .review-group + .review-group {
        border-top: 1px dashed #e3ddd2;
        margin-top: 6px;
        padding-top: 6px;
      }
      .review-group-head {
        align-items: center;
        color: #63706b;
        display: flex;
        gap: 8px;
        font-size: 11px;
        font-weight: 700;
        letter-spacing: 0.04em;
        padding: 4px 6px 2px;
        text-transform: uppercase;
      }
      .review-group-count {
        color: #99a39f;
        font-weight: 500;
      }
      /* Checkboxes: ticked rows close, unticked rows stay open. Shared by
         the per-row control and the group header (which can be mixed). */
      .review-remove,
      .review-group-keep {
        position: relative;
        flex: none;
        width: 16px;
        height: 16px;
        margin: 0;
        padding: 0;
        border: 1.5px solid #0f766e;
        border-radius: 4px;
        background: #0f766e;
        cursor: pointer;
        transition: background 120ms ease, border-color 120ms ease;
      }
      .review-remove::after,
      .review-group-keep::after {
        content: "";
        position: absolute;
        left: 4px;
        top: 1px;
        width: 4px;
        height: 8px;
        border: solid #fff;
        border-width: 0 2px 2px 0;
        transform: rotate(45deg);
      }
      .review-remove[aria-checked="false"],
      .review-group-keep[aria-checked="false"] { background: #fff; border-color: #b6c3bd; }
      .review-remove[aria-checked="false"]::after,
      .review-group-keep[aria-checked="false"]::after { display: none; }
      .review-group-keep[aria-checked="mixed"]::after {
        left: 3px;
        top: 6px;
        width: 7px;
        height: 0;
        border-width: 0 0 2px 0;
        transform: none;
      }
      .review-remove:focus-visible,
      .review-group-keep:focus-visible { outline: 2px solid #f4bd45; outline-offset: 2px; }
      .review-items {
        list-style: none;
        margin: 0;
        padding: 0;
      }
      .review-item {
        align-items: center;
        border-radius: 6px;
        cursor: pointer;
        display: flex;
        gap: 8px;
        padding: 6px;
      }
      .review-item:hover { background: rgba(15, 118, 110, 0.04); }
      .review-item.removed .review-item-text { opacity: 0.55; }
      .review-item-text {
        display: flex;
        flex-direction: column;
        flex: 1 1 auto;
        gap: 1px;
        min-width: 0;
      }
      .review-item-title {
        color: #17201d;
        font-size: 13px;
        line-height: 1.3;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      /* Muted second line: domain truncates, "last active" age stays pinned. */
      .review-item-sub {
        align-items: baseline;
        display: flex;
        min-width: 0;
      }
      .review-item-domain {
        color: #99a39f;
        flex: 0 1 auto;
        font-size: 11px;
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .review-item-age {
        color: #b3bbb7;
        flex: none;
        font-size: 11px;
        white-space: nowrap;
      }
      .review-item-domain + .review-item-age::before {
        content: "·";
        margin: 0 4px;
      }
      .review-empty {
        color: #63706b;
        font-size: 12px;
        padding: 16px 12px;
        text-align: center;
      }

      .expanded-content {
        /* gap is 0 so the hero's mascot can use a negative bottom margin
           to overlap into the inner card. */
        display: flex;
        flex-direction: column;
        gap: 0;
        max-height: 60vh;
        overflow-y: auto;
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

      /* Inconspicuous "skip the review next time" toggle on the done card. It
         continues the white .actions footer (same bg, full-bleed to the card
         edges) so it reads as one panel, not a detached strip below it.
         Revealed only when .card.state-done.has-auto-tidy (LLM on). */
      .done-auto {
        display: none;
        align-items: center;
        gap: 8px;
        margin: 0 -14px -14px;
        padding: 2px 14px 13px;
        background: #fefefc;
        font-size: 11.5px;
        line-height: 1.3;
        color: #8a948f;
        cursor: pointer;
        user-select: none;
      }
      /* With the toggle present, the actions row hands its bottom bleed to
         .done-auto so the white footer reaches the card edge as one block. */
      /* Never while expanded: opening the full panel from the done card keeps
         .has-auto-tidy, and the toggle would land on top of the header. */
      .card.state-done.has-auto-tidy:not(.expanded) .actions { margin-bottom: 0; padding-bottom: 10px; }
      .card.state-done.has-auto-tidy:not(.expanded) .done-auto { display: flex; }
      .done-auto input { margin: 0; accent-color: #0f766e; cursor: pointer; }
      .done-auto:hover { color: #63706b; }

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

      /* ========== Expanded view: hero + inner card layout ========== */

      /* Card already carries the teal-cream tint in both states; expanded
         only needs to drop the outer padding so the hero + inner card own
         the full footprint. The inner card sits ~3% lighter than this
         outer frame — a tonal nudge, not a contrast jump. */
      .card.expanded {
        padding: 0;
      }
      .card.expanded::before { display: none; }

      .exp-hero {
        position: relative;
        padding: 10px 16px 0;
        min-height: 96px;
      }
      .exp-wordmark {
        margin: 0;
        font-size: 28px;
        font-weight: 400; /* Lilita One ships at weight 400 — it's already chunky by design */
        font-family: "Lilita One", "Arial Rounded MT Bold", "Helvetica Rounded", system-ui, sans-serif;
        letter-spacing: 0;
        line-height: 1.0;
        color: #1a2421;
      }
      .exp-wordmark span:first-child {
        display: inline-block;
        transform: rotate(-1.5deg);
      }
      /* Midpoint amber between the bright #f4bd45 used elsewhere (sparkle,
         brand bar, active button) and the safer #b7791f from earlier — sits
         around 3.4:1 contrast on cream, clears AA's 3:1 threshold for large
         text (≥18.66px); the wordmark renders at 26px+ everywhere. */
      .exp-wordmark-accent {
        color: #d59b32;
        display: inline-block;
        transform: rotate(1deg) translateY(1px);
      }

      /* Mascot is absolutely positioned inside .exp-hero so it can sit on
         the same vertical plane as the wordmark (overlapping it) and still
         dangle far enough down to peek over the inner card. Right-anchored
         clear of the close × button at top-right. */
      .exp-character-svg {
        position: absolute;
        top: -1px;
        right: 24px;
        width: 56%;
        max-width: 190px;
        height: auto;
        z-index: 2;
        /* Clickable now — toggles the .mascot-bubble. cursor: help signals
           "info about this thing" rather than a primary action. */
        pointer-events: auto;
        cursor: help;
        overflow: visible;
        filter: drop-shadow(0 3px 6px rgba(15, 118, 110, 0.16));
        transition: transform 140ms ease;
      }
      .exp-character-svg:hover { transform: translateY(-1px) scale(1.02); }
      /* Suppress the default blue focus ring on click. Keyboard focus
         (focus-visible) still shows a brand-amber outline for accessibility. */
      .exp-character-svg:focus { outline: none; }
      .exp-character-svg:focus-visible {
        outline: 2px solid #d59b32;
        outline-offset: 2px;
        border-radius: 4px;
      }

      /* Click-the-mascot speech bubble. Sits below the mascot's mouth,
         right-anchored so the text reads toward him with the tail pointing
         at his face. z-index 6 > the mascot's z-index 2 keeps text legible
         in any region of overlap. */
      .mascot-bubble {
        position: absolute;
        top: 71px;
        right: 150px;
        width: 200px;
        background: #ffffff;
        border: 1px solid #e8dfc7;
        border-radius: 12px;
        padding: 6px 4px 6px 0;
        font-size: 11px;
        font-weight: 500;
        line-height: 1.35;
        text-align: right;
        color: #1a2421;
        box-shadow: 0 6px 16px rgba(15, 118, 110, 0.16);
        opacity: 0;
        transform: scale(0.92) translateX(4px);
        transform-origin: right center;
        transition: opacity 160ms ease, transform 180ms cubic-bezier(0.2, 0.9, 0.3, 1.0);
        pointer-events: none;
        z-index: 6;
      }
      .mascot-bubble[data-show="true"] {
        opacity: 1;
        transform: scale(1) translateX(0);
        pointer-events: auto;
      }
      /* Tail pointing right toward the mouth. White square rotated 45° so
         only the upper-right two edges show as the tail tip. z-index: -1
         tucks the tail behind the bubble's text so a long line (the "ram"
         in "free up ram") reads on top of the diamond, while the part of
         the tail that sticks out past the bubble's right edge still shows. */
      .mascot-bubble::after {
        content: "";
        position: absolute;
        right: -6px;
        top: 50%;
        margin-top: -5px;
        width: 10px;
        height: 10px;
        background: #ffffff;
        border-top: 1px solid #e8dfc7;
        border-right: 1px solid #e8dfc7;
        transform: rotate(45deg);
        z-index: -1;
      }

      /* Saving-state speech bubble in the collapsed card. One line, sitting
         over the monster's left cheek with the tail landing at his mouth
         (the face features are in his right half, so the overlap doesn't
         cover the eyes). Shown only while the card is in the saving state. */
      .save-bubble {
        position: absolute;
        top: 54px;
        right: 142px;
        max-width: 232px;
        white-space: nowrap;
        background: #ffffff;
        border: 1px solid #e8dfc7;
        border-radius: 12px;
        padding: 6px 9px;
        font-size: 11px;
        font-weight: 500;
        line-height: 1.3;
        text-align: right;
        color: #1a2421;
        box-shadow: 0 6px 16px rgba(15, 118, 110, 0.16);
        opacity: 0;
        transform: scale(0.92) translateX(4px);
        transform-origin: right center;
        transition: opacity 200ms ease 120ms, transform 220ms cubic-bezier(0.2, 0.9, 0.3, 1.0) 120ms;
        pointer-events: none;
        z-index: 6;
      }
      .card.state-saving .save-bubble {
        opacity: 1;
        transform: scale(1) translateX(0);
      }
      .save-bubble::after {
        content: "";
        position: absolute;
        right: -6px;
        top: 50%;
        margin-top: -5px;
        width: 10px;
        height: 10px;
        background: #ffffff;
        border-top: 1px solid #e8dfc7;
        border-right: 1px solid #e8dfc7;
        transform: rotate(45deg);
        z-index: -1;
      }

      /* ===== Mascot animations (ported from NeatFreak.css) =====
         Mood-driven keyframes covering blink (always), snore (sleeping),
         clean-bob (happy + cleaning, different speeds), finger taps
         (cleaning), bounce (celebrating), shake + pupil scan + sweat drip
         + bang pop + mouth quiver (nervous). All target nf-state-{mood}
         on the .exp-character-svg root. */
      .nf-tilt {
        transform-origin: 100px 155px;
        transform-box: fill-box;
      }
      .nf-body-g {
        transform-origin: 100px 155px;
        transform-box: fill-box;
      }
      .nf-eyes {
        transform-origin: 85px 88px;
        transform-box: fill-box;
        animation: nf-blink 5.4s steps(1, end) infinite;
      }
      @keyframes nf-blink {
        0%, 94%, 96.5%, 100% { transform: scaleY(1); }
        95%, 96%             { transform: scaleY(0.05); }
      }

      /* sleeping */
      .nf-state-sleeping .nf-body-g { animation: nf-snore 4s ease-in-out infinite; }
      @keyframes nf-snore {
        0%, 100% { transform: translateY(0) scale(1, 1); }
        50%      { transform: translateY(-2px) scale(1.025, 0.97); }
      }
      .nf-z { transform-box: fill-box; transform-origin: center; opacity: 0; }
      .nf-z--1 { animation: nf-zfloat 3s ease-in-out infinite; }
      .nf-z--2 { animation: nf-zfloat 3s ease-in-out infinite -1s; }
      .nf-z--3 { animation: nf-zfloat 3s ease-in-out infinite -2s; }
      @keyframes nf-zfloat {
        0%   { transform: translate(0, 14px) scale(0.7); opacity: 0; }
        20%  { opacity: 1; }
        80%  { opacity: 1; }
        100% { transform: translate(-8px, -12px) scale(1.05); opacity: 0; }
      }

      /* happy + cleaning share keyframes, different speed */
      .nf-state-happy    .nf-body-g { animation: nf-clean-bob 1.6s ease-in-out infinite; }
      .nf-state-cleaning .nf-body-g { animation: nf-clean-bob 0.9s ease-in-out infinite; }
      @keyframes nf-clean-bob {
        0%, 100% { transform: rotate(-0.6deg) translateY(0); }
        50%      { transform: rotate(0.6deg)  translateY(-1px); }
      }
      .nf-state-cleaning .nf-finger {
        transform-box: fill-box;
        transform-origin: center bottom;
        animation: nf-finger-tap 0.5s ease-in-out infinite;
      }
      @keyframes nf-finger-tap {
        0%, 100% { transform: translateY(0); }
        50%      { transform: translateY(-4px); }
      }
      .nf-state-cleaning .nf-finger--left-0  { animation-delay: 0s; }
      .nf-state-cleaning .nf-finger--left-1  { animation-delay: -0.32s; }
      .nf-state-cleaning .nf-finger--left-2  { animation-delay: -0.12s; }
      .nf-state-cleaning .nf-finger--left-3  { animation-delay: -0.42s; }
      .nf-state-cleaning .nf-finger--right-0 { animation-delay: -0.22s; }
      .nf-state-cleaning .nf-finger--right-1 { animation-delay: -0.05s; }
      .nf-state-cleaning .nf-finger--right-2 { animation-delay: -0.38s; }
      .nf-state-cleaning .nf-finger--right-3 { animation-delay: -0.18s; }

      /* celebrating */
      .nf-state-celebrating .nf-body-g {
        animation: nf-bounce 1.05s cubic-bezier(.5, 0, .5, 1) infinite;
      }
      @keyframes nf-bounce {
        0%, 100% { transform: translateY(0)    scale(1, 1); }
        40%      { transform: translateY(0)    scale(1.05, 0.92); }
        65%      { transform: translateY(-7px) scale(0.96, 1.05); }
        85%      { transform: translateY(-2px) scale(1, 1); }
      }

      /* nervous — soft "scared puppy" trembling, not manic shake.
         Slower body wobble + smaller amplitude reads as a held breath
         rather than a jittery panic. Pupils scan slowly (looking around
         for the scary thing) — fast scan reads as strung out; slow scan
         reads as wary. */
      .nf-state-nervous .nf-body-g { animation: nf-shake 0.45s ease-in-out infinite; }
      .nf-state-nervous .nf-pupils { animation: nf-pupil-scan 2.8s ease-in-out infinite; }
      @keyframes nf-shake {
        0%, 100% { transform: translate(0, 0) rotate(0deg); }
        25%      { transform: translate(-0.5px, 0.2px) rotate(-0.3deg); }
        75%      { transform: translate(0.5px, -0.2px) rotate(0.3deg); }
      }
      @keyframes nf-pupil-scan {
        0%   { transform: translate(-3px, 1.5px); }
        50%  { transform: translate(0.5px, -3.5px); }
        100% { transform: translate(-3px, 1.5px); }
      }
      .nf-drop { transform-origin: center top; transform-box: fill-box; opacity: 0; }
      .nf-drop--1 { animation: nf-drip-side 2.6s ease-in infinite; }
      .nf-drop--2 { animation: nf-drip-side 2.6s ease-in infinite -1.3s; }
      @keyframes nf-drip-side {
        0%   { transform: translateY(0) scale(0); opacity: 0; }
        18%  { transform: translateY(0) scale(1); opacity: 1; }
        35%  { transform: translateY(0) scale(1); opacity: 1; }
        85%  { transform: translateY(38px) scale(1); opacity: 1; }
        100% { transform: translateY(50px) scale(0.7); opacity: 0; }
      }
      .nf-bang {
        transform-origin: 60px 55px;
        transform-box: fill-box;
        animation: nf-bang-pop 1.2s ease infinite;
      }
      @keyframes nf-bang-pop {
        0%, 100% { transform: scale(1) rotate(-3deg); }
        50%      { transform: scale(1.06) rotate(3deg); }
      }
      .nf-state-nervous .nf-mouth {
        transform-box: fill-box;
        transform-origin: center;
        animation: nf-mouth-quiver 0.5s ease-in-out infinite;
      }
      @keyframes nf-mouth-quiver {
        0%, 100% { transform: translate(0, 0); }
        50%      { transform: translate(0.5px, 0.5px); }
      }

      @media (prefers-reduced-motion: reduce) {
        .nf-body-g, .nf-pupils, .nf-drop, .nf-bang,
        .nf-z, .nf-eyes, .nf-mouth,
        .nf-state-cleaning .nf-finger {
          animation: none !important;
        }
      }

      .exp-inner-card {
        background: #fefefc;
        border-radius: 12px;
        margin: 0 12px 12px;
        padding: 16px 14px 14px;
        display: flex;
        flex-direction: column;
        gap: 12px;
        position: relative;
        z-index: 1;
        box-shadow: 0 1px 2px rgba(15, 118, 110, 0.05);
      }

      .scope-label {
        font-size: 10px;
        font-weight: 700;
        letter-spacing: 0.16em;
        color: #8a948f;
        margin: 0;
        text-transform: uppercase;
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

      /* Subtitle for the Tidy CTA showing eligible tab count.
         Only delta from the original popup sizing: title is 1px larger
         (15 → 16) for the "primary text slightly bigger" emphasis. Padding,
         weight, sub size, all unchanged. */
      .tidy-cta {
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 2px;
        padding: 13px 16px;
      }
      .tidy-cta-title {
        font-size: 16px;
        font-weight: 700;
      }
      .tidy-cta-sub {
        font-size: 12px;
        font-weight: 500;
        opacity: 0.85;
      }
      /* A prepared list: tick mark + count, at full strength. */
      .tidy-cta-sub.ready { display: inline-flex; align-items: center; gap: 6px; opacity: 1; }

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
        <!-- Mood-driven mascot; viewBox matches the expanded hero so the
             ambient sparkles/circles render around the character at the same
             scale as the expanded view. -->
        <svg class="mascot nf-state-happy" id="mascot" viewBox="0 0 320 200"
             xmlns="http://www.w3.org/2000/svg" aria-hidden="true"></svg>
        <div class="body">
          <p class="eyebrow" id="eyebrow" hidden>NEAT FREAK</p>
          <p class="title" id="title">Loading…</p>
          <p class="sub" id="sub"></p>
        </div>
        <!-- Saving-state speech bubble. Sits in the space to the LEFT of the
             collapsed mascot, tail pointing right at him. Only visible while
             .card.state-saving (CSS-gated). Reassures the user they can carry
             on in another tab — the panel re-injects into whatever tab is
             active when the save finishes, so it "finds" them. -->
        <div class="save-bubble" id="save-bubble" role="status" aria-live="polite">No need to wait — I'll find you.</div>
      </div>
      <div class="actions" id="actions"></div>

      <!-- Inconspicuous toggle on the done card: skip the review step next
           time. CSS-gated to the done card, revealed only when .has-auto-tidy
           is set (LLM on). It flips the existing defaultReviewBeforeClose. -->
      <label class="done-auto" id="done-auto">
        <input type="checkbox" id="opt-auto-tidy">
        <span>Tidy without reviewing next time</span>
      </label>

      <!-- Review-before-closing shell. Only visible when state.mode === "review".
           Holds the categorized list of tabs about to close (per-item × button
           to keep open) and its own Cancel / Confirm tidy footer. The standard
           .expand-wrapper below is hidden in review mode. -->
      <div class="panel-error" id="panel-error" role="status" aria-live="polite"></div>
      <div class="review-shell" id="review-shell" hidden>
        <div class="review-body" id="review-body"></div>
        <div class="review-footer" id="review-footer"></div>
      </div>

      <!-- Wrapper for the expanded view. .card.expanded triggers the wrapper
           to animate from grid-template-rows: 0fr → 1fr, which smoothly
           transitions the panel's height between collapsed and expanded
           without needing a JS-measured target height. -->
      <div class="expand-wrapper">
      <div class="expanded-content" id="expanded-content">
        <!-- Hero: tinted area with wordmark top-left and the static "happy"
             mascot peeking down over the inner card, with amber sparkles
             and decorative outline circles drawn in the same SVG. The
             character paths are ported from refactor-assets/dist/NeatFreak.jsx
             (happy state) and drawn into a wider viewBox so the decorations
             surround him. -->
        <header class="exp-hero">
          <h1 class="exp-wordmark"><span>Neat</span> <span class="exp-wordmark-accent">Freak</span></h1>
          <!-- Mascot SVG is rendered by JS (updateMascot) on first expand so
               the face + decorations can switch between mood states.
               data-action makes the mascot clickable — toggles the speech
               bubble below. updateMascot only writes innerHTML, so this
               attribute survives mood transitions. -->
          <svg class="exp-character-svg nf-state-happy" viewBox="0 0 320 200"
               xmlns="http://www.w3.org/2000/svg" aria-hidden="true"
               data-action="mascot-info" role="button" tabindex="0"
               aria-label="What does Tidy do?"></svg>
          <!-- Speech bubble shown when the mascot is clicked. Sits just to
               the left of the mascot's mouth; the tail on the right points
               at him to make the speaker clear. -->
          <div class="mascot-bubble" id="mascot-bubble" role="status" aria-live="polite">
            I'll stash open tabs and free up RAM
          </div>
        </header>

        <div class="exp-inner-card">
          <p class="scope-label">SCOPE</p>
          <div class="scope-row">
            <div class="scope-picker" id="scope-picker">
              <button class="scope-button" data-action="scope" data-scope-value="smart" type="button" title="Let Neat Freak pick which tabs to stash">Smart</button>
              <button class="scope-button" data-action="scope" data-scope-value="allWindows" type="button" title="Stash eligible tabs across every open window">All windows</button>
              <button class="scope-button" data-action="scope" data-scope-value="currentWindow" type="button" title="Stash eligible tabs in this window only">Current</button>
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

          <!-- One Tidy button (see renderTidyArea). Its second line says what a
               press does: open a prepared list, or have Smart pick now. The
               section under it carries status and the suggestions-off notice.
               Hidden until the first load so the line doesn't flash. -->
          <div class="tidy-area pending" id="tidy-area">
            <button class="tidy-cta" id="tidy-cta" data-action="tidy-expanded" type="button">
              <span class="tidy-cta-title">Tidy my tabs</span>
              <span class="tidy-cta-sub" id="tidy-cta-sub"></span>
            </button>
            <section id="recommendation-card" class="recommendation-card" aria-label="Tab suggestions">
              <div id="suggestion-content"></div>
              <p id="suggestion-status" class="suggestion-status" role="status"></p>
            </section>
          </div>

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
        </div><!-- /.exp-inner-card -->
      </div><!-- /.expanded-content -->
      </div><!-- /.expand-wrapper -->
    </div><!-- /.card -->
  `;
}

function applyState(host, state) {
  const shadow = host.shadowRoot;
  if (!shadow) return;
  if (state?.retiredSuggestion && (expandedMode || inPopupContext)) state = { mode: "idle" };
  if (state?.mode === "clutter" && !state.needsPreparation && (state.expired || !state.saveCount)) {
    // Retire old offers quietly, including when reopening a sleeping worker's
    // cached state. An already expanded panel stays open as a neutral workspace.
    state = { mode: expandedMode || inPopupContext ? "idle" : "hidden" };
  }
  const sameReview = state?.recommendation && currentState?.recommendation
    && state.planId === currentState.planId && JSON.stringify(state.groups) === JSON.stringify(currentState.groups);
  if (sameReview) {
    // Keep acknowledgments must not rebuild the list or reset its scroll.
    // Ignore older acknowledgments while this surface has optimistic edits.
    if (pendingKeepWrites) return;
    currentState = state;
    applyKeptItems(host, state.keepOpenSessionTabIds);
    return;
  }
  currentState = state;
  if (state?.mode !== "saving") checkingBeforeReview = false;
  if (state?.mode !== "idle") checkedEmpty = false;

  if (!state || state.mode === "hidden") {
    cancelAutoDismiss();
    expandedMode = false;
    unbindOutsideClickHandler();
    // In popup context, the host IS the popup window; close it cleanly so
    // we don't leave an empty popup behind (otherwise dismissPanel would
    // just remove the panel from document.body and leave a blank window).
    if (inPopupContext) {
      try { window.close(); } catch { /* fallthrough */ }
      return;
    }
    dismissPanel(host);
    return;
  }

  const card = shadow.getElementById("card");
  clearTimeout(dismissTimers.get(host));
  dismissTimers.delete(host);
  card.classList.remove("leaving");
  // Preserve the .expanded class through state transitions so a user mid-expansion
  // doesn't get yanked back to collapsed when, say, saving completes → done.
  const wasExpanded = card.classList.contains("expanded");
  card.className = `card state-${state.mode}${wasExpanded ? " expanded" : ""}${inPopupContext ? " in-popup" : ""}`;

  // Saving state is transient and we don't want the user expanding into a
  // half-loaded view; force-collapse the expanded UI if we end up there.
  // Use suppressExpansionUI (not collapseExpansion) so the panel keeps
  // showing the new saving state — collapseExpansion's idle-mode branch
  // would dismiss the panel entirely.
  if (["saving", "review"].includes(state.mode)) {
    suppressExpansionUI(host);
  }

  // Idle mode = user opened the panel via the toolbar icon (no clutter / done
  // context). Auto-expand and skip auto-dismiss — the user is here on purpose.
  if (state.mode === "idle" && !expandedMode) {
    expandPanel(host);
  }

  // Idle-mode sleeping mascot: leaving idle clears the roll so a future
  // idle entry gets a fresh 50/50. Entering idle (and not yet rolled) flips
  // the coin now so updateMascot below picks it up on first paint.
  if (state.mode !== "idle") {
    idleSleepingRolled = false;
    idleSleeping = false;
  } else if (!idleSleepingRolled) {
    idleSleeping = Math.random() < 0.5;
    idleSleepingRolled = true;
  }

  // Push the mascot to the right mood whenever state transitions. Cleaning
  // and celebrating come from state.mode; happy/sleeping/nervous come from
  // totalTabCount vs clutterThreshold (refreshed by loadExpandedData).
  // Updated for both surfaces — collapsed portrait and expanded hero share
  // the same mood, so this fires regardless of expandedMode.
  updateMascot(host);

  // Show the eyebrow only when expanded — it identifies the panel as Neat Freak
  // since the card is integrated into the page rather than chrome-managed.
  const eyebrowEl = shadow.getElementById("eyebrow");
  if (eyebrowEl) eyebrowEl.hidden = !expandedMode;

  const titleEl = shadow.getElementById("title");
  const subEl = shadow.getElementById("sub");
  const actionsEl = shadow.getElementById("actions");
  // Show the review shell only in review mode; hidden otherwise so stale
  // review content never leaks into other states.
  const reviewShell = shadow.getElementById("review-shell");
  if (reviewShell) reviewShell.hidden = state.mode !== "review";

  cancelAutoDismiss();

  if (state.mode === "idle") {
    // User-opened, no triggering event. Calm mascot, neutral copy, no action
    // button — the user is here for the expanded UI, not the collapsed pill.
    // The sleeping-mascot roll happens above (before updateMascot) so first
    // paint already reflects it.
    titleEl.textContent = "Neat Freak";
    subEl.textContent = "Ready when you are.";
    if (state.error) shadow.getElementById("panel-error").textContent = state.error;
    actionsEl.innerHTML = "";
    // No auto-dismiss for user-opened states.
    return;
  }

  if (state.mode === "clutter") {
    if (state.needsPreparation) {
      latestRecommendation = null;
      titleEl.textContent = `${Number(state.tabCount) || 0} tabs open`;
      subEl.textContent = "Find a suggestion to see how many you can put away.";
      actionsEl.innerHTML = '<button class="primary" data-action="find-recommendation" type="button">Find suggestions</button>';
      if (!expandedMode) scheduleAutoDismiss(host);
      return;
    }
    const count = Number(state.saveCount) || 0;
    latestRecommendation = state.planId ? state : null;
    titleEl.textContent = readyTitle(count);
    subEl.textContent = offerReassurance(state.folderCount);
    actionsEl.innerHTML = offerActions(false);
    // Only auto-dismiss when collapsed. If the user has explicitly expanded,
    // they're interacting — don't pull the rug out.
    if (!expandedMode) scheduleAutoDismiss(host);
    return;
  }

  if (state.mode === "saving") {
    // A press that stops at a list hasn't started closing anything yet.
    const working = checkingBeforeReview ? "Checking your tabs" : "Tidying your tabs";
    titleEl.textContent = working;
    // The reassurance ("No need to wait — I'll find you.") lives in the
    // .save-bubble speaking from the monster, shown via .card.state-saving CSS.
    // Clear the sub so the bubble + progress bar are the only message and
    // nothing competes in the left column. (The per-step label still drives
    // the popup's own progress UI; the in-page panel leads with reassurance.)
    subEl.textContent = "";
    // Indeterminate sliding bar carries the "in progress" signal, plus an
    // explicit "Close" affordance so it's clear the panel is non-blocking —
    // you can dismiss it (or swipe it away) and the result still finds you.
    actionsEl.innerHTML = `
      <div class="progress-bar" role="progressbar" aria-label="${working}"></div>
      <button class="saving-close" data-action="dismiss-saving" type="button">Hide</button>
    `;
    // Saving doesn't auto-dismiss — completion transitions us to done.
    return;
  }

  if (state.mode === "done") {
    const tabCount = Number(state.tabCount) || 0;
    if (tabCount === 0) {
      // "Nothing to tidy" path — user clicked Tidy when there were no
      // eligible tabs. Quick acknowledgment, no action button, auto-dismiss.
      titleEl.textContent = "Nothing to close";
      subEl.textContent = "Nothing to tidy right now.";
      actionsEl.innerHTML = "";
    } else {
      titleEl.textContent = `${tabCount} tab${tabCount === 1 ? "" : "s"} tucked away`;
      const parts = [];
      if (state.groupCount) parts.push(`${state.groupCount} folder${state.groupCount === 1 ? "" : "s"}`);
      if (state.looseCount) parts.push(`${state.looseCount} loose`);
      if (state.keepCount)  parts.push(`${state.keepCount} kept open`);
      const summary = parts.join(" · ") || "Ready in your saved sessions.";
      subEl.textContent = summary;
      // Tertiary link on the LEFT, primary CTA on the RIGHT — same layout
      // as the clutter card. expand-panel pops the panel open where the
      // just-saved session is the first item in the Recent list.
      const sid = String(state.sessionId || "");
      actionsEl.innerHTML = `
        <button class="tertiary-link" data-action="expand-panel" type="button">See closed tabs →</button>
        <button class="primary" data-action="open-manager" data-session-id="${escapeAttr(sid)}" type="button">Open manager</button>
      `;
    }
    if (state.protectedCount) subEl.textContent += ` ${state.protectedCount} changed or in-use tabs kept open.`;
    if (state.failedCount) {
      subEl.textContent += ` ${state.failedCount} could not close; saved in the manager.`;
      actionsEl.innerHTML = `<button class="primary" data-action="open-manager" data-session-id="${escapeAttr(state.sessionId || "")}" type="button">Open manager</button>`;
    }
    // Inconspicuous "make it automatic" toggle — only when the LLM is on and
    // something was actually tidied. Checked = automatic = review-before-close
    // currently off.
    const showAuto = Boolean(state.llmOn) && tabCount > 0 && !expandedMode;
    card.classList.toggle("has-auto-tidy", showAuto);
    if (showAuto) {
      const autoBox = shadow.getElementById("opt-auto-tidy");
      if (autoBox) autoBox.checked = !state.reviewBeforeClose;
    }
    if (!expandedMode) scheduleAutoDismiss(host);
    // If we entered done while expanded (e.g. user expanded mid-save), refresh
    // the recent-sessions list so the just-saved session appears.
    if (expandedMode && tabCount > 0) loadExpandedData(host);
    return;
  }

  if (state.mode === "review") {
    const groups = Array.isArray(state.groups) ? state.groups : [];
    if (state.recommendation) {
      renderOfferReview(host, state, groups);
      return;
    }
    const sid = String(state.sessionId || "");

    // Same header as a prepared list ("N tabs ready to tidy"); the title and
    // sub are filled by updateReviewConfirmCount via applyKeptItems below.
    // Clear the standard actions row — review mode renders its CTAs in
    // .review-footer at the BOTTOM of the list (below the items the user
    // is reviewing), not above them.
    actionsEl.innerHTML = "";

    const reviewBody = shadow.getElementById("review-body");
    if (reviewBody) {
      reviewBody.innerHTML = groups.length
        ? groups.map(renderReviewGroup).join("")
        : `<p class="review-empty">No tabs to review.</p>`;
    }
    const reviewFooter = shadow.getElementById("review-footer");
    if (reviewFooter) {
      // This list came from a press, not a standing offer, so the footer
      // offers Cancel instead of Hide list / Refresh.
      reviewFooter.innerHTML = `
        <button class="tertiary-link" data-action="cancel-review" data-session-id="${escapeAttr(sid)}" type="button">Cancel</button>
        <button class="primary" data-action="confirm-review" data-session-id="${escapeAttr(sid)}" type="button">Tidy now</button>
      `;
    }
    applyKeptItems(host, state.keepOpenSessionTabIds);
    // Review needs full attention — no auto-dismiss.
    return;
  }
}

function readyTitle(count) {
  return `${count} ${count === 1 ? "tab" : "tabs"} ready to tidy`;
}

function offerReassurance(folderCount) {
  const folders = Number(folderCount) || 0;
  return folders > 1 ? `Saved into ${folders} folders.` : "Saved to a folder.";
}

// "Picked 12 min ago", so a list made earlier reads as earlier. Local picks
// say so: they skip the AI and always open the list first.
function pickedAgo(recommendation) {
  const createdAt = Number(recommendation?.createdAt) || Date.now();
  const minutes = Math.max(0, Math.floor((Date.now() - createdAt) / 60_000));
  return `Picked ${minutes < 1 ? "just now" : `${minutes} min ago`}${recommendation?.local ? " without AI" : ""}`;
}

// Review sits to the left of Tidy now. It is a text disclosure for the list
// of tabs ("Hide list" once open); the chevron is CSS so busy-state text
// swaps can't drop it.
function offerActions(open) {
  return `
    <button class="offer-toggle" data-action="toggle-offer-list" type="button" aria-expanded="${open ? "true" : "false"}">${open ? "Hide list" : "Review"}</button>
    <button class="primary" data-action="tidy-recommendation" type="button">Tidy now</button>
  `;
}

// A suggested tidy in review mode is the same offer card with its list open.
// The header keeps the "N tabs ready to tidy" line, the list sits under it,
// and Hide list / Tidy now stay together at the bottom.
function renderOfferReview(host, state, groups) {
  const shadow = host.shadowRoot;
  if (offerListPlanId !== state.planId) {
    offerListPlanId = state.planId;
    offerListOpen = true;
  }
  shadow.getElementById("actions").innerHTML = offerActions(false);
  shadow.getElementById("review-body").innerHTML = groups.length
    ? groups.map(renderReviewGroup).join("")
    : `<p class="review-empty">No tabs to review.</p>`;
  shadow.getElementById("review-footer").innerHTML = `
    <p class="review-meta">${escapeText(pickedAgo(state))} · <button class="tertiary-link" data-action="refresh-recommendation" type="button">Refresh</button></p>
    ${offerActions(true)}
  `;
  applyKeptItems(host, state.keepOpenSessionTabIds);
  setOfferListOpen(host, offerListOpen);
}

function setOfferListOpen(host, open, { moveFocus = false } = {}) {
  offerListOpen = open;
  const shadow = host.shadowRoot;
  shadow.getElementById("card")?.classList.toggle("offer-collapsed", !open);
  shadow.querySelectorAll(".offer-toggle").forEach(btn => btn.setAttribute("aria-expanded", open ? "true" : "false"));
  // The two toggles live in different rows; keep focus on the visible one.
  if (moveFocus) shadow.querySelector(open ? ".review-footer .offer-toggle" : "#actions .offer-toggle")?.focus();
}

function setItemKept(item, kept) {
  item.classList.toggle("removed", kept);
  item.querySelector(".review-remove")?.setAttribute("aria-checked", kept ? "false" : "true");
}

function applyKeptItems(host, keepIds) {
  const shadow = host.shadowRoot;
  const kept = new Set(keepIds || []);
  shadow.querySelectorAll(".review-item").forEach(item => setItemKept(item, kept.has(item.dataset.sessionTabId)));
  shadow.querySelectorAll(".review-group").forEach(syncGroupKeepButton);
  updateReviewConfirmCount(host);
}

// Renders one folder group inside the review list. Each row has a checkbox;
// ticked rows close, unticked rows (class "removed" from the close pile) stay
// open.
function renderReviewGroup(group) {
  const name = String(group?.name || "Other");
  const tabs = Array.isArray(group?.tabs) ? group.tabs : [];
  return `
    <div class="review-group">
      <div class="review-group-head">
        <button class="review-group-keep" data-action="toggle-review-group" type="button" role="checkbox" aria-checked="true" aria-label="Close all tabs in ${escapeAttr(name)}"></button>
        <span class="review-group-name">${escapeText(name)}</span>
        <span class="review-group-count">${tabs.length}</span>
      </div>
      <ul class="review-items">
        ${tabs.map(renderReviewItem).join("")}
      </ul>
    </div>
  `;
}

// Mirrors a group's rows onto its header checkbox: ticked when every tab
// closes, unticked when every tab is kept, mixed otherwise.
function syncGroupKeepButton(group) {
  if (!group) return;
  const btn = group.querySelector(".review-group-keep");
  if (!btn) return;
  const items = [...group.querySelectorAll(".review-item")];
  const keptCount = items.filter((el) => el.classList.contains("removed")).length;
  btn.setAttribute("aria-checked", keptCount === 0 ? "true" : keptCount === items.length ? "false" : "mixed");
}

// Live count update for the header and CTA. Fires on every toggle so the
// copy always matches what Tidy now will actually close.
function updateReviewConfirmCount(host) {
  const shadow = host?.shadowRoot;
  if (!shadow) return;
  const titleEl = shadow.getElementById("title");
  const subEl = shadow.getElementById("sub");
  if (!subEl || !titleEl) return;
  const total = shadow.querySelectorAll(".review-item").length;
  const removed = shadow.querySelectorAll(".review-item.removed").length;
  const remaining = Math.max(0, total - removed);
  // A prepared list and a list from a plain Tidy press read the same.
  const offer = Boolean(currentState?.recommendation);
  const folders = [...shadow.querySelectorAll(".review-group")]
    .filter(group => group.querySelector(".review-item:not(.removed)")).length;
  titleEl.textContent = remaining ? readyTitle(remaining) : "Keeping every tab open";
  subEl.textContent = remaining === 0 ? "Nothing will close."
    : removed > 0 ? `${removed} kept open. The rest are saved.`
    : offer && offerTidyPendingPlanId === currentState.planId ? "Check the list, then press Tidy now."
    : offerReassurance(folders);
  if (offer) {
    shadow.querySelectorAll('[data-action="tidy-recommendation"]').forEach(btn => { btn.disabled = remaining === 0; });
    return;
  }
  const confirm = shadow.querySelector('[data-action="confirm-review"]');
  if (confirm) confirm.textContent = remaining ? "Tidy now" : "Keep all open";
}

function renderReviewItem(tab) {
  const sessionTabId = String(tab?.sessionTabId || "");
  const title = String(tab?.title || tab?.url || "Untitled");
  const domain = String(tab?.domain || "");
  // Pre-formatted by the worker (see showPanelReview). Empty when the tab has
  // no lastAccessed — we render no time rather than a misleading "just now".
  const lastActive = String(tab?.lastActive || "");
  return `
    <li class="review-item" data-session-tab-id="${escapeAttr(sessionTabId)}" data-action="toggle-review-item">
      <button class="review-remove" data-action="toggle-review-item" type="button" role="checkbox" aria-checked="true" aria-label="Close ${escapeAttr(title)}"></button>
      <div class="review-item-text">
        <span class="review-item-title">${escapeText(title)}</span>
        <span class="review-item-sub">
          ${domain ? `<span class="review-item-domain">${escapeText(domain)}</span>` : ""}
          ${lastActive ? `<span class="review-item-age" title="Last active in this tab">${escapeText(lastActive)}</span>` : ""}
        </span>
      </div>
    </li>
  `;
}

function handlePanelClick(host, event) {
  const target = event.target;
  // Element covers both HTMLElement and SVGElement — the close × button
  // wraps an inline SVG, and clicks on the SVG paths fall in here too.
  // Previously instanceof HTMLElement excluded them and silently dropped
  // the click (broken × button in the popup).
  if (!(target instanceof Element)) return;

  // If the mascot's speech bubble is open, any click outside both the
  // mascot and the bubble itself dismisses it. (Mascot click is handled
  // below by the toggle handler so we don't preempt the toggle.)
  const shadow = host.shadowRoot;
  const bubble = shadow?.getElementById("mascot-bubble");
  if (bubble?.getAttribute("data-show") === "true") {
    const isMascot = target.closest("[data-action='mascot-info']");
    const isBubble = target.closest(".mascot-bubble");
    if (!isMascot && !isBubble) bubble.removeAttribute("data-show");
  }

  const actionEl = target.closest("[data-action]");
  const action = actionEl?.dataset?.action || "";

  // No action attribute — check if the body was clicked to trigger expand.
  if (!action) {
    if (!expandedMode && target.closest("[data-clickable-body]")) {
      // On a suggested tidy, clicking the card opens (or folds) its tab list
      // rather than the full panel.
      if (currentState?.recommendation && currentState.mode === "review") {
        setOfferListOpen(host, !offerListOpen);
        return;
      }
      if (currentState?.mode === "clutter" && latestRecommendation?.planId) {
        openOfferList(host, shadow.querySelector("#actions .offer-toggle"));
        return;
      }
      if (currentState && currentState.mode !== "saving" && currentState.mode !== "hidden" && currentState.mode !== "review") {
        expandPanel(host);
      }
    }
    return;
  }

  // Wake the sleeping mascot on any action click. We keep idleSleepingRolled
  // true so a re-render doesn't re-roll mid-session — the user has engaged,
  // the mascot stays awake until next idle entry.
  if (idleSleeping) {
    idleSleeping = false;
    updateMascot(host);
  }

  // Collapsed action buttons.
  // "dismiss-saving" is the explicit Close text in the saving state; it routes
  // through the same saving-dismiss path as the × below.
  if (action === "dismiss" || action === "dismiss-saving") {
    cancelAutoDismiss();
    // Dismissing during review = discard. The session was created moments
    // ago and the tabs are still open; nothing's lost. Keeping it around in
    // a "review" limbo would just leave orphan state in storage.
    if (currentState?.mode === "review") {
      if (currentState.recommendation) { dismissRecommendation(host); return; }
      safeSendMessage({ type: "PANEL_DISCARD_REVIEW", sessionId: currentState.sessionId || "" });
      if (inPopupContext) {
        try { window.close(); } catch { /* fallthrough */ }
        return;
      }
      dismissPanel(host);
      return;
    }
    // Dismissing during a save: the save keeps running in the background and
    // the done result still surfaces when finished. PANEL_DISMISS_SAVING tells
    // the background to stop re-showing the loader on later progress steps.
    if (currentState?.mode === "saving") {
      safeSendMessage({ type: "PANEL_DISMISS_SAVING" });
      if (inPopupContext) {
        try { window.close(); } catch { /* fallthrough */ }
        return;
      }
      dismissPanel(host);
      return;
    }
    if (inPopupContext) {
      // × in the popup means "close this popup window" — no panel state to clear.
      try { window.close(); } catch { /* fallthrough */ }
      return;
    }
    safeSendMessage({ type: "PANEL_DISMISS" });
    dismissPanel(host);
    return;
  }
  if (action === "enable-suggestions") {
    runRecommendationAction(host, actionEl, { type: "SAVE_SETTINGS", settings: { prepareSuggestions: true } })
      .then(saved => { if (saved) loadExpandedData(host); });
    return;
  }
  if (action === "retry-suggestion-load") {
    loadExpandedData(host);
    return;
  }
  if (action === "toggle-offer-list") {
    cancelAutoDismiss();
    if (currentState?.recommendation && currentState.mode === "review") {
      setOfferListOpen(host, !offerListOpen, { moveFocus: true });
      return;
    }
    openOfferList(host, actionEl);
    return;
  }
  if (action === "tidy-recommendation") {
    cancelAutoDismiss();
    if (currentState?.recommendation && currentState.mode === "review") {
      confirmOfferReview(host, actionEl);
      return;
    }
    // Local picks must be seen before they close: Tidy opens the list with
    // Tidy now ready, and the card says why nothing closed yet.
    if (latestRecommendation?.reviewRequired) {
      offerTidyPendingPlanId = latestRecommendation.planId;
      openOfferList(host, actionEl);
      return;
    }
    runRecommendationAction(host, actionEl, { type: "EXECUTE_RECOMMENDATION", planId: latestRecommendation?.planId,
      keepOpenSessionTabIds: [], offeredCount: latestRecommendation?.saveCount });
    return;
  }
  if (["find-recommendation", "review-recommendation", "execute-recommendation", "refresh-recommendation"].includes(action)) {
    cancelAutoDismiss();
    const reviewing = Boolean(currentState?.recommendation);
    const planId = reviewing ? currentState.planId : latestRecommendation?.planId;
    const keepOpenSessionTabIds = reviewing ? reviewKeepIds(host) : [];
    const type = ["find-recommendation", "refresh-recommendation"].includes(action) ? "REFRESH_RECOMMENDATION"
      : action === "review-recommendation" ? "REVIEW_RECOMMENDATION" : "EXECUTE_RECOMMENDATION";
    runRecommendationAction(host, actionEl, { type, planId, review: reviewing || action === "find-recommendation", keepOpenSessionTabIds,
      offeredCount: latestRecommendation?.saveCount });
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

  // Review-before-closing actions
  if (action === "toggle-review-item") {
    // Either the row (<li>) or the button can carry data-action — both fire
    // this branch. closest() returns the li in either case (it includes
    // self), and the aria-label always goes on the button so SR users hear
    // the right state no matter where the click came from.
    const li = actionEl.closest(".review-item");
    if (!li) return;
    setItemKept(li, !li.classList.contains("removed"));
    // Reflect the row on its group's header checkbox.
    syncGroupKeepButton(li.closest(".review-group"));
    updateReviewConfirmCount(host);
    persistReviewKeeps(host);
    return;
  }
  if (action === "toggle-review-group") {
    // Keep (or un-keep) every tab in the folder at once. If the whole group
    // is already kept, this releases it; otherwise (all or some ticked) it
    // keeps all of them, the cautious direction.
    const group = actionEl.closest(".review-group");
    if (!group) return;
    const items = [...group.querySelectorAll(".review-item")];
    const allKept = items.length > 0 && items.every((el) => el.classList.contains("removed"));
    items.forEach((el) => setItemKept(el, !allKept));
    syncGroupKeepButton(group);
    updateReviewConfirmCount(host);
    persistReviewKeeps(host);
    return;
  }
  if (action === "confirm-review") {
    cancelAutoDismiss();
    if (currentState?.recommendation) { confirmOfferReview(host, actionEl); return; }
    const sessionId = actionEl.dataset.sessionId || "";
    runRecommendationAction(host, actionEl, { type: "PANEL_CONFIRM_REVIEW", sessionId, keepOpenSessionTabIds: reviewKeepIds(host) });
    return;
  }
  if (action === "cancel-review") {
    cancelAutoDismiss();
    const sessionId = actionEl.dataset.sessionId || "";
    if (currentState?.recommendation) { dismissRecommendation(host); return; }
    safeSendMessage({ type: "PANEL_DISCARD_REVIEW", sessionId });
    if (inPopupContext) {
      try { window.close(); } catch { /* fallthrough */ }
      return;
    }
    dismissPanel(host);
    return;
  }

  // Expanded-view actions
  if (action === "scope") {
    const newScope = actionEl.dataset.scopeValue;
    if (newScope) {
      selectedScope = newScope;
      updateScopeButtons(host);
      renderTidyArea(host);
      refreshPreview(host);
      // Persist so this scope is the default the next time the panel opens.
      safeSendMessage({ type: "SAVE_SETTINGS", settings: { defaultScope: newScope } });
    }
    return;
  }
  if (action === "tidy-expanded") {
    tidyFromButton(host, actionEl);
    return;
  }
  if (action === "open-manager-link") {
    safeSendMessage({ type: "PANEL_OPEN_MANAGER" });
    return;
  }
  if (action === "expand-panel") {
    // Tertiary "See closed tabs →" link in the done state — pops the panel
    // open where the just-saved session sits at the top of the Recent list.
    if (!expandedMode) expandPanel(host);
    return;
  }
  if (action === "mascot-info") {
    // Click on the mascot in the expanded hero — toggle the speech bubble
    // that explains what Tidy does. Stop here so the body-click handler
    // (which would try to expand the panel) doesn't also fire.
    event.stopPropagation();
    toggleMascotBubble(host);
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
  // Wrapper visibility is now controlled by .card.expanded via CSS grid trick
  // (see .expand-wrapper rules). No need to toggle the hidden attribute here.
  const eyebrowEl = shadow.getElementById("eyebrow");
  if (eyebrowEl) eyebrowEl.hidden = false;
  // Paint an initial mascot now using whatever mood we can infer from
  // currentState (cleaning / celebrating still apply pre-data-load).
  // loadExpandedData will repaint once it has totalTabCount + threshold.
  updateMascot(host);
  bindOutsideClickHandler(host);
  loadExpandedData(host);
}

// State-driven UI suppression. Does NOT decide on dismissal — just hides the
// expanded view's DOM and unbinds outside-click. Use when an underlying mode
// transition (e.g. → saving) requires collapsing without dismissing.
function suppressExpansionUI(host) {
  expandedMode = false;
  const shadow = host.shadowRoot;
  const card = shadow.getElementById("card");
  card.classList.remove("expanded");
  // Wrapper collapses back to 0fr automatically via the CSS transition once
  // .expanded is removed. No need to toggle the hidden attribute here.
  const eyebrowEl = shadow.getElementById("eyebrow");
  if (eyebrowEl) eyebrowEl.hidden = true;
  // Dismiss the mascot's speech bubble too — it lives inside the expanded
  // view so a stale "show" state would re-appear on next expand.
  const bubble = shadow.getElementById("mascot-bubble");
  if (bubble) bubble.removeAttribute("data-show");
  unbindOutsideClickHandler();
}

// Toggle the mascot's speech bubble (data-show attribute drives the CSS
// transition). Clicking the mascot a second time hides it.
function toggleMascotBubble(host) {
  const shadow = host.shadowRoot;
  const bubble = shadow?.getElementById("mascot-bubble");
  if (!bubble) return;
  if (bubble.getAttribute("data-show") === "true") {
    bubble.removeAttribute("data-show");
  } else {
    bubble.setAttribute("data-show", "true");
  }
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
  // In popup context, "outside" doesn't make sense — the popup window is the
  // frame, and Chrome auto-closes it on outside click anyway. Skip the binding
  // so clicks on body padding around the card don't dismiss the panel.
  if (inPopupContext) return;
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

// Swipe-to-dismiss for the floating panel. Only fires in the in-page
// (injected) context — the toolbar popup is a Chrome-managed window that
// can't be swiped. Engages once horizontal movement crosses ENGAGE_THRESHOLD
// (below that, clicks fire normally). On release past 30% of card width or
// 80px (whichever is larger), the card flies off in the swipe direction
// and PANEL_DISMISS is sent.
function bindSwipeToDismiss(host, card) {
  if (inPopupContext) return;

  const ENGAGE_THRESHOLD = 8;
  let drag = null;

  card.addEventListener("pointerdown", (event) => {
    // Only primary mouse button or touch — ignore right/middle-click, pen, etc.
    if (event.button !== 0 && event.pointerType !== "touch") return;
    // Don't initiate drag on interactive elements — let normal clicks run.
    const interactive = event.target instanceof Element
      && event.target.closest("button, input, select, textarea, a, [data-action]");
    if (interactive) return;
    // States that own their own action surface or have no card to swipe.
    // Saving IS swipe-dismissible (the save keeps running in the background);
    // review has its own Cancel/Confirm footer; hidden has nothing to swipe.
    if (expandedMode) return;
    if (!currentState) return;
    if (currentState.mode === "review" || currentState.mode === "hidden") return;
    // Expanded view + review-shell contain scrollable content — never
    // co-opt drags inside them as swipes even if the user happened to
    // start outside the standard collapsed row.
    if (event.target instanceof Element && event.target.closest(".expand-wrapper, .review-shell")) return;

    drag = {
      startX: event.clientX,
      currentX: event.clientX,
      engaged: false,
      pointerId: event.pointerId,
      cardWidth: card.offsetWidth
    };
  });

  card.addEventListener("pointermove", (event) => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    const deltaX = event.clientX - drag.startX;
    if (!drag.engaged) {
      if (Math.abs(deltaX) < ENGAGE_THRESHOLD) return;
      drag.engaged = true;
      try { card.setPointerCapture(drag.pointerId); } catch { /* best-effort */ }
      card.style.transition = "none";
      card.style.cursor = "grabbing";
    }
    drag.currentX = event.clientX;
    const fadeRange = Math.max(120, drag.cardWidth * 0.5);
    card.style.transform = `translateX(${deltaX}px)`;
    card.style.opacity = String(Math.max(0.25, 1 - Math.abs(deltaX) / fadeRange));
  });

  const endDrag = (event) => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    const deltaX = drag.currentX - drag.startX;
    const dismissThreshold = Math.max(80, drag.cardWidth * 0.3);
    const wasEngaged = drag.engaged;
    drag = null;
    card.style.cursor = "";
    if (!wasEngaged) return; // never crossed the engage threshold — normal click runs

    if (Math.abs(deltaX) > dismissThreshold) {
      // Commit dismiss. Animate off-screen in the swipe direction, then
      // remove the host BEFORE sending PANEL_DISMISS so the storage-change
      // listener doesn't try to fire its own dismiss animation on top.
      const direction = deltaX > 0 ? 1 : -1;
      const exitX = direction * (card.offsetWidth + 60);
      // Swiping away the saving loader stops it re-popping on later steps but
      // lets the save finish + surface its result; any other state is a plain
      // dismiss.
      const dismissType = currentState?.mode === "saving" ? "PANEL_DISMISS_SAVING" : "PANEL_DISMISS";
      card.style.transition = "transform 200ms ease-out, opacity 200ms ease-out";
      card.style.transform = `translateX(${exitX}px)`;
      card.style.opacity = "0";
      setTimeout(() => {
        host.remove();
        safeSendMessage({ type: dismissType });
      }, 200);
    } else {
      // Spring back, then clear inline overrides so future CSS-driven
      // changes aren't fighting a stale inline transition.
      card.style.transition = "transform 220ms cubic-bezier(0.2, 0.9, 0.3, 1), opacity 200ms ease-out";
      card.style.transform = "translateX(0)";
      card.style.opacity = "1";
      setTimeout(() => {
        if (!drag) {
          card.style.transition = "";
          card.style.transform = "";
          card.style.opacity = "";
        }
      }, 260);
    }
  };

  card.addEventListener("pointerup", endDrag);
  card.addEventListener("pointercancel", endDrag);
}

// A prepared offer changes nothing about the layout: the Tidy button stays,
// and only its second line changes (see renderTidySub). The section under the
// button holds two optional lines: the answer to a check that found nothing,
// and the suggestions-off notice. It must be exactly empty when there is
// neither, so the CSS :empty rules can drop it.
function renderRecommendation(host, recommendation) {
  if (recommendation?.expired) recommendation = null;
  latestRecommendation = recommendation;
  const content = host.shadowRoot?.getElementById("suggestion-content");
  if (!content) return;
  const none = checkedEmpty && recommendation && !recommendation.saveCount ? '<p class="suggestion-none">No tabs suggested right now.</p>' : "";
  const notice = latestSettings.prepareSuggestions === false ? `<p class="suggestion-notice">Background suggestions are off. Enabling them checks inactive tabs before you ask. With AI on, titles, URLs and optional page summaries are sent for processing.</p><button class="suggestion-link" data-action="enable-suggestions" type="button">Enable background suggestions</button>` : "";
  content.innerHTML = none + notice;
  renderTidyArea(host);
}

// One Tidy button for every scope. The section under it (status + notice)
// only applies to Smart.
function renderTidyArea(host) {
  const card = host.shadowRoot?.getElementById("recommendation-card");
  if (card) card.hidden = selectedScope !== "smart";
  renderTidySub(host);
}

// The prepared list a Tidy press would use: only Smart has one.
function preparedOffer() {
  return selectedScope === "smart" && (latestRecommendation?.saveCount || 0) > 0 ? latestRecommendation : null;
}

// Local picks always open their list first (the worker refuses to close them
// unseen). AI picks follow the "Review before closing" option.
function offerOpensList(host, offer) {
  return Boolean(offer.reviewRequired) || host.shadowRoot.getElementById("opt-review")?.checked !== false;
}

// The Tidy button's second line says what a press will do.
function renderTidySub(host) {
  const sub = host.shadowRoot?.getElementById("tidy-cta-sub");
  if (!sub) return;
  const offer = preparedOffer();
  sub.classList.toggle("ready", Boolean(offer));
  if (offer) {
    const count = offer.saveCount;
    sub.innerHTML = `${READY_MARK}<span>${count} ${count === 1 ? "tab" : "tabs"} ready to ${offerOpensList(host, offer) ? "review" : "tidy"}</span>`;
    return;
  }
  if (offerChecking && selectedScope === "smart") {
    sub.textContent = "Checking your tabs";
    return;
  }
  // A count from another scope would be wrong; hold the line's height until
  // the recount lands.
  sub.textContent = lastPreviewScope !== selectedScope ? " "
    : lastPreviewCount ? scopeSubtitle(selectedScope, lastPreviewCount) : "No savable tabs in scope";
}

// The one Tidy button. With a prepared list it shows that list (or, with
// review off and AI picks, closes them); without one it runs a tidy now.
async function tidyFromButton(host, button) {
  const offer = preparedOffer();
  if (!offer) {
    // A press before the opening check finishes is a press with nothing
    // prepared; the check's late answer is ignored.
    if (offerChecking) { offerChecking = false; recommendationRequest += 1; }
    triggerExpandedSave(host);
    return;
  }
  cancelAutoDismiss();
  if (!offerOpensList(host, offer)) {
    runRecommendationAction(host, button, { type: "EXECUTE_RECOMMENDATION", planId: offer.planId,
      keepOpenSessionTabIds: [], offeredCount: offer.saveCount });
    return;
  }
  offerListOpen = true;
  const response = await runRecommendationAction(host, button, { type: "REVIEW_RECOMMENDATION", planId: offer.planId });
  // The list can empty out between the render and the press (tabs closed or
  // visited since); then this is a plain press with nothing prepared.
  if (response && response.reviewOpened === false) triggerExpandedSave(host);
}

// Opening the panel with AI on and no list (or one over 30 minutes old) runs
// a fresh check. The old list is not offered meanwhile.
async function checkOfferOnOpen(host) {
  offerChecking = true;
  const request = ++recommendationRequest;
  renderRecommendation(host, null);
  const response = await safeSendMessageAwait({ type: "PREPARE_RECOMMENDATION" });
  if (request !== recommendationRequest || !offerChecking) return;
  offerChecking = false;
  const current = document.getElementById(HOST_ID);
  if (!current) return;
  if (response?.ok && !response.superseded) {
    checkedEmpty = Boolean(response.recommendation) && !response.recommendation.saveCount;
    renderRecommendation(current, response.recommendation);
  } else {
    renderTidySub(current);
  }
}

async function readCurrentSuggestion() {
  const host = document.getElementById(HOST_ID);
  if (!host || recommendationBusy || offerChecking) return;
  const request = recommendationRequest;
  const response = await safeSendMessageAwait({ type: "GET_RECOMMENDATION" });
  if (request === recommendationRequest && response?.ok) renderRecommendation(host, response.recommendation);
}

function showSuggestionLoadFailure(host) {
  latestRecommendation = null;
  host.shadowRoot.getElementById("suggestion-status").textContent = "Couldn’t load tab suggestions.";
  host.shadowRoot.getElementById("suggestion-content").innerHTML = '<button class="suggestion-link" data-action="retry-suggestion-load" type="button">Try again</button>';
  renderTidyArea(host);
}

async function dismissRecommendation(host) {
  await keepWriteQueue;
  await safeSendMessageAwait({ type: "PANEL_DISMISS" });
  if (inPopupContext) { try { window.close(); } catch { /* ignore */ } }
  else dismissPanel(host);
}

function reviewKeepIds(host) {
  return [...host.shadowRoot.querySelectorAll(".review-item.removed")].map(item => item.dataset.sessionTabId);
}

// Opening the list from a one-line offer starts the review in the worker,
// which is what lets a local pick close afterwards.
function openOfferList(host, button) {
  if (!button) return;
  offerListOpen = true;
  runRecommendationAction(host, button, { type: "REVIEW_RECOMMENDATION", planId: latestRecommendation?.planId });
}

function confirmOfferReview(host, button) {
  const items = [...host.shadowRoot.querySelectorAll(".review-item")];
  runRecommendationAction(host, button, {
    type: "EXECUTE_RECOMMENDATION", planId: currentState.planId, keepOpenSessionTabIds: reviewKeepIds(host),
    offeredCount: items.length, offeredTabIds: items.map(item => item.dataset.sessionTabId)
  });
}

function persistReviewKeeps(host) {
  if (!currentState?.recommendation) return;
  const message = { type: "SET_RECOMMENDATION_KEEP", planId: currentState.planId, keepOpenSessionTabIds: reviewKeepIds(host) };
  currentState = { ...currentState, keepOpenSessionTabIds: message.keepOpenSessionTabIds };
  pendingKeepWrites += 1;
  keepWriteQueue = keepWriteQueue.then(() => safeSendMessageAwait(message)).finally(() => { pendingKeepWrites -= 1; });
}

async function runRecommendationAction(host, button, message) {
  if (recommendationBusy) return;
  recommendationBusy = true;
  recommendationRequest += 1;
  // Buttons in the tidy area report under the Tidy button and keep their label.
  const inSuggestion = Boolean(button.closest("#tidy-area"));
  const error = host.shadowRoot.getElementById(inSuggestion ? "suggestion-status" : "panel-error");
  error.textContent = "";
  button.disabled = true;
  const previousText = button.textContent;
  const progress = message.type === "REFRESH_RECOMMENDATION" ? "Checking tabs…" : "Checking…";
  if (inSuggestion) error.textContent = progress;
  else button.textContent = progress;
  try {
    await keepWriteQueue;
    const response = await safeSendMessageAwait(message);
    if (!response?.ok) {
      error.textContent = response?.error || "Couldn't finish. Your tabs are still available. Try again.";
      return;
    }
    error.textContent = "";
    if (response.superseded) return;
    if (message.type === "REFRESH_RECOMMENDATION") checkedEmpty = Boolean(response.recommendation) && !response.recommendation.saveCount;
    if ("recommendation" in response) renderRecommendation(host, response.recommendation);
    if (response.refreshDeferred) error.textContent = "Just checked these tabs. Refresh is available again after 30 seconds.";
    else if (message.type === "REFRESH_RECOMMENDATION" && !response.recommendation) error.textContent = "Couldn’t finish checking tabs. Try again in a moment.";
    return response;
  } finally {
    recommendationBusy = false;
    button.disabled = false;
    if (!inSuggestion) button.textContent = previousText;
  }
}

async function loadExpandedData(host) {
  const request = recommendationRequest;
  const status = host.shadowRoot.getElementById("suggestion-status");
  try {
    const response = await safeSendMessageAwait({ type: "GET_POPUP_STATE" });
    if (!response?.ok) {
      if (request === recommendationRequest && !recommendationBusy) showSuggestionLoadFailure(host);
      return;
    }
    if (response.settings?.defaultScope) {
      selectedScope = response.settings.defaultScope;
    }
    // A waiting offer is the first thing to show, so open on Smart for this
    // view (the saved default is left alone until the user picks a scope).
    const offerWaiting = (response.recommendation?.saveCount || 0) > 0 && !response.recommendation.expired;
    const scopeOverridden = offerWaiting && selectedScope !== "smart";
    if (scopeOverridden) selectedScope = "smart";
    // Only flip the valid flag once we actually got a finite number back.
    // If background returns nothing, determineMood will keep falling back
    // to "happy" instead of misreading undefined as 0 → sleeping.
    const incomingTotal = Number(response.totalTabCount);
    if (Number.isFinite(incomingTotal)) {
      totalTabCount = incomingTotal;
      totalTabCountValid = true;
    }
    clutterThreshold = Number(response.settings?.clutterThreshold) || clutterThreshold;
    latestSettings = response.settings || {};
    renderScopePicker(host);
    // Before the Tidy button's line: "Review before closing" changes its wording.
    renderMoreOptions(host, response.settings);
    renderPreview(host, response.preview);
    // The preview above was counted for the saved scope; recount for Smart.
    if (scopeOverridden) refreshPreview(host);
    if (request === recommendationRequest && !recommendationBusy) {
      status.textContent = "";
      if (response.recommendationNeedsRun) checkOfferOnOpen(host);
      else renderRecommendation(host, response.recommendation);
    }
    renderSessions(host, response.sessions || []);
    bindSearchInput(host);
    updateMascot(host);
  } catch (err) {
    if (request === recommendationRequest && !recommendationBusy) showSuggestionLoadFailure(host);
    console.warn("[Neat Freak] Load expanded data failed:", err?.message || err);
  } finally {
    renderTidyArea(host);
    host.shadowRoot.getElementById("tidy-area")?.classList.remove("pending");
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
        ? `<img class="folder-tab-favicon" src="${escapeAttr(tab.favIconUrl)}" alt="">`
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

// ===== Mascot mood + render =====

function determineMood() {
  if (currentState?.mode === "saving") return "cleaning";
  if (currentState?.mode === "done") return "celebrating";
  // Clutter mode is by definition "too many tabs" — background only fires
  // it when the user is over their threshold. Honor that directly instead
  // of re-checking against the panel-local clutterThreshold (which may be
  // stale until loadExpandedData runs).
  if (currentState?.mode === "clutter") return "nervous";
  // Review mode is "almost cleaned up but waiting on confirmation" — keep
  // the mascot in the cleaning pose so the visual cue matches "tidy in flight."
  if (currentState?.mode === "review") return "cleaning";
  // For other states (idle, etc.), infer from totalTabCount.
  const stateCount = Number(currentState?.tabCount);
  const tabs = Number.isFinite(stateCount) ? stateCount
             : totalTabCountValid ? totalTabCount
             : null;
  // Over threshold → nervous, regardless of state.mode (including idle).
  // Calm and sleeping moods are reserved for "things are under control."
  // Note: >= threshold reads as nervous to match the clutter watcher, which
  // fires the clutter card at tabCount >= threshold.
  if (tabs !== null && tabs >= clutterThreshold) return "nervous";
  // Idle whimsy: ~50% chance the mascot is napping when the user opens the
  // panel without a triggering event. Only kicks in when below threshold —
  // a sleeping mascot above the limit reads as oblivious, not cute. Wakes
  // on first click (handlePanelClick clears idleSleeping and re-renders).
  if (currentState?.mode === "idle" && idleSleeping) return "sleeping";
  if (tabs === null) return "happy";
  if (tabs === 0) return "sleeping";
  return "happy";
}

function updateMascot(host) {
  const shadow = host?.shadowRoot;
  if (!shadow) return;
  // Both surfaces share the same mascot SVG content and viewBox
  // (0 0 320 200), so the ambient sparkles/circles render at the same scale
  // in both. The collapsed .mascot is positioned with the same right: 24px /
  // width: 56% / max 190px rules as .exp-character-svg.
  const targets = [
    shadow.querySelector(".exp-character-svg"),
    shadow.getElementById("mascot")
  ].filter(Boolean);
  if (!targets.length) return;
  const mood = determineMood();
  // currentMood is shared across both targets, so we only skip if mood is
  // unchanged AND every target already has content.
  if (mood === currentMood && targets.every((el) => el.innerHTML)) return;
  currentMood = mood;
  const inner = renderMascotInner(mood);
  for (const el of targets) {
    el.classList.remove(
      "nf-state-sleeping", "nf-state-happy", "nf-state-cleaning",
      "nf-state-celebrating", "nf-state-nervous"
    );
    el.classList.add(`nf-state-${mood}`);
    el.innerHTML = inner;
  }
}

// Builds the mascot SVG contents (everything inside <svg>) for the given
// mood. Body, hands, ambient decorations are always rendered; face details
// (brows, eye style, mouth) and state-specific decorations (Zzz, sweat, !)
// vary by mood. CSS animation rules pick up `.nf-state-<mood>` on the SVG.
function renderMascotInner(mood) {
  const sleeping    = mood === "sleeping";
  const cleaning    = mood === "cleaning";
  const celebrating = mood === "celebrating";
  const nervous     = mood === "nervous";

  const browPath = {
    sleeping:    [null, null],
    happy:       [null, null],
    cleaning:    ["M 50 66 Q 60 62 70 68", "M 100 68 Q 110 62 120 66"],
    // Nervous: raised inner brows (outer ends low, inner ends high). The
    // previous arched-up shape read as angry/worried; this is the classic
    // "scared puppy" worried-concerned face.
    nervous:     ["M 46 64 Q 57 60 68 58", "M 100 58 Q 113 60 120 64"],
    celebrating: ["M 48 62 Q 56 58 66 62", "M 102 62 Q 110 58 118 62"]
  }[mood] || [null, null];
  const [browL, browR] = browPath;

  const lookOffset = {
    sleeping:    { x: 0,  y: 0  },
    happy:       { x: -2, y: -1 },
    cleaning:    { x: -2, y: 2  },
    // Nervous: look slightly up at the scary thing. The pupil-tremor CSS
    // animation overrides this transform once it kicks in, but this value
    // is what the eyes paint at on initial render before animation runs.
    nervous:     { x: 0,  y: -1 },
    celebrating: { x: -1, y: 0  }
  }[mood] || { x: 0, y: 0 };

  const mouth = {
    sleeping:    { d: "M 74 118 Q 80 124 86 118 Q 80 122 74 118 Z",         fill: "#093f3b" },
    happy:       { d: "M 64 114 Q 80 126 96 114",                           fill: "none"    },
    cleaning:    { d: "M 76 117 Q 80 122 84 117 Q 80 120 76 117 Z",         fill: "#093f3b" },
    nervous:     { d: "M 68 118 Q 74 112 80 118 T 92 118",                  fill: "none"    },
    celebrating: { d: "M 58 110 Q 80 134 102 110 Q 80 124 58 110 Z",        fill: "#093f3b" }
  }[mood] || { d: "M 64 114 Q 80 126 96 114", fill: "none" };

  const eyesClosed = sleeping;
  const eyesCurved = celebrating;

  const browsMarkup = (browL || browR) ? `
    <g class="nf-brows" stroke="#093f3b" stroke-width="4.5" stroke-linecap="round" fill="none">
      ${browL ? `<path d="${browL}"/>` : ""}
      ${browR ? `<path d="${browR}"/>` : ""}
    </g>` : "";

  // Wider whites in the nervous state with unchanged pupil sizes — bigger
  // sclera + same iris reads as "scared" rather than just "anxious".
  const eyeWhite = nervous
    ? { lrx: 13, lry: 14, rrx: 11, rry: 13 }
    : { lrx: 10, lry: 11, rrx: 8,  rry: 10 };

  const eyesMarkup = (!eyesClosed && !eyesCurved) ? `
    <g class="nf-eyes">
      <ellipse cx="60"  cy="88" rx="${eyeWhite.lrx}" ry="${eyeWhite.lry}" fill="#f7f8f6"/>
      <ellipse cx="110" cy="88" rx="${eyeWhite.rrx}"  ry="${eyeWhite.rry}" fill="#f7f8f6"/>
      <g class="nf-pupils" transform="translate(${lookOffset.x} ${lookOffset.y})">
        <circle cx="58"    cy="84"   r="4"   fill="#093f3b"/>
        <circle cx="108"   cy="84"   r="3.4" fill="#093f3b"/>
        <circle cx="56.6"  cy="82.6" r="1.3" fill="#f7f8f6"/>
        <circle cx="106.8" cy="82.8" r="1.1" fill="#f7f8f6"/>
      </g>
    </g>` : `
    <g class="nf-eyes nf-eyes-closed" stroke="#093f3b" stroke-width="4" fill="none" stroke-linecap="round">
      ${eyesCurved
        ? `<path d="M 50 88 Q 60 78 70 88"/><path d="M 100 88 Q 110 80 120 88"/>`
        : `<path d="M 50 88 Q 60 94 70 88"/><path d="M 102 88 Q 110 93 118 88"/>`}
    </g>`;

  const blushMarkup = celebrating ? `
    <g class="nf-blush" fill="#f4bd45" opacity="0.55">
      <ellipse cx="42"  cy="108" rx="5" ry="3"/>
      <ellipse cx="118" cy="108" rx="5" ry="3"/>
    </g>` : "";

  const zzzMarkup = sleeping ? `
    <g class="nf-zzz" fill="none" stroke="#093f3b" stroke-width="3" stroke-linejoin="round" stroke-linecap="round" transform="translate(60 30)">
      <path class="nf-z nf-z--1" d="M 150 60 h 9 l -9 11 h 9"/>
      <path class="nf-z nf-z--2" d="M 164 35 h 7 l -7 8 h 7"/>
      <path class="nf-z nf-z--3" d="M 174 15 h 5 l -5 6 h 5"/>
    </g>` : "";

  const sweatMarkup = nervous ? `
    <g class="nf-sweat" transform="translate(60 30)">
      ${nfDropMarkup(20,  70, 0.8, "nf-drop nf-drop--1")}
      ${nfDropMarkup(178, 75, 0.8, "nf-drop nf-drop--2")}
    </g>
    <g class="nf-bang" transform="translate(60 30)">
      <text x="60" y="55" text-anchor="middle" font-family="ui-sans-serif, system-ui"
            font-weight="900" font-size="26" fill="#f4bd45"
            stroke="#093f3b" stroke-width="1.5" paint-order="stroke">!</text>
    </g>` : "";

  // Hand finger rects. The class names are what nf-finger-tap targets in
  // the cleaning state; rect coords come straight from NeatFreak.jsx NFHand.
  const fingerL = [
    { x: 15.5, y: 140, h: 21 },
    { x: 24.5, y: 138, h: 23 },
    { x: 33.5, y: 138, h: 23 },
    { x: 42.5, y: 139, h: 22 }
  ];
  const fingerR = [
    { x: 150.5, y: 139, h: 22 },
    { x: 159.5, y: 138, h: 23 },
    { x: 168.5, y: 138, h: 23 },
    { x: 177.5, y: 140, h: 21 }
  ];
  const fingerRectsL = fingerL.map((f, i) =>
    `<rect class="nf-finger nf-finger--left-${i}" x="${f.x}" y="${f.y}" width="9" height="${f.h}" rx="4.5" fill="#3aaca0"/>`
  ).join("");
  const fingerRectsR = fingerR.map((f, i) =>
    `<rect class="nf-finger nf-finger--right-${i}" x="${f.x}" y="${f.y}" width="9" height="${f.h}" rx="4.5" fill="#3aaca0"/>`
  ).join("");

  return `
    <!-- Ambient mint sparkles + hollow circles, always present per the mock -->
    <g fill="none" stroke="#9ccfc3" stroke-width="2" opacity="0.75">
      <circle cx="20"  cy="92"  r="6"/>
      <circle cx="302" cy="84"  r="5"/>
      <circle cx="304" cy="156" r="4.5"/>
      <circle cx="48"  cy="172" r="4"/>
    </g>
    <g fill="#7eb8ab" opacity="0.85">
      <path d="M 38 54 Q 38.9 58.1 43 59 Q 38.9 59.9 38 64 Q 37.1 59.9 33 59 Q 37.1 58.1 38 54 Z"/>
      <path d="M 284 48 Q 284.72 51.28 288 52 Q 284.72 52.72 284 56 Q 283.28 52.72 280 52 Q 283.28 51.28 284 48 Z"/>
      <path d="M 292 124 Q 292.54 126.46 295 127 Q 292.54 127.54 292 130 Q 291.46 127.54 289 127 Q 291.46 126.46 292 124 Z"/>
      <path d="M 24 140 Q 24.72 143.28 28 144 Q 24.72 144.72 24 148 Q 23.28 144.72 20 144 Q 23.28 143.28 24 140 Z"/>
    </g>

    ${zzzMarkup}

    <ellipse cx="160" cy="184" rx="62" ry="3" fill="#093f3b" opacity="0.1"/>

    <g class="nf-tilt" transform="translate(60 30)">
      <g class="nf-body-g">
        <path d="M 16 155 C 12 105, 22 62, 56 50 C 88 38, 130 42, 162 56 C 184 72, 186 120, 182 155 Z" fill="#1f9b8f"/>
        <g fill="#0f766e" opacity="0.55">
          <ellipse cx="58"  cy="122" rx="6"   ry="4"/>
          <ellipse cx="36"  cy="100" rx="4.5" ry="3.2"/>
          <ellipse cx="148" cy="130" rx="7"   ry="4.5"/>
          <ellipse cx="170" cy="108" rx="4.5" ry="3"/>
          <ellipse cx="96"  cy="140" rx="5"   ry="3.2"/>
          <ellipse cx="128" cy="96"  rx="3.5" ry="2.6"/>
        </g>
        <path d="M 56 64 Q 70 46 92 42" stroke="#ffffff" stroke-width="6" stroke-linecap="round" opacity="0.13" fill="none"/>
        <g class="nf-face">
          ${browsMarkup}
          ${eyesMarkup}
          <path class="nf-mouth" d="${mouth.d}" fill="${mouth.fill}" stroke="#093f3b" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"/>
          ${blushMarkup}
        </g>
      </g>
    </g>

    <g class="nf-hands" transform="translate(60 30)">
      <g class="nf-hand nf-hand--left">${fingerRectsL}</g>
      <g class="nf-hand nf-hand--right">${fingerRectsR}</g>
    </g>

    ${sweatMarkup}
  `;
}

// Sweat-drop teardrop path matching JSX's NFDrop. Drawn at cx,cy with optional scale.
function nfDropMarkup(cx, cy, scale, className) {
  const w = 6 * scale;
  const h = 13 * scale;
  const d = `M ${cx} ${cy} C ${cx - w * 0.9} ${cy + h * 0.45}, ${cx - w} ${cy + h}, ${cx} ${cy + h} C ${cx + w} ${cy + h}, ${cx + w * 0.9} ${cy + h * 0.45}, ${cx} ${cy} Z`;
  return `
    <g class="${className}">
      <path d="${d}" fill="#a3d9ff" stroke="#093f3b" stroke-width="1.6" stroke-linejoin="round"/>
      <ellipse cx="${cx - w * 0.35}" cy="${cy + h * 0.65}" rx="${w * 0.22}" ry="${h * 0.18}" fill="#f7f8f6" opacity="0.75"/>
    </g>`;
}

function renderScopePicker(host) {
  const shadow = host.shadowRoot;
  const picker = shadow.getElementById("scope-picker");
  if (!picker) return;
  picker.innerHTML = `
    <button class="scope-button${selectedScope === "smart" ? " active" : ""}" data-action="scope" data-scope-value="smart" type="button" title="Let Neat Freak pick which tabs to stash">Smart</button>
    <button class="scope-button${selectedScope === "allWindows" ? " active" : ""}" data-action="scope" data-scope-value="allWindows" type="button" title="Stash eligible tabs across every open window">All windows</button>
    <button class="scope-button${selectedScope === "currentWindow" ? " active" : ""}" data-action="scope" data-scope-value="currentWindow" type="button" title="Stash eligible tabs in this window only">Current</button>
  `;
}

function updateScopeButtons(host) {
  renderScopePicker(host);
}

function renderPreview(host, preview) {
  // The eligible-tab count lives in the Tidy CTA subtitle. Record it for the
  // scope it was counted for; renderTidySub decides what the line shows.
  lastPreviewCount = Number(preview?.count) || 0;
  lastPreviewScope = selectedScope;
  renderTidySub(host);
}

// Subtitle under the Tidy CTA. Deterministic scopes state the concrete outcome
// ("Stash all N tabs ...") — "stash" matches how the mascot already explains
// what Tidy does ("I'll stash open tabs and free up RAM"). Smart advertises
// eligibility instead, since it closes only a chosen subset, not all.
function scopeSubtitle(scope, count) {
  if (scope === "smart") {
    return `${count} tab${count === 1 ? "" : "s"} eligible — Smart will pick`;
  }
  const noun = count === 1 ? "1 tab" : `all ${count} tabs`;
  const where = scope === "currentWindow" ? "in current window" : "across windows";
  return `Stash ${noun} ${where}`;
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
    list.innerHTML = `<p class="session-empty">No saved sessions yet. Tidy your tabs to make your first one.</p>`;
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
    ? `<img class="folder-tab-favicon" src="${escapeAttr(tab.favIconUrl)}" alt="">`
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
      ? `<img class="folder-tab-favicon" src="${escapeAttr(tab.favIconUrl)}" alt="">`
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
      ? `<img class="folder-tab-favicon" src="${escapeAttr(tab.favIconUrl)}" alt="">`
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
  const scope = selectedScope;
  const response = await safeSendMessageAwait({
    type: "PREVIEW_TABS",
    options: { scope, includePinned, keepCurrentTab }
  });
  // A count for a scope the user has since left would mislabel the button.
  if (response?.ok && scope === selectedScope) renderPreview(host, response.preview);
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
  checkingBeforeReview = reviewBeforeClose;
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

// "On screen" = visible tab AND focused window — the only time the user could
// actually be looking at the panel.
function panelIsOnScreen() {
  try {
    return !document.hidden && document.hasFocus();
  } catch {
    return true; // if the visibility API is unavailable, don't stall forever
  }
}

function scheduleAutoDismiss(host) {
  cancelAutoDismiss();
  autoDismissHost = host;
  autoDismissRemainingMs = AUTO_DISMISS_MS;
  resumeAutoDismiss();
}

// Start (or restart) the countdown for the time that's left — but only while
// the panel is on screen. Off-screen, the clock stays frozen.
function resumeAutoDismiss() {
  if (!autoDismissHost || autoDismissTimer) return;
  if (!panelIsOnScreen()) return;
  autoDismissStartedAt = Date.now();
  autoDismissTimer = setTimeout(() => {
    autoDismissTimer = null;
    const host = autoDismissHost;
    autoDismissHost = null;
    autoDismissRemainingMs = 0;
    if (host) {
      // auto: the card hid itself; only a user close skips the reminder.
      safeSendMessage({ type: "PANEL_DISMISS", auto: true });
      dismissPanel(host);
    }
  }, autoDismissRemainingMs);
}

function pauseAutoDismiss() {
  if (!autoDismissTimer) return;
  clearTimeout(autoDismissTimer);
  autoDismissTimer = null;
  autoDismissRemainingMs = Math.max(0, autoDismissRemainingMs - (Date.now() - autoDismissStartedAt));
}

function cancelAutoDismiss() {
  if (autoDismissTimer) {
    clearTimeout(autoDismissTimer);
    autoDismissTimer = null;
  }
  autoDismissHost = null;
  autoDismissRemainingMs = 0;
}

// Pause the countdown when the tab is hidden or the window loses focus; resume
// when it's back on screen. Bound once during init (the IIFE guard makes init
// run once per injected world).
function bindVisibilityPause() {
  const onChange = () => {
    if (panelIsOnScreen()) {
      resumeAutoDismiss();
      const host = document.getElementById(HOST_ID);
      if (host && expandedMode && currentState?.mode === "idle") {
        readCurrentSuggestion();
      }
    }
    else pauseAutoDismiss();
  };
  try {
    document.addEventListener("visibilitychange", onChange);
    window.addEventListener("focus", onChange);
    window.addEventListener("blur", onChange);
  } catch { /* ignore */ }
}

function dismissPanel(host) {
  const card = host.shadowRoot?.getElementById("card");
  if (!card) { host.remove(); return; }
  card.classList.add("leaving");
  clearTimeout(dismissTimers.get(host));
  dismissTimers.set(host, setTimeout(() => {
    dismissTimers.delete(host);
    host.remove();
  }, 220));
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
