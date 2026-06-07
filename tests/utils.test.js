import test from "node:test";
import assert from "node:assert/strict";
import { formatRelativeActive } from "../src/utils.js";

const NOW = 1_700_000_000_000;
const ago = (ms) => NOW - ms;
const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;

test("missing or non-finite timestamp renders nothing", () => {
  // Tabs restored from a session or opened in the background have no
  // lastAccessed — we show no time rather than a misleading "just now".
  assert.equal(formatRelativeActive(undefined, NOW), "");
  assert.equal(formatRelativeActive(null, NOW), "");
  assert.equal(formatRelativeActive(NaN, NOW), "");
  assert.equal(formatRelativeActive(ago(MIN), undefined), "");
});

test("under a minute reads 'just now'", () => {
  assert.equal(formatRelativeActive(NOW, NOW), "just now");
  assert.equal(formatRelativeActive(ago(30 * SEC), NOW), "just now");
  assert.equal(formatRelativeActive(ago(59 * SEC), NOW), "just now");
});

test("minutes, hours, days, weeks each floor to their unit", () => {
  assert.equal(formatRelativeActive(ago(5 * MIN), NOW), "5m ago");
  assert.equal(formatRelativeActive(ago(59 * MIN), NOW), "59m ago");
  assert.equal(formatRelativeActive(ago(2 * HOUR), NOW), "2h ago");
  assert.equal(formatRelativeActive(ago(23 * HOUR), NOW), "23h ago");
  assert.equal(formatRelativeActive(ago(3 * DAY), NOW), "3d ago");
  assert.equal(formatRelativeActive(ago(2 * WEEK), NOW), "2w ago");
});

test("unit boundaries roll over cleanly (no '60m' or '24h')", () => {
  // Floor semantics mean the higher unit takes over exactly at the boundary,
  // so we never render the awkward "60m ago" / "24h ago".
  assert.equal(formatRelativeActive(ago(60 * MIN), NOW), "1h ago");
  assert.equal(formatRelativeActive(ago(24 * HOUR), NOW), "1d ago");
  assert.equal(formatRelativeActive(ago(7 * DAY), NOW), "1w ago");
});

test("a future timestamp (clock skew) is treated as 'just now'", () => {
  assert.equal(formatRelativeActive(NOW + 5 * MIN, NOW), "just now");
});
