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
        position: relative;
        width: 340px;
        background: #fdfcf8;
        color: #1a2421;
        border: 1px solid #e8dfc7;
        border-radius: 14px;
        box-shadow: 0 18px 40px -6px rgba(15, 118, 110, 0.22), 0 4px 12px rgba(0, 0, 0, 0.08);
        padding: 16px 16px 14px;
        overflow: hidden;
        animation: slidein 0.28s cubic-bezier(0.2, 0.9, 0.3, 1.2);
      }
      /* Amber brand bar — anchors the toast to Neat Freak's accent palette
         and signals "attention needed" without shouting. */
      .card::before {
        content: "";
        position: absolute;
        top: 0; left: 0; right: 0;
        height: 3px;
        background: linear-gradient(90deg, #f4bd45 0%, #f4bd45 60%, #f6cd6d 100%);
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
      .card.leaving { animation: slideout 0.2s ease-in forwards; }

      .row { display: flex; gap: 14px; align-items: flex-start; }

      /* Free-standing mascot — no halo, no circle. The warm card tint
         carries enough contrast that the teal mascot reads cleanly.
         A subtle wobble gives it some life on entrance. */
      .mascot {
        width: 60px;
        height: 60px;
        flex-shrink: 0;
        margin-top: 2px;
        filter: drop-shadow(0 2px 4px rgba(15, 118, 110, 0.18));
        animation: mascot-tilt 2.4s ease-in-out 0.3s 2;
        transform-origin: 50% 90%;
      }

      .body { flex: 1; min-width: 0; padding-top: 4px; }

      .title {
        font-size: 14px;
        font-weight: 600;
        line-height: 1.25;
        margin: 0 0 2px;
        color: #1a2421;
      }

      .sub {
        font-size: 13px;
        color: #4a5651;
        margin: 0;
        line-height: 1.4;
      }

      .close {
        position: absolute;
        top: 8px;
        right: 8px;
        cursor: pointer;
        background: transparent;
        border: 0;
        color: #8a948f;
        font-size: 16px;
        line-height: 1;
        width: 24px;
        height: 24px;
        display: flex;
        align-items: center;
        justify-content: center;
        border-radius: 6px;
        padding: 0;
        font-family: inherit;
      }
      .close:hover { color: #1a2421; background: rgba(26, 36, 33, 0.06); }
      .close:focus-visible {
        outline: 2px solid #f4bd45;
        outline-offset: 1px;
      }

      .actions {
        display: flex;
        align-items: center;
        justify-content: flex-end;
        gap: 8px;
        margin-top: 12px;
        padding-top: 10px;
        border-top: 1px dashed #e8dfc7;
      }

      /* Amber primary action — sits across the gutter from the teal mascot
         (no clash) and reinforces "this is the attention-grabbing moment". */
      .primary {
        cursor: pointer;
        background: #f4bd45;
        color: #1a2421;
        border: 0;
        padding: 9px 16px;
        border-radius: 8px;
        font-size: 13px;
        font-weight: 700;
        font-family: inherit;
        letter-spacing: 0.01em;
        box-shadow: 0 1px 0 rgba(146, 95, 0, 0.18), inset 0 -1px 0 rgba(146, 95, 0, 0.18);
        transition: transform 0.08s ease, background 0.12s ease, box-shadow 0.12s ease;
      }
      .primary:hover {
        background: #ecb02d;
        box-shadow: 0 2px 6px rgba(146, 95, 0, 0.22), inset 0 -1px 0 rgba(146, 95, 0, 0.22);
      }
      .primary:active { transform: translateY(1px); }
      .primary:focus-visible {
        outline: 2px solid #0f766e;
        outline-offset: 2px;
      }
    </style>
    <div class="card" role="alert" aria-live="polite">
      <button class="close" data-action="dismiss" aria-label="Dismiss" type="button">&times;</button>
      <div class="row">
        <img class="mascot" src="${mascotUrl}" alt="" aria-hidden="true">
        <div class="body">
          <p class="title">${tabCount} tabs open</p>
          <p class="sub">Want me to tidy up?</p>
        </div>
      </div>
      <div class="actions">
        <button class="primary" data-action="tidy" type="button">Tidy now</button>
      </div>
    </div>
  `;

  document.documentElement.appendChild(host);

  const card = shadow.querySelector(".card");
  function dismissWithAnimation() {
    if (!card) { host.remove(); return; }
    card.classList.add("leaving");
    setTimeout(() => host.remove(), 220);
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
    }
  });
})();
