/**
 * Session Fingerprint: a deterministic 5x5 mark per Chat session id. The
 * hash is independent of the drawing, so a session keeps its mark for its
 * whole lifetime while the patterns can be refined.
 */

export interface SessionGlyphIndices {
  frame: number;
  nucleus: number;
}

const SESSION_GLYPH_FRAME_COUNT = 12;
const SESSION_GLYPH_NUCLEUS_COUNT = 4;

export function getSessionGlyphIndices(
  sessionId?: string,
): SessionGlyphIndices {
  if (!sessionId) return { frame: 0, nucleus: 0 };

  let hash = 0x811c9dc5;
  for (let index = 0; index < sessionId.length; index += 1) {
    hash ^= sessionId.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }

  // Murmur3 fmix32 keeps adjacent UUIDs from clustering in one direction.
  hash ^= hash >>> 16;
  hash = Math.imul(hash, 0x85ebca6b);
  hash ^= hash >>> 13;
  hash = Math.imul(hash, 0xc2b2ae35);
  hash ^= hash >>> 16;
  const unsignedHash = hash >>> 0;

  return {
    frame: unsignedHash % SESSION_GLYPH_FRAME_COUNT,
    nucleus: (unsignedHash >>> 4) % SESSION_GLYPH_NUCLEUS_COUNT,
  };
}

/** Flattened variant index into SESSION_GLYPH_PATTERN_CODES. */
export function getSessionGlyphIndex(sessionId?: string): number {
  const { frame, nucleus } = getSessionGlyphIndices(sessionId);
  return frame * SESSION_GLYPH_NUCLEUS_COUNT + nucleus;
}

/**
 * 48 horizontally mirrored 5x5 patterns. Each code stores the left three
 * columns (bit = row * 3 + column); every pattern spans the full 5x5 box with
 * 11-16 filled cells.
 */
export const SESSION_GLYPH_PATTERN_CODES = [
  0x324f, 0x3d74, 0x68c9, 0x16b2, 0x1d7a, 0x267c, 0x259b, 0x33e6, 0x1f39,
  0x65ed, 0x4f6d, 0x2d79, 0x74d6, 0x2f32, 0x4cba, 0x69d2, 0x13e9, 0x1e5a,
  0x27a7, 0x35ec, 0x5f6c, 0x664b, 0x1bd3, 0x1cf3, 0x334f, 0x66b9, 0x79b9,
  0x32f4, 0x3359, 0x3591, 0x6b3c, 0x1fb4, 0x4d79, 0x65e6, 0x137e, 0x338f,
  0x27c9, 0x2cbd, 0x2e59, 0x3279, 0x4cf4, 0x4daf, 0x4f99, 0x5f92, 0x69ed,
  0x725a, 0x74bc, 0x32ee,
] as const;

export const isSessionGlyphCellFilled = (
  patternCode: number,
  row: number,
  column: number,
): boolean => {
  const sourceColumn = column > 2 ? 4 - column : column;
  return Boolean(patternCode & (1 << (row * 3 + sourceColumn)));
};
