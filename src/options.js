const form = document.querySelector("#settings-form");
const statusEl = document.querySelector("#settings-status");

const fields = {
  tokenServiceUrl: document.querySelector("#token-service-url"),
  clutterThreshold: document.querySelector("#clutter-threshold"),
  collectPageSummaries: document.querySelector("#collect-page-summaries"),
  defaultIncludePinned: document.querySelector("#default-include-pinned"),
  defaultKeepCurrentTab: document.querySelector("#default-keep-current-tab"),
  defaultReviewBeforeClose: document.querySelector("#default-review"),
  defaultScope: document.querySelector("#default-scope"),
  llmEnabled: document.querySelector("#llm-enabled"),
  maxSavedSessions: document.querySelector("#max-saved-sessions"),
  maxSnippetChars: document.querySelector("#max-snippet-chars"),
  showClutterNudges: document.querySelector("#show-clutter-nudges")
};

const clutterThresholdRow = document.querySelector("#clutter-threshold-row");

function syncClutterThresholdVisibility() {
  clutterThresholdRow.hidden = !fields.showClutterNudges.checked;
}

init();

async function init() {
  const response = await send("GET_SETTINGS");
  if (!response.ok) {
    setStatus(response.error, "error");
    return;
  }
  populate(response.settings);
  bindEvents();
}

function bindEvents() {
  form.addEventListener("submit", save);
  document.querySelector("#test-llm").addEventListener("click", testLlm);
  document.querySelector("#open-manager").addEventListener("click", () => send("OPEN_MANAGER"));
  document.querySelector("#brand-home").addEventListener("click", () => send("OPEN_MANAGER"));
  fields.showClutterNudges.addEventListener("change", syncClutterThresholdVisibility);
}

function populate(settings) {
  fields.tokenServiceUrl.value = settings.tokenServiceUrl || "";
  fields.clutterThreshold.value = Number(settings.clutterThreshold) || 20;
  fields.collectPageSummaries.checked = Boolean(settings.collectPageSummaries);
  fields.defaultIncludePinned.checked = Boolean(settings.defaultIncludePinned);
  fields.defaultKeepCurrentTab.checked = Boolean(settings.defaultKeepCurrentTab);
  fields.defaultReviewBeforeClose.checked = Boolean(settings.defaultReviewBeforeClose);
  fields.defaultScope.value = settings.defaultScope || "allWindows";
  fields.llmEnabled.checked = Boolean(settings.llmEnabled);
  fields.maxSavedSessions.value = settings.maxSavedSessions ?? 180;
  fields.maxSnippetChars.value = settings.maxSnippetChars || 720;
  fields.showClutterNudges.checked = settings.showClutterNudges !== false;
  syncClutterThresholdVisibility();
}

async function save(event) {
  event.preventDefault();
  const response = await send("SAVE_SETTINGS", { settings: readSettings() });
  if (!response.ok) {
    setStatus(response.error, "error");
    return;
  }
  populate(response.settings);
  setStatus("Settings saved.");
}

async function testLlm() {
  setStatus("Testing backend...");
  const response = await send("TEST_LLM", { settings: readSettings() });
  if (!response.ok) {
    setStatus(response.error, "error");
    return;
  }
  const groupCount = response.result.categories?.length || 0;
  setStatus(`Backend test succeeded with ${groupCount} groups.`);
}

function readSettings() {
  return {
    tokenServiceUrl: fields.tokenServiceUrl.value.trim(),
    clutterThreshold: Number(fields.clutterThreshold.value || 20),
    collectPageSummaries: fields.collectPageSummaries.checked,
    defaultIncludePinned: fields.defaultIncludePinned.checked,
    defaultKeepCurrentTab: fields.defaultKeepCurrentTab.checked,
    defaultReviewBeforeClose: fields.defaultReviewBeforeClose.checked,
    defaultScope: fields.defaultScope.value,
    llmEnabled: fields.llmEnabled.checked,
    maxSavedSessions: Number(fields.maxSavedSessions.value || 180),
    maxSnippetChars: Number(fields.maxSnippetChars.value || 720),
    showClutterNudges: fields.showClutterNudges.checked
  };
}

function setStatus(message, tone = "normal") {
  statusEl.textContent = message;
  statusEl.dataset.tone = tone;
}

function send(type, payload = {}) {
  return chrome.runtime.sendMessage({ type, ...payload });
}
