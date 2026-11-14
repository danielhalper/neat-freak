import { nowIso } from "./utils.js";

export const SETTINGS_KEY = "tabAtlasSettings";
export const SESSIONS_KEY = "tabAtlasSessions";

// Baked-in managed backend (the token/quota Worker). Users never configure this.
export const DEFAULT_TOKEN_SERVICE_URL = "https://neat-freak-token-service.danielhalper4.workers.dev";

export const DEFAULT_SETTINGS = {
  behaviorLogEnabled: false, // Opt-in local tab-habit log (behavior-log.js); never uploaded.
  clutterThreshold: 20,
  collectPageSummaries: true,
  defaultIncludePinned: false,
  defaultKeepCurrentTab: true,
  defaultReviewBeforeClose: true,
  defaultScope: "smart",
  diagnosticsEnabled: true, // Bounded local counts/errors only; never uploaded.
  installId: "",           // stable anonymous id; sent to the token service for per-install rate limiting.
  llmEnabled: true,
  llmModel: "gpt-oss-120b",
  llmProvider: "managed",
  maxSavedTabs: 3000,      // keep roughly the newest N saved tabs (across sessions); older sessions are auto-pruned. 0 = keep everything.
  maxSnippetChars: 720,
  prepareSuggestions: false, // Opt in before inspecting pages in the background.
  settingsVersion: 11,
  showClutterNudges: true,
  tokenServiceUrl: DEFAULT_TOKEN_SERVICE_URL
};

const MIN_CLUTTER_THRESHOLD = 5;
const MAX_CLUTTER_THRESHOLD = 200;

const MIN_SAVED_TABS = 100;        // a fat-fingered tiny value shouldn't nuke most stashes
const MAX_SAVED_TABS = 50_000;
// Hard storage backstop: chrome.storage.local caps at ~10MB and we don't request
// unlimitedStorage. enforceRetention trims oldest sessions past this regardless of
// the count limit, so a save can never fail with a quota error.
const RETENTION_BYTE_BUDGET = 8 * 1024 * 1024;

function getLocal(keys) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.get(keys, (result) => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }
      resolve(result);
    });
  });
}

function setLocal(value) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.set(value, () => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }
      resolve();
    });
  });
}

function clampThreshold(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return DEFAULT_SETTINGS.clutterThreshold;
  return Math.max(MIN_CLUTTER_THRESHOLD, Math.min(MAX_CLUTTER_THRESHOLD, Math.round(n)));
}

// 0 → keep everything. Invalid/negative → default. Otherwise clamp to [MIN, MAX].
function clampSavedTabs(value) {
  const n = Number(value);
  if (n === 0) return 0;
  if (!Number.isFinite(n) || n < 0) return DEFAULT_SETTINGS.maxSavedTabs;
  return Math.max(MIN_SAVED_TABS, Math.min(MAX_SAVED_TABS, Math.round(n)));
}

export async function getSettings() {
  const result = await getLocal({ [SETTINGS_KEY]: DEFAULT_SETTINGS });
  const stored = result[SETTINGS_KEY] || {};
  // Drop legacy fields: `model` (pre-v5), `apiKey` (BYO OpenAI key, v7), and
  // `backendUrl` (the v7 data-proxy URL — replaced in v8 by tokenServiceUrl now
  // that the extension talks to the enclave directly).
  const { model: _legacyModel, apiKey: _legacyApiKey, backendUrl: _legacyBackendUrl, maxSavedSessions: _legacyMaxSavedSessions, ...rest } = stored;
  const merged = { ...DEFAULT_SETTINGS, ...rest };
  // v5 migration: anyone on a pre-Smart settings version gets bumped to Smart as default.
  // The Smart scope didn't exist yet when their setting was saved, so we treat their
  // "allWindows"/"currentWindow" as a stale default rather than an explicit preference.
  if ((rest.settingsVersion || 0) < 5) {
    merged.defaultScope = "smart";
  }
  // v6 added clutterThreshold. Missing → default. Out-of-range → clamp.
  merged.clutterThreshold = clampThreshold(merged.clutterThreshold);
  // Saved-tab retention limit. Missing → default. Out-of-range → clamp (0 = unlimited).
  merged.maxSavedTabs = clampSavedTabs(merged.maxSavedTabs);
  // The backend URL is baked in, not user-configurable — coerce any stored blank to the default.
  if (!merged.tokenServiceUrl) merged.tokenServiceUrl = DEFAULT_TOKEN_SERVICE_URL;
  // v7: ensure a stable anonymous install id for backend per-user rate limiting.
  let persistNeeded = false;
  if (!merged.installId) {
    merged.installId = globalThis.crypto?.randomUUID?.() || `id-${nowIso()}-${Math.random().toString(36).slice(2)}`;
    persistNeeded = true;
  }
  const finalSettings = { ...merged, settingsVersion: 11 };
  if (persistNeeded) {
    await setLocal({ [SETTINGS_KEY]: finalSettings });
  }
  return finalSettings;
}

export async function saveSettings(settings) {
  const current = await getSettings();
  const { model: _legacyModel, apiKey: _legacyApiKey, backendUrl: _legacyBackendUrl, enclaveKey: _legacyEnclaveKey, maxSavedSessions: _legacyMaxSavedSessions, ...incoming } = settings || {};
  const next = {
    ...current,
    ...incoming,
    clutterThreshold: clampThreshold(incoming.clutterThreshold ?? current.clutterThreshold),
    maxSavedTabs: clampSavedTabs(incoming.maxSavedTabs ?? current.maxSavedTabs),
    maxSnippetChars: Number(incoming.maxSnippetChars || current.maxSnippetChars),
    settingsVersion: 11
  };
  await setLocal({ [SETTINGS_KEY]: next });
  return next;
}

export async function getSessions() {
  const result = await getLocal({ [SESSIONS_KEY]: [] });
  return Array.isArray(result[SESSIONS_KEY]) ? result[SESSIONS_KEY] : [];
}

export async function saveSessions(sessions) {
  await setLocal({ [SESSIONS_KEY]: sessions });
  return sessions;
}

export async function addSession(session) {
  const sessions = await getSessions();
  const next = [{ ...session, updatedAt: nowIso() }, ...sessions];
  await saveSessions(next);
  return next;
}

export async function updateSession(sessionId, updater) {
  const sessions = await getSessions();
  let updatedSession = null;
  const next = sessions.map((session) => {
    if (session.id !== sessionId) return session;
    updatedSession = { ...updater(session), updatedAt: nowIso() };
    return updatedSession;
  });
  await saveSessions(next);
  return updatedSession;
}

export async function deleteSession(sessionId) {
  const sessions = await getSessions();
  const next = sessions.filter((session) => session.id !== sessionId);
  await saveSessions(next);
  return next;
}

// Decide which saved sessions to keep under the retention policy. Pure — pass
// sessions + settings, get back the array to keep (newest-first). Never removes
// a session that's still in review or has un-closed pending tabs; trims the
// oldest "closed" sessions past the count limit, then past a hard byte budget.
// Pass opts.byteBudget to override the default (used by tests).
export function enforceRetention(sessions, settings, opts = {}) {
  const list = Array.isArray(sessions) ? sessions : [];
  const maxTabs = clampSavedTabs(settings?.maxSavedTabs);
  const byteBudget = Number.isFinite(opts.byteBudget) ? opts.byteBudget : RETENTION_BYTE_BUDGET;
  const ts = (s) => Date.parse(s?.createdAt) || 0;
  const tabsIn = (s) => (Array.isArray(s?.tabs) ? s.tabs.length : 0);
  const isProtected = (s) =>
    s?.closeStatus === "review" || (Array.isArray(s?.pendingTabIds) && s.pendingTabIds.length > 0);

  const byNewest = [...list].sort((a, b) => ts(b) - ts(a));
  const protectedSessions = byNewest.filter(isProtected);
  const prunable = byNewest.filter((s) => !isProtected(s));

  // Tab-count limit (0 = keep everything). Keep whole sessions newest-first while
  // the running saved-tab total stays within budget; the newest session is always
  // kept even if it alone exceeds it. Protected sessions don't count toward budget.
  let keptPrunable;
  if (maxTabs <= 0) {
    keptPrunable = prunable;
  } else {
    keptPrunable = [];
    let running = 0;
    for (const s of prunable) {
      const n = tabsIn(s);
      if (keptPrunable.length > 0 && running + n > maxTabs) break;
      keptPrunable.push(s);
      running += n;
    }
  }

  // Byte backstop: drop the oldest prunable session until the whole set is under
  // budget. Protected sessions are never dropped, even if they alone exceed it.
  const bytesOf = (arr) => JSON.stringify(arr).length;
  while (keptPrunable.length && bytesOf([...protectedSessions, ...keptPrunable]) > byteBudget) {
    keptPrunable = keptPrunable.slice(0, -1);
  }

  return [...protectedSessions, ...keptPrunable].sort((a, b) => ts(b) - ts(a));
}
