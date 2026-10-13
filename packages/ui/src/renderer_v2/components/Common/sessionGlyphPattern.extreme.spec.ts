import assert from "node:assert/strict";
import {
  getSessionGlyphIndex,
  getSessionGlyphIndices,
  SESSION_GLYPH_PATTERN_CODES,
} from "./sessionGlyphPattern";

// 1. Consistency: Same session ID always gets the exact same glyph indices and index
assert.equal(
  getSessionGlyphIndex("session-abc"),
  getSessionGlyphIndex("session-abc"),
);
assert.equal(getSessionGlyphIndex("tuo2api"), getSessionGlyphIndex("tuo2api"));
assert.equal(getSessionGlyphIndex("kimi-3"), getSessionGlyphIndex("kimi-3"));

const c1 = getSessionGlyphIndices("30ad0ab4-b693-44f0-9dae-99ae531494b1");
const c2 = getSessionGlyphIndices("30ad0ab4-b693-44f0-9dae-99ae531494b1");
assert.deepEqual(c1, c2);

// 2. Bound invariant: Always returns an integer in [0, 47], frame in [0, 11], nucleus in [0, 3]
for (let i = 0; i < 500; i++) {
  const id = `session-uuid-${i}-${Math.random().toString(36)}`;
  const idx = getSessionGlyphIndex(id);
  const { frame, nucleus } = getSessionGlyphIndices(id);
  assert.ok(Number.isInteger(idx), "index must be integer");
  assert.ok(idx >= 0 && idx < 48, `index must be between 0 and 47, got ${idx}`);
  assert.ok(
    frame >= 0 && frame < 12,
    `frame must be between 0 and 11, got ${frame}`,
  );
  assert.ok(
    nucleus >= 0 && nucleus < 4,
    `nucleus must be between 0 and 3, got ${nucleus}`,
  );
  assert.equal(idx, frame * 4 + nucleus);
}

// 3. Fallback for undefined or empty ID
assert.equal(getSessionGlyphIndex(undefined), 0);
assert.equal(getSessionGlyphIndex(""), 0);
assert.deepEqual(getSessionGlyphIndices(undefined), { frame: 0, nucleus: 0 });
assert.deepEqual(getSessionGlyphIndices(""), { frame: 0, nucleus: 0 });

// 4. Spread: Across different IDs, all 12 frames and all 4 nuclei are well distributed
const seenFrames = new Set<number>();
const seenNuclei = new Set<number>();
const seenIndices = new Set<number>();

for (let i = 0; i < 1000; i++) {
  const id = `session-test-distribution-${i}`;
  const { frame, nucleus } = getSessionGlyphIndices(id);
  seenFrames.add(frame);
  seenNuclei.add(nucleus);
  seenIndices.add(getSessionGlyphIndex(id));
}

assert.equal(seenFrames.size, 12, "All 12 frames must be reached");
assert.equal(seenNuclei.size, 4, "All 4 nuclei must be reached");
assert.ok(
  seenIndices.size >= 40,
  `Expected broad distribution across 48 glyphs, got ${seenIndices.size}`,
);

// 5. Pattern invariant: every variant is unique, mirrored, has readable density, and spans full 5x5 bounding box
assert.equal(SESSION_GLYPH_PATTERN_CODES.length, 48);
assert.equal(new Set(SESSION_GLYPH_PATTERN_CODES).size, 48);
for (let i = 0; i < SESSION_GLYPH_PATTERN_CODES.length; i += 1) {
  const patternCode = SESSION_GLYPH_PATTERN_CODES[i];
  assert.ok(patternCode >= 0 && patternCode < 1 << 15);
  let filled = 0;
  const filledRows = new Set<number>();
  const filledCols = new Set<number>();

  for (let row = 0; row < 5; row += 1) {
    for (let column = 0; column < 5; column += 1) {
      const sourceColumn = column > 2 ? 4 - column : column;
      const isFilled = Boolean(patternCode & (1 << (row * 3 + sourceColumn)));
      if (isFilled) {
        filled += 1;
        filledRows.add(row);
        filledCols.add(column);
      }
      if (column > 2) {
        const mirrorColumn = 4 - column;
        assert.equal(
          isFilled,
          Boolean(patternCode & (1 << (row * 3 + mirrorColumn))),
        );
      }
    }
  }
  assert.ok(
    filled >= 10 && filled <= 16,
    `Glyph ${i} fill out of range: ${filled}`,
  );
  assert.equal(
    filledRows.size,
    5,
    `Glyph ${i} must span all 5 rows, got ${filledRows.size}`,
  );
  assert.equal(
    filledCols.size,
    5,
    `Glyph ${i} must span all 5 columns, got ${filledCols.size}`,
  );
}

console.log("All SessionGlyph extreme tests passed.");
