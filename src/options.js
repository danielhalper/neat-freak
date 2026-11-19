const form = document.querySelector("#settings-form");
const statusEl = document.querySelector("#settings-status");

const fields = {
  behaviorLogEnabled: document.querySelector("#behavior-log-enabled"),
  clutterThreshold: document.querySelector("#clutter-threshold"),
  collectPageSummaries: document.querySelector("#collect-page-summaries"),
  defaultIncludePinned: document.querySelector("#default-include-pinned"),
  defaultKeepCurrentTab: document.querySelector("#default-keep-current-tab"),
  defaultReviewBeforeClose: document.querySelector("#default-review"),
  defaultScope: document.querySelector("#default-scope"),
  diagnosticsEnabled: document.querySelector("#diagnostics-enabled"),
  llmEnabled: document.querySelector("#llm-enabled"),
  maxSavedTabs: document.querySelector("#max-saved-tabs"),
  maxSnippetChars: document.querySelector("#max-snippet-chars"),
  prepareSuggestions: document.querySelector("#prepare-suggestions"),
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
  document.querySelector("#export-diagnostics").addEventListener("click", exportDiagnostics);
  document.querySelector("#clear-diagnostics").addEventListener("click", clearDiagnostics);
  document.querySelector("#export-behavior-log").addEventListener("click", exportBehaviorLog);
  document.querySelector("#clear-behavior-log").addEventListener("click", clearBehaviorLog);
}

function populate(settings) {
  fields.behaviorLogEnabled.checked = settings.behaviorLogEnabled === true;
  fields.clutterThreshold.value = Number(settings.clutterThreshold) || 20;
  fields.collectPageSummaries.checked = Boolean(settings.collectPageSummaries);
  fields.defaultIncludePinned.checked = Boolean(settings.defaultIncludePinned);
  fields.defaultKeepCurrentTab.checked = Boolean(settings.defaultKeepCurrentTab);
  fields.defaultReviewBeforeClose.checked = Boolean(settings.defaultReviewBeforeClose);
  fields.defaultScope.value = settings.defaultScope || "allWindows";
  fields.diagnosticsEnabled.checked = settings.diagnosticsEnabled !== false;
  fields.llmEnabled.checked = Boolean(settings.llmEnabled);
  fields.maxSavedTabs.value = settings.maxSavedTabs ?? 3000;
  fields.maxSnippetChars.value = settings.maxSnippetChars || 720;
  fields.prepareSuggestions.checked = settings.prepareSuggestions === true;
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
    behaviorLogEnabled: fields.behaviorLogEnabled.checked,
    clutterThreshold: Number(fields.clutterThreshold.value || 20),
    collectPageSummaries: fields.collectPageSummaries.checked,
    defaultIncludePinned: fields.defaultIncludePinned.checked,
    defaultKeepCurrentTab: fields.defaultKeepCurrentTab.checked,
    defaultReviewBeforeClose: fields.defaultReviewBeforeClose.checked,
    defaultScope: fields.defaultScope.value,
    diagnosticsEnabled: fields.diagnosticsEnabled.checked,
    llmEnabled: fields.llmEnabled.checked,
    maxSavedTabs: Number(fields.maxSavedTabs.value || 3000),
    maxSnippetChars: Number(fields.maxSnippetChars.value || 720),
    prepareSuggestions: fields.prepareSuggestions.checked,
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

async function exportDiagnostics() {
  const status = document.querySelector("#diagnostics-status");
  try {
    const response = await send("EXPORT_DIAGNOSTICS");
    if (!response.ok) throw new Error(response.error);
    downloadJson("neat-freak-diagnostics", response.diagnostics);
    status.textContent = `Exported ${response.diagnostics.entries.length} events. Share this file when reporting an issue.`;
  } catch {
    status.textContent = "Couldn't export diagnostics. Reload the extension and this settings page, then try again.";
  }
}

async function clearDiagnostics() {
  const status = document.querySelector("#diagnostics-status");
  try {
    const response = await send("CLEAR_DIAGNOSTICS");
    if (!response.ok) throw new Error(response.error);
    status.textContent = "Diagnostics cleared.";
  } catch {
    status.textContent = "Couldn't clear diagnostics. Please try again.";
  }
}

function downloadJson(name, data) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `${name}-${new Date().toISOString().slice(0, 10)}.json`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function exportBehaviorLog() {
  const status = document.querySelector("#behavior-log-status");
  try {
    const response = await send("EXPORT_BEHAVIOR_LOG");
    if (!response.ok) throw new Error(response.error);
    const count = response.behaviorLog.records.length;
    if (!count) {
      status.textContent = "Nothing recorded yet. Turn on recording and save settings.";
      return;
    }
    downloadJson("neat-freak-tab-habits", response.behaviorLog);
    status.textContent = `Exported ${count} tabs. Analyse with: node eval/behavior-rules.js <file>`;
  } catch {
    status.textContent = "Couldn't export tab habits. Reload the extension and this settings page, then try again.";
  }
}

async function clearBehaviorLog() {
  const status = document.querySelector("#behavior-log-status");
  try {
    const response = await send("CLEAR_BEHAVIOR_LOG");
    if (!response.ok) throw new Error(response.error);
    status.textContent = "Tab habits cleared.";
  } catch {
    status.textContent = "Couldn't clear tab habits. Please try again.";
  }
}
