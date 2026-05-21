const form = document.querySelector("#settings-form");
const statusEl = document.querySelector("#settings-status");

const fields = {
  apiKey: document.querySelector("#api-key"),
  clutterThreshold: document.querySelector("#clutter-threshold"),
  collectPageSummaries: document.querySelector("#collect-page-summaries"),
  defaultIncludePinned: document.querySelector("#default-include-pinned"),
  defaultKeepCurrentTab: document.querySelector("#default-keep-current-tab"),
  defaultReviewBeforeClose: document.querySelector("#default-review"),
  defaultScope: document.querySelector("#default-scope"),
  llmEnabled: document.querySelector("#llm-enabled"),
  maxSnippetChars: document.querySelector("#max-snippet-chars"),
  showClutterNudges: document.querySelector("#show-clutter-nudges")
};

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
  document.querySelector("#open-openai").addEventListener("click", openOpenAiPlatform);
  document.querySelector("#brand-home").addEventListener("click", () => send("OPEN_MANAGER"));
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
    window.open(url, "_blank", "noopener,noreferrer");
  }
}

function populate(settings) {
  fields.apiKey.value = settings.apiKey || "";
  fields.clutterThreshold.value = Number(settings.clutterThreshold) || 20;
  fields.collectPageSummaries.checked = Boolean(settings.collectPageSummaries);
  fields.defaultIncludePinned.checked = Boolean(settings.defaultIncludePinned);
  fields.defaultKeepCurrentTab.checked = Boolean(settings.defaultKeepCurrentTab);
  fields.defaultReviewBeforeClose.checked = Boolean(settings.defaultReviewBeforeClose);
  fields.defaultScope.value = settings.defaultScope || "allWindows";
  fields.llmEnabled.checked = Boolean(settings.llmEnabled);
  fields.maxSnippetChars.value = settings.maxSnippetChars || 720;
  fields.showClutterNudges.checked = settings.showClutterNudges !== false;
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
  setStatus("Testing LLM...");
  const response = await send("TEST_LLM", { settings: readSettings() });
  if (!response.ok) {
    setStatus(response.error, "error");
    return;
  }
  const groupCount = response.result.categories?.length || 0;
  setStatus(`LLM test succeeded with ${groupCount} groups.`);
}

function readSettings() {
  return {
    apiKey: fields.apiKey.value.trim(),
    clutterThreshold: Number(fields.clutterThreshold.value || 20),
    collectPageSummaries: fields.collectPageSummaries.checked,
    defaultIncludePinned: fields.defaultIncludePinned.checked,
    defaultKeepCurrentTab: fields.defaultKeepCurrentTab.checked,
    defaultReviewBeforeClose: fields.defaultReviewBeforeClose.checked,
    defaultScope: fields.defaultScope.value,
    llmEnabled: fields.llmEnabled.checked,
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
