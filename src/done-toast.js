// Injected into the active tab when a save session finishes processing.
// Mirrors clutter-toast.js: closed shadow DOM, top-right, slide-in animation.
// Auto-dismisses after 10s so it doesn't linger.

(async () => {
  const HOST_ID = "__neat-freak-done-toast__";
  if (document.getElementById(HOST_ID)) return;

  let payload = {};
  try {
    const result = await chrome.storage.session.get("neatFreakDoneState");
    payload = result?.neatFreakDoneState || {};
  } catch {
    // Session storage unavailable — render with defaults.
  }

  const tabCount = Number(payload.tabCount) || 0;
  const groupCount = Number(payload.groupCount) || 0;
  const looseCount = Number(payload.looseCount) || 0;
  const keepCount = Number(payload.keepCount) || 0;
  const sessionId = String(payload.sessionId || "");

  const detailParts = [];
  if (groupCount) detailParts.push(`${groupCount} folder${groupCount === 1 ? "" : "s"}`);
  if (looseCount) detailParts.push(`${looseCount} loose`);
  if (keepCount) detailParts.push(`${keepCount} kept open`);
  const detail = detailParts.join(" · ") || "Ready in your saved sessions.";

  const title = tabCount > 0
    ? `${tabCount} tab${tabCount === 1 ? "" : "s"} tucked away`
    : "All caught up";

  // The popup's done state uses mascot-calm.svg — mirror that for brand
  // consistency. Stressed mascot is for the clutter toast (too many tabs),
  // calm mascot is for done (you cleaned up, mascot is happy).
  const mascotUrl = chrome.runtime.getURL("assets/mascot-calm.svg");

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
  const shadow = host.attachShadow({ mode: "closed" });

  shadow.innerHTML = `
    <style>
      :host { all: initial; }
      .card {
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", sans-serif;
        width: 320px;
        background: #ffffff;
        color: #1a2421;
        border: 1px solid #d9e0dc;
        border-radius: 12px;
        box-shadow: 0 12px 32px rgba(0, 0, 0, 0.18);
        padding: 14px 14px 12px;
        display: flex;
        flex-direction: column;
        gap: 10px;
        animation: slidein 0.22s ease-out;
      }
      @keyframes slidein {
        from { transform: translateX(380px); opacity: 0; }
        to   { transform: translateX(0);     opacity: 1; }
      }
      @keyframes slideout {
        from { transform: translateX(0);     opacity: 1; }
        to   { transform: translateX(380px); opacity: 0; }
      }
      .card.leaving { animation: slideout 0.18s ease-in forwards; }
      .row { display: flex; gap: 12px; align-items: flex-start; }
      .mascot { width: 44px; height: 44px; flex-shrink: 0; border-radius: 8px; }
      .body { flex: 1; min-width: 0; }
      .title { font-size: 14px; font-weight: 600; margin: 0 0 2px; line-height: 1.25; }
      .sub { font-size: 13px; color: #4a5651; margin: 0; line-height: 1.35; }
      .close {
        cursor: pointer; background: transparent; border: 0;
        color: #888; font-size: 18px; line-height: 1;
        padding: 2px 4px; margin: -2px -4px 0 0;
        border-radius: 4px;
      }
      .close:hover { color: #333; background: #f0f0f0; }
      .actions { display: flex; align-items: center; gap: 12px; margin-top: 2px; }
      .primary {
        cursor: pointer; background: #0f766e; color: #ffffff; border: 0;
        padding: 8px 14px; border-radius: 8px;
        font-size: 13px; font-weight: 600; font-family: inherit;
      }
      .primary:hover { background: #115e59; }
    </style>
    <div class="card" role="status" aria-live="polite">
      <div class="row">
        <img class="mascot" src="${mascotUrl}" alt="">
        <div class="body">
          <p class="title">${title}</p>
          <p class="sub">${detail}</p>
        </div>
        <button class="close" data-action="dismiss" aria-label="Dismiss">&times;</button>
      </div>
      <div class="actions">
        <button class="primary" data-action="open">Open manager</button>
      </div>
    </div>
  `;

  document.documentElement.appendChild(host);

  const card = shadow.querySelector(".card");
  const dismissTimer = setTimeout(() => dismissWithAnimation(), 10000);

  function dismissWithAnimation() {
    clearTimeout(dismissTimer);
    if (!card) { host.remove(); return; }
    card.classList.add("leaving");
    setTimeout(() => host.remove(), 200);
  }

  shadow.addEventListener("click", (event) => {
    const target = event.target;
    const action = target instanceof HTMLElement ? target.dataset.action : "";
    if (!action) return;
    if (action === "dismiss") {
      dismissWithAnimation();
    } else if (action === "open") {
      chrome.runtime.sendMessage({ type: "DONE_TOAST_OPEN", sessionId });
      dismissWithAnimation();
    }
  });
})();
