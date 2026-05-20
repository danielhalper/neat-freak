import { nowIso } from "./utils.js";

export const SETTINGS_KEY = "tabAtlasSettings";
export const SESSIONS_KEY = "tabAtlasSessions";

export const DEFAULT_SETTINGS = {
  apiKey: "",
  collectPageSummaries: true,
  defaultIncludePinned: false,
  defaultKeepCurrentTab: true,
  defaultReviewBeforeClose: false,
  defaultScope: "allWindows",
  llmEnabled: true,
  maxSnippetChars: 720,
  settingsVersion: 4
};

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

export async function getSettings() {
  const result = await getLocal({ [SETTINGS_KEY]: DEFAULT_SETTINGS });
  const stored = result[SETTINGS_KEY] || {};
  const { model: _legacyModel, ...rest } = stored;
  return { ...DEFAULT_SETTINGS, ...rest, settingsVersion: 4 };
}

export async function saveSettings(settings) {
  const current = await getSettings();
  const { model: _legacyModel, ...incoming } = settings || {};
  const next = {
    ...current,
    ...incoming,
    maxSnippetChars: Number(incoming.maxSnippetChars || current.maxSnippetChars),
    settingsVersion: 4
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
