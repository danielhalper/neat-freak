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
  // (0.30 + 0.50 + 0.08 = 0.88 raw) but zero content overlap. The PROXIMITY_CAP
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
