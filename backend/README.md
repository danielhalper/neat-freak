# Neat Freak token service

A tiny Cloudflare Worker that lets the extension use AI **without the operator
ever seeing tab data.** It is NOT a proxy — tab content never passes through it.

It answers one question: *"is this install allowed today?"* If yes, it mints a
short-lived, token-capped Tinfoil key via the Admin API and returns it. The
**extension then calls the Tinfoil confidential enclave directly** with that key.
This service only ever sees an **install ID + counters**.

```
Tabs (blind to you):       extension ──tab data──▶ Tinfoil enclave
Permission (no tab data):  extension ──installId──▶ token service ──mints capped key──▶ Tinfoil Admin API
```

## Privacy stance

**Truly blind:** you're out of the data path, so you can't read tab content even
if you wanted to. Honest caveats:

- **No in-client attestation (yet).** The extension is no-build, so it calls the
  enclave over TLS without Tinfoil's SDK cryptographically *verifying* the enclave.
  You're still out of the path (blind); attestation is a later hardening (needs a build step).
- **Anonymous install IDs are spoofable** → abuse is bounded by per-IP and global
  daily mint caps, not eliminated.
- **Goes against Tinfoil's grain.** Their docs recommend a proxy and advise against
  per-user keys. Confirm per-user key minting works at your scale before relying on it.

## Rate limiting

- **Per install:** a daily token budget baked into each key (`max_tokens`), enforced by Tinfoil.
- **Cost backstops:** per-IP and global daily caps on how many keys get minted.
- There is no per-request/minute throttle — Tinfoil offers token caps only.

## Deploy

```bash
npm i -g wrangler
wrangler login

# 1. KV namespace for the per-install key cache + mint counters; paste id into wrangler.toml
wrangler kv namespace create KEYS

# 2. Store the ADMIN key as a secret (must be admin_-prefixed — it can create keys)
wrangler secret put TINFOIL_ADMIN_KEY

# 3. Ship it
wrangler deploy
```

Deploy prints your Worker URL, e.g. `https://neat-freak-token-service.<you>.workers.dev`.

## Wire the extension

In **Options → Token service URL**, paste that Worker URL. No manifest change
needed — the extension already requests broad `https://*/*` host permission.

(Self-test the mint first — see the project notes — to confirm your admin key works.)

## Tuning (`wrangler.toml` `[vars]`)

- `DAILY_TOKEN_BUDGET` — max tokens per install per day (default 150000)
- `GLOBAL_DAILY_MINTS` — total keys minted per day, cost circuit breaker (default 5000)
- `PER_IP_DAILY_MINTS` — keys minted per IP per day, abuse guard (default 50)
- `ENCLAVE_MODEL` — model id returned to the client (default gpt-oss-120b)

KV counters are eventually-consistent, so caps are *soft* (fine for cost control).
For hard guarantees, port the counters to a Durable Object.
