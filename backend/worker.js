// Neat Freak — token / quota service (Cloudflare Worker).
//
// This service makes the operator truly BLIND to tab data. It does NOT proxy
// LLM requests. It only answers "is this install allowed today?" and, if so,
// mints a short-lived, token-capped Tinfoil key. The extension then calls the
// Tinfoil confidential enclave DIRECTLY with that key — tab content never
// touches this service. The only things it ever sees are install IDs + counters.
//
// Per-user rate limiting = the daily token budget baked into each minted key
// (Tinfoil enforces max_tokens). Cost backstops = per-IP and global daily mint
// caps. There is no per-request throttle (Tinfoil offers token caps only).
//
// Bindings (see wrangler.toml + README):
//   TINFOIL_ADMIN_KEY  secret         — an admin_-prefixed Tinfoil key (can create keys)
//   KEYS               KV namespace   — per-install minted-key cache + mint counters
//   DAILY_TOKEN_BUDGET    var         — max_tokens per install per day (default 150000)
//   GLOBAL_DAILY_MINTS    var         — cap on total keys minted per day (default 5000)
//   PER_IP_DAILY_MINTS    var         — cap on keys minted per IP per day (default 50)
//   ENCLAVE_MODEL         var         — informational, returned to client (default gpt-oss-120b)

const TINFOIL_ADMIN_KEYS_URL = "https://api.tinfoil.sh/api/keys";
const ENCLAVE_CHAT_URL = "https://inference.tinfoil.sh/v1/chat/completions";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-Install-Id",
  "Access-Control-Max-Age": "86400",
};

function json(status, obj) {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json", ...CORS } });
}

function dayBucket() {
  return Math.floor(Date.now() / 86_400_000);
}

// KV soft counter (not strictly atomic — fine for cost control).
async function underLimit(env, key, limit) {
  const current = Number((await env.KEYS.get(key)) || 0);
  if (current >= limit) return false;
  await env.KEYS.put(key, String(current + 1), { expirationTtl: 172_800 });
  return true;
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    if (request.method !== "POST") return json(405, { error: "Method not allowed" });

    const installId = (request.headers.get("X-Install-Id") || "").slice(0, 100);
    if (!installId) return json(400, { error: "Missing X-Install-Id" });

    const day = dayBucket();
    const model = env.ENCLAVE_MODEL || "gpt-oss-120b";

    // Reuse today's key if we already minted one for this install. This both
    // saves Admin API calls AND enforces the daily budget — without it, a client
    // that cleared its cache could re-request and get a fresh budget (2x limit).
    const cacheKey = `grant:${installId}:${day}`;
    const cached = await env.KEYS.get(cacheKey, "json");
    if (cached && cached.key && cached.expiresAt > Date.now()) {
      return json(200, { key: cached.key, expiresAt: cached.expiresAt, model, baseUrl: ENCLAVE_CHAT_URL });
    }

    // Abuse backstops before spending an Admin API mint.
    const ip = request.headers.get("CF-Connecting-IP") || "unknown";
    if (!(await underLimit(env, `ipmints:${ip}:${day}`, Number(env.PER_IP_DAILY_MINTS || 20)))) {
      return json(429, { error: "Too many new installs from this network today." });
    }
    if (!(await underLimit(env, `mints:${day}`, Number(env.GLOBAL_DAILY_MINTS || 1000)))) {
      return json(429, { error: "Service is at daily capacity. Try again later." });
    }

    if (!env.TINFOIL_ADMIN_KEY) return json(500, { error: "Backend misconfigured: no admin key." });

    // Mint a capped, end-of-day-expiring key via Tinfoil's Admin API.
    const budget = Number(env.DAILY_TOKEN_BUDGET || 50_000);
    const expiresAtMs = (day + 1) * 86_400_000; // next UTC midnight
    const mint = await fetch(TINFOIL_ADMIN_KEYS_URL, {
      method: "POST",
      headers: { "Authorization": `Bearer ${env.TINFOIL_ADMIN_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        name: `nf-${installId}-${day}`.slice(0, 64),
        max_tokens: budget,
        expires_at: new Date(expiresAtMs).toISOString(),
        metadata: { installId, day: String(day) },
      }),
    });
    if (!mint.ok) {
      return json(502, { error: `Upstream key mint failed (${mint.status}).` });
    }
    const minted = await mint.json();
    // NOTE: confirm the exact field name against a real mint response.
    const keyValue = minted.key || minted.api_key || minted.token || minted.value;
    if (!keyValue) return json(502, { error: "Mint response missing key value." });

    // Cache the minted key for the rest of the day (capped + expiring, so storing it is low-risk).
    await env.KEYS.put(cacheKey, JSON.stringify({ key: keyValue, expiresAt: expiresAtMs }), { expirationTtl: 172_800 });

    return json(200, { key: keyValue, expiresAt: expiresAtMs, model, baseUrl: ENCLAVE_CHAT_URL });
  },
};
