import { test } from "node:test";
import assert from "node:assert/strict";
import { buildAssociationGraph } from "../src/categorizer.js";

// The single cross-tab edge from a 2-tab graph (or undefined if it scored
// below the edge floor and was dropped).
function soleEdge(graph) {
  return graph.topEdges.find(
    (e) =>
      (e.source === "a" && e.target === "b") ||
      (e.source === "b" && e.target === "a")
  );
}

const BASE = 1_700_000_000_000;

test("proximity alone cannot union two tabs (cap holds below threshold)", () => {
  // Adjacent in the strip AND touched 30s apart = maxed-out proximity
  // (0.30 + 0.52 + 0.08 = 0.90 raw) but zero content overlap. The PROXIMITY_CAP
  // must clamp the contribution to 0.6 so the edge stays under the 0.74 union
  // threshold — otherwise two tabs you merely clicked between would merge.
  const graph = buildAssociationGraph([
    { id: "a", title: "Zebra Conservation Fund", url: "https://zebra-trust.org/donate", windowId: 1, index: 0, lastAccessed: BASE },
    { id: "b", title: "Quarterly Payroll Spreadsheet", url: "https://payrollpro.example/q3", windowId: 1, index: 1, lastAccessed: BASE + 30_000 }
  ]);

  const edge = soleEdge(graph);
  assert.ok(edge, "expected a recorded edge between the two proximate tabs");
  assert.ok(edge.score <= 0.6 + 1e-9, `proximity should be capped at 0.6, got ${edge.score}`);
  assert.ok(edge.score < 0.74, "capped proximity must stay below the union threshold");
  assert.equal(graph.clusters.length, 2, "no-content proximate tabs must not union");
});

test("a sliver of content glue lets proximate tabs union", () => {
  // Same adjacency and timing, now sharing the "Kubernetes Migration" theme.
  // Capped proximity (0.6) plus real content overlap clears 0.74 and unions.
  const graph = buildAssociationGraph([
    { id: "a", title: "Kubernetes Migration Runbook", url: "https://kteam.example/runbook", windowId: 1, index: 0, lastAccessed: BASE },
    { id: "b", title: "Kubernetes Migration Checklist", url: "https://other.example/list", windowId: 1, index: 1, lastAccessed: BASE + 30_000 }
  ]);

  const edge = soleEdge(graph);
  assert.ok(edge, "expected a recorded edge between the two tabs");
  assert.ok(edge.score >= 0.74, `content + capped proximity should union, got ${edge.score}`);
  assert.equal(graph.clusters.length, 1, "content-glued proximate tabs should union");
});

// Isolate the temporal signal: different windows kill the positional bonus and
// the distinct content kills everything else, so the sole edge score reflects
// only the temporal bucket (all bucket values sit under PROXIMITY_CAP, so none
// is clamped). Guards the gradient — including the new <=5m tier sitting below
// <=2m and above <=10m — without pinning exact decimals that we'll keep tuning.
function temporalEdgeScore(minsApart) {
  const graph = buildAssociationGraph([
    { id: "a", title: "Zebra Conservation Fund", url: "https://zebra-trust.org/x", windowId: 1, index: 0, lastAccessed: BASE },
    { id: "b", title: "Quarterly Payroll Spreadsheet", url: "https://payrollpro.example/y", windowId: 2, index: 0, lastAccessed: BASE + minsApart * 60_000 }
  ]);
  return soleEdge(graph)?.score ?? 0;
}

test("temporal proximity weakens monotonically as the gap widens", () => {
  const within2m = temporalEdgeScore(1);
  const within5m = temporalEdgeScore(4);
  const within10m = temporalEdgeScore(8);
  const within1h = temporalEdgeScore(30);

  assert.ok(within2m > within5m, `<=2m (${within2m}) should outrank <=5m (${within5m})`);
  assert.ok(within5m > within10m, `<=5m (${within5m}) should outrank <=10m (${within10m})`);
  assert.ok(within10m > within1h, `<=10m (${within10m}) should outrank <=1h (${within1h})`);
});
