const form = document.querySelector("#settings-form");
const statusEl = document.querySelector("#settings-status");

const fields = {
  apiKey: document.querySelector("#api-key"),
  collectPageSummaries: document.querySelector("#collect-page-summaries"),
  defaultIncludePinned: document.querySelector("#default-include-pinned"),
  defaultReviewBeforeClose: document.querySelector("#default-review"),
  defaultScope: document.querySelector("#default-scope"),
  llmEnabled: document.querySelector("#llm-enabled"),
  maxSnippetChars: document.querySelector("#max-snippet-chars")
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
}

function populate(settings) {
  fields.apiKey.value = settings.apiKey || "";
  fields.collectPageSummaries.checked = Boolean(settings.collectPageSummaries);
  fields.defaultIncludePinned.checked = Boolean(settings.defaultIncludePinned);
  fields.defaultReviewBeforeClose.checked = Boolean(settings.defaultReviewBeforeClose);
  fields.defaultScope.value = settings.defaultScope || "allWindows";
  fields.llmEnabled.checked = Boolean(settings.llmEnabled);
  fields.maxSnippetChars.value = settings.maxSnippetChars || 720;
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
    collectPageSummaries: fields.collectPageSummaries.checked,
    defaultIncludePinned: fields.defaultIncludePinned.checked,
    defaultReviewBeforeClose: fields.defaultReviewBeforeClose.checked,
    defaultScope: fields.defaultScope.value,
    llmEnabled: fields.llmEnabled.checked,
    maxSnippetChars: Number(fields.maxSnippetChars.value || 720)
  };
}

function setStatus(message, tone = "normal") {
  statusEl.textContent = message;
  statusEl.dataset.tone = tone;
}

function send(type, payload = {}) {
  return chrome.runtime.sendMessage({ type, ...payload });
}
