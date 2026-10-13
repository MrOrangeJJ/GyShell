import React from "react";
import {
  SESSION_GLYPH_PATTERN_CODES,
  getSessionGlyphIndex,
  isSessionGlyphCellFilled,
} from "./sessionGlyphPattern";
import "./sessionGlyph.scss";

const GRID_SIZE = 5;
const CELL_SIZE = 2.3;
const CELL_GAP = 0.55;
const GRID_ORIGIN = 1.15;
const CORNER_RADIUS = 0.45;

export interface SessionGlyphProps {
  sessionId?: string;
  size?: number;
  className?: string;
  /** Without a title the glyph is decorative and hidden from assistive tech. */
  title?: string;
}

/** Single-colour Session Fingerprint mark for a Chat session (SVG). */
export const SessionGlyph: React.FC<SessionGlyphProps> = ({
  sessionId,
  size = 13,
  className = "",
  title,
}) => {
  const variantIndex = getSessionGlyphIndex(sessionId);
  const patternCode = SESSION_GLYPH_PATTERN_CODES[variantIndex];

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="currentColor"
      shapeRendering="geometricPrecision"
      className={`session-glyph session-glyph-${variantIndex} ${className}`.trim()}
      aria-hidden={!title}
      aria-label={title}
    >
      {title ? <title>{title}</title> : null}
      {Array.from({ length: GRID_SIZE }, (_, row) =>
        Array.from({ length: GRID_SIZE }, (_, column) =>
          isSessionGlyphCellFilled(patternCode, row, column) ? (
            <rect
              key={`${row}-${column}`}
              x={GRID_ORIGIN + column * (CELL_SIZE + CELL_GAP)}
              y={GRID_ORIGIN + row * (CELL_SIZE + CELL_GAP)}
              width={CELL_SIZE}
              height={CELL_SIZE}
              rx={CORNER_RADIUS}
              stroke="none"
            />
          ) : null,
        ),
      )}
    </svg>
  );
};
