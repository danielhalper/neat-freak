export function createId(prefix = "id") {
  const random = crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `${prefix}-${random}`;
}

export function nowIso() {
  return new Date().toISOString();
}

export function getDomain(url) {
  try {
    const parsed = new URL(url);
    return parsed.hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

export function isSavableUrl(url) {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    return ["http:", "https:", "file:"].includes(parsed.protocol);
  } catch {
    return false;
  }
}

export function truncateText(value, max = 700) {
  if (!value) return "";
  const compact = String(value).replace(/\s+/g, " ").trim();
  if (compact.length <= max) return compact;
  return `${compact.slice(0, max - 1)}...`;
}

export function slugify(value) {
  const slug = String(value || "group")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return slug || "group";
}

export function sortSessions(sessions) {
  return [...sessions].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
}

export function formatDateTime(iso) {
  if (!iso) return "";
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit"
  }).format(new Date(iso));
}

export function faviconFallback(domain) {
  return domain ? domain.slice(0, 1).toUpperCase() : "?";
}

// Compact "time since last focused" label for a tab, e.g. "5m ago" / "2h ago".
// `ts` is chrome.tabs.Tab.lastAccessed (focus time, not true usage — noisy and
// often absent), so a missing/non-finite value renders "" and the caller shows
// nothing rather than a misleading default. Floors to each unit so the higher
// unit takes over exactly at the boundary (no "60m ago" / "24h ago"). A future
// ts (clock skew) collapses to "just now".
export function formatRelativeActive(ts, now) {
  if (!Number.isFinite(ts) || !Number.isFinite(now)) return "";
  const diff = now - ts;
  if (diff < 60_000) return "just now";
  const min = Math.floor(diff / 60_000);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(diff / 3_600_000);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(diff / 86_400_000);
  if (day < 7) return `${day}d ago`;
  return `${Math.floor(diff / 604_800_000)}w ago`;
}
