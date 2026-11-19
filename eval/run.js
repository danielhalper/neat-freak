// Smart-scope eval harness.
//
// Compares the Smart LLM path across two axes on a fixed real-tab corpus:
//   model:   gpt-5.4-mini (OpenAI)  vs  gpt-oss-120b (Tinfoil confidential)
//   payload: full (title+url+pageSummary+recency)  vs  minimized (title+origin+recency, no pageSummary)
//
// Reference = gpt-5.4 with high reasoning effort on the full payload ("what
// good looks like"). Every other variant is scored as divergence from it.
//
// It reuses the EXACT shipped request builder + response parser
// (buildSmartScopeRequest / parseSmartScopeResponse) so there's no prompt
// drift — only the endpoint, model id, reasoning effort, and per-tab payload change.
//
// Also scores the shipped local heuristic (runSmartScope with AI off) as a
// no-model baseline. It is recency-driven, so its numbers inherit the corpus's
// synthetic minutesAgo values; treat them as indicative only.
//
// Multi-run: each non-reference variant runs N times (--runs=N, default 3) so
// we can average out LLM stochasticity and report a self-consistency floor
// (how much a model agrees with ITSELF across runs). The reference and the
// deterministic local heuristic run once.
//
// Run:  node --env-file=eval/.env eval/run.js [--runs=3]
// Needs OPENAI_API_KEY and TINFOIL_API_KEY in the environment.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildSmartScopeRequest, parseSmartScopeResponse, runSmartScope } from "../src/smart-scope.js";
import { buildAssociationGraph } from "../src/categorizer.js";

const dir = path.dirname(fileURLToPath(import.meta.url));
const NOW = 1_700_000_000_000; // fixed clock → deterministic minutesAgo

const runsArg = process.argv.find((a) => a.startsWith("--runs"));
let RUNS = 3;
if (runsArg) {
  const raw = runsArg.includes("=") ? runsArg.split("=")[1] : process.argv[process.argv.indexOf(runsArg) + 1];
  RUNS = Math.max(1, parseInt(raw, 10) || 3);
}

const corpus = JSON.parse(fs.readFileSync(path.join(dir, "corpus.json"), "utf8"));

const ENDPOINTS = {
  openai: { url: "https://api.openai.com/v1/chat/completions", key: process.env.OPENAI_API_KEY },
  tinfoil: { url: "https://inference.tinfoil.sh/v1/chat/completions", key: process.env.TINFOIL_API_KEY },
};

// Per-1M token prices. Tinfoil values are real (from its /v1/models). The
// OpenAI values are ASSUMPTIONS — adjust to the real rates for accurate $.
const PRICES = {
  "gpt-5.4": { in: 1.25, out: 10.0, assumed: true },
  "gpt-5.4-mini": { in: 0.25, out: 2.0, assumed: true },
  "gpt-oss-120b": { in: 0.09, out: 0.45, assumed: false }, // overwritten from Tinfoil /v1/models if reachable
};

const VARIANTS = [
  { key: "gold", label: "gpt-5.4 · high · full", provider: "openai", model: "gpt-5.4", payload: "full", reasoningEffort: "high", reference: true },
  { key: "baseline", label: "gpt-5.4-mini · full", provider: "openai", model: "gpt-5.4-mini", payload: "full" },
  { key: "openai-min", label: "gpt-5.4-mini · minimized", provider: "openai", model: "gpt-5.4-mini", payload: "minimized" },
  { key: "tinfoil-full", label: "gpt-oss-120b · full", provider: "tinfoil", model: "gpt-oss-120b", payload: "full" },
  { key: "tinfoil-min", label: "gpt-oss-120b · minimized", provider: "tinfoil", model: "gpt-oss-120b", payload: "minimized" },
  { key: "heuristic", label: "local heuristic (no AI)", provider: "local", payload: "full" },
];

function buildTabs(mode) {
  return corpus.map((c) => {
    const lastAccessed = NOW - c.minutesAgo * 60_000;
    if (mode === "minimized") {
      let origin = c.url;
      try { origin = new URL(c.url).origin; } catch { /* keep raw */ }
      return { id: c.id, title: c.title, url: origin, pageSummary: "", lastAccessed };
    }
    return { id: c.id, title: c.title, url: c.url, pageSummary: c.pageSummary, lastAccessed };
  });
}

function withTabById(graph, tabs) {
  return graph.tabById ? graph : { ...graph, tabById: new Map(tabs.map((t) => [t.id, t])) };
}

async function post(url, key, body) {
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { ok: res.ok, status: res.status, text: await res.text() };
}

async function runVariant(v) {
  const tabs = buildTabs(v.payload);
  if (v.provider === "local") {
    // Exactly the shipped fallback: AI off, same clock as the model variants.
    const t0 = Date.now();
    const result = await runSmartScope(tabs, { llmEnabled: false }, { now: NOW, minSaveCount: 0 });
    return { v, tabs, result, usage: {}, latencyMs: Date.now() - t0, fallback: false };
  }
  const graph = withTabById(buildAssociationGraph(tabs), tabs);
  const body = buildSmartScopeRequest(tabs, graph, NOW, { minSaveCount: 0 });
  body.model = v.model;
  if (v.reasoningEffort) body.reasoning_effort = v.reasoningEffort;
  const ep = ENDPOINTS[v.provider];
  if (!ep.key) throw new Error(`Missing API key for provider "${v.provider}"`);

  const t0 = Date.now();
  let r = await post(ep.url, ep.key, body);
  let fallback = false;
  if (!r.ok) {
    fallback = true;
    const fb = { ...body, response_format: { type: "json_object" } };
    delete fb.reasoning_effort;
    r = await post(ep.url, ep.key, fb);
  }
  const latencyMs = Date.now() - t0;
  if (!r.ok) throw new Error(`${v.key} HTTP ${r.status}: ${r.text.slice(0, 400)}`);

  const data = JSON.parse(r.text);
  const content = data?.choices?.[0]?.message?.content || "{}";
  let parsed;
  try { parsed = JSON.parse(content); }
  catch { throw new Error(`${v.key}: model did not return JSON. First 300 chars: ${content.slice(0, 300)}`); }

  const result = parseSmartScopeResponse(parsed, tabs, graph, NOW);
  return { v, tabs, result, usage: data.usage || {}, latencyMs, fallback };
}

// ---- scoring ----
function actionMap(result) {
  const m = new Map();
  for (const t of result.saveSet) m.set(t.id, "save");
  for (const t of result.keepSet) m.set(t.id, "keep");
  return m;
}
function folderMap(result) {
  const m = new Map();
  for (const c of result.categories) for (const id of c.tabIds) m.set(id, c.name);
  return m;
}
function actionAgreement(base, other) {
  let same = 0, total = 0;
  for (const [id, a] of base) { total++; if (other.get(id) === a) same++; }
  return total ? same / total : 1;
}
// Pairwise co-membership (Rand index) over tabs grouped in BOTH variants.
function groupingAgreement(baseG, otherG) {
  const ids = [...baseG.keys()].filter((id) => otherG.has(id));
  let agree = 0, total = 0;
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      total++;
      const sameBase = baseG.get(ids[i]) === baseG.get(ids[j]);
      const sameOther = otherG.get(ids[i]) === otherG.get(ids[j]);
      if (sameBase === sameOther) agree++;
    }
  }
  return total ? agree / total : 1;
}
function cost(model, usage) {
  const p = PRICES[model];
  if (!p || !usage) return null;
  return ((usage.prompt_tokens || 0) / 1e6) * p.in + ((usage.completion_tokens || 0) / 1e6) * p.out;
}
function stats(arr) {
  const a = arr.filter((x) => x != null);
  if (!a.length) return { mean: null, min: null, max: null };
  return { mean: a.reduce((s, x) => s + x, 0) / a.length, min: Math.min(...a), max: Math.max(...a) };
}
// Mean pairwise action agreement among a variant's own runs = its noise floor.
function selfConsistency(passes) {
  if (passes.length < 2) return null;
  const maps = passes.map((p) => actionMap(p.result));
  let sum = 0, n = 0;
  for (let i = 0; i < maps.length; i++) {
    for (let j = i + 1; j < maps.length; j++) { sum += actionAgreement(maps[i], maps[j]); n++; }
  }
  return n ? sum / n : null;
}

async function refreshTinfoilPrices() {
  try {
    const res = await fetch("https://inference.tinfoil.sh/v1/models", { headers: { Authorization: `Bearer ${ENDPOINTS.tinfoil.key}` } });
    if (!res.ok) return;
    const { data } = await res.json();
    for (const m of data || []) {
      if (PRICES[m.id] && m.pricing) PRICES[m.id] = { in: m.pricing.inputTokenPricePer1M, out: m.pricing.outputTokenPricePer1M, assumed: false };
    }
  } catch { /* offline price fallback is fine */ }
}

const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const pct = (n) => (n == null ? "—" : (n * 100).toFixed(0) + "%");

// agg[] entries: { v, passes:[run...], saves,keeps,folders,actAgree,grpAgree,self,latency,pt,ct,costStat }
function buildAggregates(refRun, byVariant) {
  const refA = actionMap(refRun.result), refG = folderMap(refRun.result);
  return VARIANTS.map((v) => {
    const passes = v.reference ? [refRun] : (byVariant.get(v.key) || []);
    if (!passes.length) return null;
    const acts = v.reference ? [] : passes.map((p) => actionAgreement(refA, actionMap(p.result)));
    const grps = v.reference ? [] : passes.map((p) => groupingAgreement(refG, folderMap(p.result)));
    return {
      v, passes,
      saves: stats(passes.map((p) => p.result.saveSet.length)),
      keeps: stats(passes.map((p) => p.result.keepSet.length)),
      folders: stats(passes.map((p) => p.result.categories.length)),
      actAgree: v.reference ? null : stats(acts),
      grpAgree: v.reference ? null : stats(grps),
      self: selfConsistency(passes),
      latency: stats(passes.map((p) => p.latencyMs)),
      pt: stats(passes.map((p) => p.usage.prompt_tokens || 0)),
      ct: stats(passes.map((p) => p.usage.completion_tokens || 0)),
      costStat: stats(passes.map((p) => cost(p.v.model, p.usage))),
      fallback: passes.some((p) => p.fallback),
    };
  }).filter(Boolean);
}

function renderReport(agg, refRun) {
  const money = (c, model) => (c == null ? "—" : "$" + c.toFixed(5) + (PRICES[model]?.assumed ? "*" : ""));
  const spread = (s) => (s.mean == null ? "—" : `${(s.mean * 100).toFixed(0)}% <span class="rng">[${(s.min * 100).toFixed(0)}–${(s.max * 100).toFixed(0)}]</span>`);

  const rows = agg.map((m) => `
    <tr>
      <td class="lbl">${esc(m.v.label)}${m.v.reference ? ' <span class="ref">reference</span>' : ""}${m.fallback ? ' <span class="warn">⚠ fallback</span>' : ""}</td>
      <td>${m.passes.length}</td>
      <td>${m.saves.mean.toFixed(1)} / ${m.keeps.mean.toFixed(1)}</td>
      <td>${m.folders.mean.toFixed(1)} <span class="rng">[${m.folders.min}–${m.folders.max}]</span></td>
      <td class="${m.actAgree && m.actAgree.mean < 0.8 ? "bad" : "good"}">${m.actAgree ? spread(m.actAgree) : "—"}</td>
      <td>${m.grpAgree ? spread(m.grpAgree) : "—"}</td>
      <td class="self">${pct(m.self)}</td>
      <td>${(m.latency.mean / 1000).toFixed(1)}s</td>
      <td>${money(m.costStat.mean, m.v.model)}</td>
    </tr>`).join("");

  // representative run (#1) per variant for the eyeball views
  const rep = agg.map((m) => ({ key: m.v.key, label: m.v.label, run: m.passes[0] }));
  const titleById = new Map(corpus.map((c) => [c.id, c.title]));
  const maps = rep.map((r) => ({ key: r.key, a: actionMap(r.run.result), g: folderMap(r.run.result) }));
  const cell = (mp, id) => {
    if (mp.a.get(id) === "keep") return `<span class="keep">keep</span>`;
    const f = mp.g.get(id);
    return `<span class="save">save</span>${f ? ` <span class="folder">${esc(f)}</span>` : ""}`;
  };
  const matrixRows = corpus.map((c) => {
    const baseAct = maps[0].a.get(c.id);
    const cells = maps.map((mp) => {
      const diff = mp.key !== "gold" && mp.a.get(c.id) !== baseAct;
      return `<td class="${diff ? "diff" : ""}">${cell(mp, c.id)}</td>`;
    }).join("");
    return `<tr><td class="tab">${esc(c.title)}</td>${cells}</tr>`;
  }).join("");

  const foldersHtml = rep.map((r) => {
    const cats = r.run.result.categories.map((c) =>
      `<div class="fold"><div class="fold-h">${esc(c.name)} <span class="n">(${c.tabIds.length})</span></div>` +
      `<ul>${c.tabIds.map((id) => `<li>${esc(titleById.get(id) || id)}</li>`).join("")}</ul></div>`).join("");
    const kept = r.run.result.keepSet.map((t) => `<li>${esc(titleById.get(t.id) || t.id)}</li>`).join("");
    return `<div class="col"><h3>${esc(r.label)}</h3>${cats || "<em>no folders</em>"}
      <div class="fold kept"><div class="fold-h">kept open <span class="n">(${r.run.result.keepSet.length})</span></div><ul>${kept}</ul></div></div>`;
  }).join("");

  return `<!doctype html><meta charset="utf-8"><title>Smart-scope eval</title>
<style>
  body{font:14px/1.5 -apple-system,system-ui,sans-serif;margin:24px;color:#1a1a1a;max-width:1240px}
  h1{font-size:20px} h2{font-size:16px;margin-top:32px;border-bottom:1px solid #ddd;padding-bottom:4px}
  table{border-collapse:collapse;width:100%;margin:8px 0}
  th,td{border:1px solid #e0e0e0;padding:6px 8px;text-align:left;vertical-align:top}
  th{background:#f6f6f6;font-weight:600}
  .lbl{font-weight:600}.good{color:#0a7d28}.bad{color:#c0392b;font-weight:600}.self{color:#555}
  .rng{color:#999;font-weight:400;font-size:11px}
  .ref{color:#6a1b9a;font-size:11px;font-weight:600}.warn{color:#b35900;font-size:11px}
  .save{color:#0a7d28;font-weight:600}.keep{color:#999}.folder{color:#555;font-size:12px}
  td.diff{background:#fff3cd}.tab{max-width:320px;font-size:12px}
  .cols{display:flex;gap:14px;flex-wrap:wrap}.col{flex:1;min-width:220px}
  .fold{margin:6px 0;border:1px solid #eee;border-radius:6px;padding:6px 8px}
  .fold-h{font-weight:600;font-size:13px}.fold .n{color:#999;font-weight:400}
  .fold ul{margin:4px 0 0;padding-left:18px}.fold li{font-size:12px;color:#333}
  .kept{background:#fafafa}.note{color:#666;font-size:12px;background:#f6f6f6;padding:8px 12px;border-radius:6px}
</style>
<h1>Smart-scope eval — gpt-5.4-mini vs gpt-oss-120b (Tinfoil), full vs minimized payload</h1>
<p class="note">Corpus: ${corpus.length} real open tabs. Each non-reference variant ran <b>${agg.find((m) => !m.v.reference)?.passes.length ?? 0}×</b> (means shown, <span class="rng">[min–max]</span> in brackets).
Reference = <b>gpt-5.4 · high reasoning · full</b> ("what good looks like", 1 run); agreement columns measure divergence from it.
<b>Self-consistency</b> = how much a model agrees with ITSELF across its runs — the noise floor; differences smaller than (100% − self) are likely noise.
Minimized payload = title + origin + recency only (no pageSummary). <b>recency is synthetic</b>, held constant across variants. <code>*</code> = assumed price.</p>

<h2>Summary</h2>
<table>
  <tr><th>Variant</th><th>runs</th><th>save/keep</th><th>folders</th><th>action vs ref</th><th>grouping vs ref</th><th>self-consistency</th><th>latency</th><th>est. cost</th></tr>
  ${rows}
</table>

<h2>Per-tab decisions — representative run #1 (highlighted = differs from reference)</h2>
<table>
  <tr><th>Tab</th>${rep.map((r) => `<th>${esc(r.label)}</th>`).join("")}</tr>
  ${matrixRows}
</table>

<h2>Folders, side by side — representative run #1</h2>
<div class="cols">${foldersHtml}</div>`;
}

(async function main() {
  await refreshTinfoilPrices();
  console.log(`RUNS=${RUNS} per non-reference variant\n`);

  const refVariant = VARIANTS.find((v) => v.reference);
  let refRun;
  const byVariant = new Map();

  for (const v of VARIANTS) {
    const n = v.reference || v.provider === "local" ? 1 : RUNS;
    for (let i = 0; i < n; i++) {
      process.stdout.write(`${v.label}${n > 1 ? ` [${i + 1}/${n}]` : ""} ... `);
      try {
        const r = await runVariant(v);
        if (v.reference) refRun = r;
        else { if (!byVariant.has(v.key)) byVariant.set(v.key, []); byVariant.get(v.key).push(r); }
        console.log(`ok (${(r.latencyMs / 1000).toFixed(1)}s, ${r.result.saveSet.length}s/${r.result.keepSet.length}k, ${r.result.categories.length} folders${r.fallback ? ", FALLBACK" : ""})`);
      } catch (e) {
        console.log(`FAILED: ${e.message}`);
      }
    }
  }
  if (!refRun) { console.error("Reference run failed — cannot score. Aborting."); process.exit(1); }

  const agg = buildAggregates(refRun, byVariant);

  console.log(`\n=== Summary (vs ${refVariant.label}; means over ${RUNS} runs) ===`);
  for (const m of agg) {
    const parts = [m.v.label.padEnd(26), `${m.saves.mean.toFixed(1)}s/${m.keeps.mean.toFixed(1)}k`.padEnd(11), `${m.folders.mean.toFixed(1)}grp`.padEnd(8)];
    if (!m.v.reference) {
      parts.push(`act ${(m.actAgree.mean * 100).toFixed(0)}% [${(m.actAgree.min * 100).toFixed(0)}-${(m.actAgree.max * 100).toFixed(0)}]`.padEnd(16));
      parts.push(`self ${pct(m.self)}`);
    } else {
      parts.push("(reference)");
    }
    console.log("  " + parts.join(" "));
  }

  const out = path.join(dir, "report.html");
  fs.writeFileSync(out, renderReport(agg, refRun));
  console.log(`\nReport: ${out}`);
})();
