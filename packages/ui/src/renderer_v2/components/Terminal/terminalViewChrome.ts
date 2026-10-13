import type React from "react";

/**
 * Shared chrome of both terminal views (Classic and Block). Geometry the
 * scripts need is defined here once and handed to the styles as CSS custom
 * properties on `.xterm-shell`, so the two never drift apart.
 */

/** Footer toolbar height; in Block view the docked prompt sits right above it. */
export const TERMINAL_FOOTER_HEIGHT_PX = 32;
/** One-off accent flash on a jump target (terminal rows or a block). */
export const TERMINAL_REVEAL_FLASH_MS = 1800;
/** Layout transitions: Block details pane and the docked prompt aperture. */
export const TERMINAL_VIEW_TRANSITION_MS = 150;

export const TERMINAL_VIEW_CHROME_STYLE = {
  "--terminal-footer-height": `${TERMINAL_FOOTER_HEIGHT_PX}px`,
  "--terminal-reveal-flash-duration": `${TERMINAL_REVEAL_FLASH_MS}ms`,
  "--terminal-view-transition": `${TERMINAL_VIEW_TRANSITION_MS}ms`,
} as React.CSSProperties;
