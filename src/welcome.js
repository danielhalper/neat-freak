const stepEls = [...document.querySelectorAll("[data-step]")];
const stepperEls = [...document.querySelectorAll("[data-step-indicator]")];
const keyForm = document.querySelector("#welcome-key-form");
const keyInput = document.querySelector("#welcome-api-key");
const statusEl = document.querySelector("#welcome-status");
const doneTitleEl = document.querySelector("#welcome-done-title");
const doneSubtitleEl = document.querySelector("#welcome-done-subtitle");
const pinCardEl = document.querySelector("#welcome-pin-card");
const pinStatusEl = document.querySelector("#welcome-pin-status");
const pinStatusLabelEl = pinStatusEl?.querySelector(".welcome-pin-label");
const finalHintEl = document.querySelector("#welcome-final-hint");

const ORDER = ["1", "2", "3", "done"];
let currentStep = "1";
let pinPoll = null;

init();

function init() {
  prefillKeyFromSettings();
  bindEvents();
  showStep(currentStep);
}

function bindEvents() {
  document.body.addEventListener("click", (event) => {
    const target = event.target.closest("[data-action]");
    if (!target) return;
    const action = target.dataset.action;
    if (action === "next") goNext();
    else if (action === "back") goBack();
    else if (action === "skip") completeOnboarding({ savedKey: false });
    else if (action === "open-popup-hint") closeTab();
    else if (action === "open-openai") openOpenAiPlatform();
  });

  keyForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const key = keyInput.value.trim();
    if (!key) {
      setStatus("Enter a key or hit Skip.", "error");
      return;
    }
    if (!key.startsWith("sk-")) {
      setStatus("That doesn't look like an OpenAI key (sk-…).", "error");
      return;
    }

    setStatus("Saving…", "normal");
    const response = await send("SAVE_SETTINGS", {
      settings: { apiKey: key, llmEnabled: true }
    });
    if (!response.ok) {
      setStatus(response.error || "Couldn't save the key.", "error");
      return;
    }
    await completeOnboarding({ savedKey: true });
  });
}

function showStep(step) {
  currentStep = step;
  stepEls.forEach((el) => {
    el.toggleAttribute("hidden", el.dataset.step !== step);
  });
  const activeNumeric = step === "done" ? "3" : step;
  stepperEls.forEach((el) => {
    el.classList.toggle("active", el.dataset.stepIndicator === activeNumeric);
    const idx = ORDER.indexOf(el.dataset.stepIndicator);
    const currentIdx = ORDER.indexOf(activeNumeric);
    el.classList.toggle("complete", idx < currentIdx);
  });
  window.scrollTo({ top: 0, behavior: "instant" });

  if (step === "done") {
    startPinWatcher();
  } else {
    stopPinWatcher();
  }
}

async function checkPinStatus() {
  if (!chrome.action?.getUserSettings) return false;
  try {
    const settings = await chrome.action.getUserSettings();
    return Boolean(settings?.isOnToolbar);
  } catch {
    return false;
  }
}

async function startPinWatcher() {
  stopPinWatcher();
  const alreadyPinned = await checkPinStatus();
  setPinUi(alreadyPinned);
  if (alreadyPinned) return;

  pinPoll = setInterval(async () => {
    if (currentStep !== "done") {
      stopPinWatcher();
      return;
    }
    const pinned = await checkPinStatus();
    if (pinned) {
      setPinUi(true);
      stopPinWatcher();
    }
  }, 1200);

  // Stop polling after 5 minutes regardless — user may have left this tab open.
  setTimeout(stopPinWatcher, 5 * 60 * 1000);
}

function stopPinWatcher() {
  if (pinPoll) {
    clearInterval(pinPoll);
    pinPoll = null;
  }
}

function setPinUi(isPinned) {
  if (!pinStatusEl) return;
  if (isPinned) {
    pinStatusEl.dataset.state = "pinned";
    if (pinStatusLabelEl) pinStatusLabelEl.textContent = "Pinned! Neat Freak lives in your toolbar.";
    if (pinCardEl) pinCardEl.classList.add("pinned");
    if (doneTitleEl) doneTitleEl.textContent = "You're all set.";
    if (finalHintEl) finalHintEl.textContent = "Click the Neat Freak icon in your toolbar to save and group your first session.";
  } else {
    pinStatusEl.dataset.state = "waiting";
    if (pinStatusLabelEl) pinStatusLabelEl.textContent = "Waiting for you to pin Neat Freak…";
    if (pinCardEl) pinCardEl.classList.remove("pinned");
  }
}

function goNext() {
  const idx = ORDER.indexOf(currentStep);
  if (idx < 0 || idx >= ORDER.length - 1) return;
  showStep(ORDER[idx + 1]);
}

function goBack() {
  const idx = ORDER.indexOf(currentStep);
  if (idx <= 0) return;
  showStep(ORDER[idx - 1]);
}

async function prefillKeyFromSettings() {
  try {
    const response = await send("GET_SETTINGS");
    if (response?.ok && response.settings?.apiKey) {
      keyInput.value = response.settings.apiKey;
    }
  } catch {
    // Settings unavailable; user can still continue.
  }
}

async function completeOnboarding({ savedKey }) {
  doneSubtitleEl.textContent = savedKey
    ? "AI grouping is on. So Neat Freak's always one click away — pin it to your toolbar."
    : "So Neat Freak's always one click away — pin it to your toolbar.";
  try {
    await send("MARK_ONBOARDED");
  } catch {
    // The mark is just bookkeeping; finishing the flow is what matters.
  }
  showStep("done");
}

function setStatus(message, tone) {
  statusEl.textContent = message || "";
  statusEl.dataset.tone = tone || "normal";
}

function send(type, payload = {}) {
  return chrome.runtime.sendMessage({ type, ...payload });
}

async function closeTab() {
  try {
    const tab = await chrome.tabs.getCurrent();
    if (tab?.id) chrome.tabs.remove(tab.id);
  } catch {
    window.close();
  }
}

async function openOpenAiPlatform() {
  const url = "https://platform.openai.com/login";
  try {
    const currentTab = await chrome.tabs.getCurrent();
    await chrome.tabs.create({
      url,
      active: true,
      openerTabId: currentTab?.id,
      index: currentTab ? currentTab.index + 1 : undefined
    });
  } catch {
    // Last-resort fallback: standard new tab.
    window.open(url, "_blank", "noopener,noreferrer");
  }
}
