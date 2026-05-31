// Compact "limited surface" for the toolbar popup, shown when the active tab
// can't host the in-page panel (chrome:// pages, the Web Store, other
// extensions' pages — anything not http(s)).
//
// This is deliberately NOT the full floating panel. That panel's layout and
// its saving/review/done state machine are built for injection into a web
// page, not a 420px popup window; crammed in here they render broken. Instead
// we show a small, honest card that still kicks off a real (cross-tab) tidy and
// hands the rich result — including review-before-close — off to the Manager,
// which is a full page built for it.

function mascotUrl() {
  try {
    return chrome.runtime.getURL("assets/mascot-calm.svg");
  } catch {
    return "";
  }
}

// Pure: the subline copy for the given open/savable tab counts.
export function limitedSubline(totalOpen, savable) {
  const hasSavable = typeof savable === "number" && savable > 0;
  if (!hasSavable) return "Nothing to tidy on this side — you're all set.";
  const n = typeof totalOpen === "number" && totalOpen > 0 ? totalOpen : savable;
  return `${n} tab${n === 1 ? "" : "s"} open — I'll stash the ones you're done with.`;
}

export async function mountLimitedState() {
  let savable = null;   // savable tabs in the user's default scope
  let totalOpen = null; // every open tab, including this privileged one
  try {
    const res = await chrome.runtime.sendMessage({ type: "GET_POPUP_STATE" });
    savable = res?.preview?.count ?? null;
    totalOpen = typeof res?.totalTabCount === "number" ? res.totalTabCount : null;
  } catch {
    // Background unavailable — render without counts; the Tidy button still
    // works (the save flow re-derives candidates), so leave it enabled.
    savable = null;
  }

  // Treat "couldn't read the count" (null) as "probably has tabs" so we don't
  // disable Tidy on a transient message failure. Only an explicit 0 disables.
  const hasTabs = savable === null || savable > 0;

  const style = document.createElement("style");
  style.textContent = STYLES;
  document.head.appendChild(style);

  const root = document.createElement("div");
  root.className = "nf-limited";
  root.innerHTML = `
    <img class="nf-mascot" src="${mascotUrl()}" alt="" draggable="false">
    <h1 class="nf-title">I can't ride along on Chrome's own pages</h1>
    <p class="nf-sub">${limitedSubline(totalOpen, savable)}</p>
    <button class="nf-btn nf-tidy" type="button"${hasTabs ? "" : " disabled"}>${hasTabs ? "Tidy my tabs" : "Nothing to tidy"}</button>
    <button class="nf-link" type="button" data-action="manager">Open saved tabs</button>
    <p class="nf-status" role="status" aria-live="polite"></p>
  `;
  document.body.appendChild(root);

  const tidyBtn = root.querySelector(".nf-tidy");
  const managerBtn = root.querySelector('[data-action="manager"]');
  const status = root.querySelector(".nf-status");

  managerBtn?.addEventListener("click", async () => {
    try { await chrome.runtime.sendMessage({ type: "OPEN_MANAGER" }); } catch { /* ignore */ }
    closePopup();
  });

  if (tidyBtn && hasTabs) {
    tidyBtn.addEventListener("click", async () => {
      tidyBtn.disabled = true;
      tidyBtn.textContent = "Tidying…";
      if (status) status.textContent = "";

      let res = null;
      try {
        // Smart scope = the one-click "tidy what I'm done with" behavior, same
        // as the floating panel's Tidy. Respects the clutter floor.
        res = await chrome.runtime.sendMessage({ type: "SAVE_TABS", options: { scope: "smart" } });
      } catch {
        res = null;
      }

      if (res?.ok) {
        // Hand off to the Manager (built for a full page) for the done summary
        // and any review-before-close confirmation. Clear the floating-panel
        // state so a stale done/review card can't surface on the next normal
        // tab the user visits.
        try { await chrome.runtime.sendMessage({ type: "OPEN_MANAGER" }); } catch { /* ignore */ }
        try { chrome.runtime.sendMessage({ type: "PANEL_DISMISS" }); } catch { /* ignore */ }
        closePopup();
        return;
      }

      // Failed (no savable tabs, or a background error) — recover in place.
      tidyBtn.disabled = false;
      tidyBtn.textContent = hasTabs ? "Tidy my tabs" : "Nothing to tidy";
      if (status) {
        status.textContent = res?.error
          ? `Couldn't tidy: ${res.error}`
          : "Couldn't tidy right now — try again.";
      }
    });
  }
}

function closePopup() {
  try { window.close(); } catch { /* ignore */ }
}

const STYLES = `
  .nf-limited {
    box-sizing: border-box;
    width: 100%;
    padding: 24px 20px 18px;
    display: flex;
    flex-direction: column;
    align-items: center;
    text-align: center;
    font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    color: #1a2421;
  }
  .nf-mascot {
    width: 84px; height: 84px; margin-bottom: 12px;
    user-select: none; -webkit-user-drag: none;
  }
  .nf-title {
    margin: 0 0 6px;
    font-size: 16px; font-weight: 800; line-height: 1.25; letter-spacing: -0.01em;
  }
  .nf-sub {
    margin: 0 0 16px;
    font-size: 13px; line-height: 1.4; color: #63706b;
    max-width: 280px;
  }
  .nf-btn {
    cursor: pointer; border: 0; width: 100%;
    padding: 11px 16px; border-radius: 9px;
    font-size: 14px; font-weight: 700; font-family: inherit; letter-spacing: 0.01em;
  }
  .nf-tidy {
    background: #f4bd45; color: #1a2421;
    box-shadow: 0 1px 0 rgba(146, 95, 0, 0.18), inset 0 -1px 0 rgba(146, 95, 0, 0.18);
    transition: transform 0.08s ease, background 0.12s ease, opacity 0.12s ease;
  }
  .nf-tidy:hover:not(:disabled) { background: #f0b32f; }
  .nf-tidy:active:not(:disabled) { transform: translateY(1px); }
  .nf-tidy:disabled { opacity: 0.55; cursor: default; }
  .nf-link {
    margin-top: 10px; background: none; border: 0; cursor: pointer;
    font-family: inherit; font-size: 12.5px; font-weight: 600; color: #63706b;
    padding: 4px 6px; border-radius: 6px;
  }
  .nf-link:hover { color: #0f766e; }
  .nf-status {
    margin: 10px 0 0; min-height: 0;
    font-size: 12px; line-height: 1.35; color: #b4453a;
  }
`;
