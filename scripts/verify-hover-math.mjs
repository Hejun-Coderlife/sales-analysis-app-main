#!/usr/bin/env node
/**
 * Verifies index clamping used by resolveHoverIndexFromEvent (last category / right edge).
 * Run: node scripts/verify-hover-math.mjs
 */

function clampDataIndex(idx, labelCount) {
  if (!Number.isFinite(idx) || labelCount < 1) return null;
  const max = labelCount - 1;
  const n = Math.round(Number(idx));
  return Math.max(0, Math.min(max, n));
}

let failed = 0;
function assertEqual(name, got, want) {
  if (got !== want) {
    console.error(`FAIL ${name}: got ${got}, want ${want}`);
    failed++;
  }
}

assertEqual('edge 10 -> 9 (10 labels)', clampDataIndex(10, 10), 9);
assertEqual('edge 9.7 -> 9', clampDataIndex(9.7, 10), 9);
assertEqual('mid 5', clampDataIndex(5, 10), 5);
assertEqual('negative -> 0', clampDataIndex(-1, 10), 0);
assertEqual('single label', clampDataIndex(3, 1), 0);

if (failed) {
  console.error(`\n${failed} assertion(s) failed.`);
  process.exit(1);
}
console.log('verify-hover-math: all assertions passed.');
