// Injected into the active tab when the clutter threshold is crossed.
// Renders a small floating card in the top-right corner using a closed
// shadow DOM so the host page's CSS can't reach in (and our styles can't
// leak out). The tab count is read from chrome.storage.session, which
// background.js sets immediately before invoking this script.

(async () => {
  const HOST_ID = "__neat-freak-clutter-toast__";
  if (document.getElementById(HOST_ID)) return; // already visible

  let tabCount = 20;
  try {
    const result = await chrome.storage.session.get("neatFreakClutterCount");
    const value = Number(result?.neatFreakClutterCount);
    if (Number.isFinite(value) && value > 0) tabCount = value;
  } catch {
    // If session storage is unavailable we just use the default — better than failing the toast.
  }

  const mascotUrl = chrome.runtime.getURL("assets/mascot-stressed-128.png");

  const host = document.createElement("div");
  host.id = HOST_ID;
  // `all: initial` is the only style we set on the host. Everything else lives
  // inside the shadow root so it can't be overridden by page CSS.
  host.style.cssText = [
    "all: initial",
    "position: fixed",
    "top: 16px",
    "right: 16px",
    "z-index: 2147483647", // top of the painting order — sits above page overlays
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
        cursor: pointer;
        background: transparent;
        border: 0;
        color: #888;
        font-size: 18px;
        line-height: 1;
        padding: 2px 4px;
        margin: -2px -4px 0 0;
        border-radius: 4px;
      }
      .close:hover { color: #333; background: #f0f0f0; }
      .actions { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-top: 2px; }
      .primary {
        cursor: pointer;
        background: #0f766e;
        color: #ffffff;
        border: 0;
        padding: 8px 14px;
        border-radius: 8px;
        font-size: 13px;
        font-weight: 600;
        font-family: inherit;
      }
      .primary:hover { background: #115e59; }
      .disable-link {
        cursor: pointer;
        background: transparent;
        border: 0;
        color: #888;
        font-size: 11px;
        text-decoration: underline;
        font-family: inherit;
        padding: 0;
      }
      .disable-link:hover { color: #555; }
    </style>
    <div class="card" role="alert" aria-live="polite">
      <div class="row">
        <img class="mascot" src="${mascotUrl}" alt="">
        <div class="body">
          <p class="title">${tabCount} tabs open</p>
          <p class="sub">Want me to tidy up?</p>
        </div>
        <button class="close" data-action="dismiss" aria-label="Dismiss">&times;</button>
      </div>
      <div class="actions">
        <button class="primary" data-action="tidy">Tidy now</button>
        <button class="disable-link" data-action="disable">Don&rsquo;t show this again</button>
      </div>
    </div>
  `;

  document.documentElement.appendChild(host);

  const card = shadow.querySelector(".card");
  function dismissWithAnimation() {
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
    } else if (action === "tidy") {
      chrome.runtime.sendMessage({ type: "CLUTTER_TOAST_TIDY" });
      dismissWithAnimation();
    } else if (action === "disable") {
      chrome.runtime.sendMessage({ type: "CLUTTER_TOAST_DISABLE" });
      dismissWithAnimation();
    }
  });
})();
