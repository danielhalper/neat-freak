// Popup shim. Tries to inject the floating panel on the active tab first
// (the preferred surface — see Phase 2C in the floating-panel spec). On
// failure (chrome:// page, web store, etc.), this popup window becomes the
// panel host: we pre-write idle state and dynamic-import the panel script,
// which mounts itself in popup-context mode (fills the body, no fixed
// positioning, × → window.close()).

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

  // Inline panel path. Pre-write idle state so the panel mounts expanded
  // immediately rather than flashing the collapsed view first.
  try {
    await chrome.storage.session?.set?.({
      neatFreakPanelState: { mode: "idle" }
    });
  } catch {
    // Storage write failure isn't blocking — the panel script handles missing
    // state by defaulting to "hidden", and the user can re-trigger.
  }
  document.body.style.visibility = "visible";
  await import("./neat-freak-panel.js");
})();
