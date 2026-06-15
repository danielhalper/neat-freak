// Popup shim. Tries to inject the floating panel on the active tab first
// (the preferred surface — see Phase 2C in the floating-panel spec). When the
// active tab can't host it (chrome:// pages, the Web Store, other extensions'
// pages — anything not http(s)), we render a compact "limited surface" inline
// instead (see popup-limited.js). The full floating panel is built for in-page
// injection and renders broken in a popup window, so we no longer mount it
// here — the limited view kicks off a real tidy and hands off to the Manager.

(async () => {
  try {
    const response = await chrome.runtime.sendMessage({ type: "OPEN_PANEL_FROM_ICON" });
    if (response?.ok && response.injected) {
      window.close();
      return;
    }
  } catch {
    // Background unavailable — fall through to inline panel.
  }

  // Limited-surface fallback. The active tab can't host the in-page panel, so
  // render the compact view here. Expand the body first — before this it's 0×0
  // transparent so a successful inject + window.close() never flashes a cream
  // rectangle.
  // The active tab can't host the in-page panel (chrome:// pages, the Web
  // Store, other extensions' pages). Render the FULL panel inline in the popup
  // window — neat-freak-panel.js detects popup context (location.href ===
  // popup.html), mounts in-popup, and fills this body. (popup-limited.js is the
  // old compact fallback, kept for reference.)
  document.body.classList.add("popup-body--mounted");
  await import("./neat-freak-panel.js");
})();
