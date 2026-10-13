import type React from "react";
import type { ITheme } from "@xterm/xterm";
import { COLOR_NAMES } from "../../../theme/xtermTheme";
import type { BlockRun } from "./terminalBlockModel";

/** Default foreground of block rows: the terminal theme's, else the app's. */
const defaultForeground = (theme: ITheme): string =>
  theme.foreground || "var(--fg)";

/**
 * CSS colour of an xterm cell colour. The 16 ANSI colours come from the
 * terminal theme (the same palette xterm renders with); 16-255 are xterm's
 * fixed 6x6x6 cube and grayscale ramp.
 */
const blockRunColor = (
  run: BlockRun,
  foreground: boolean,
  theme: ITheme,
): string => {
  const color = foreground ? run.foreground : run.background;
  if (color.mode === "default") {
    return foreground ? defaultForeground(theme) : "transparent";
  }
  if (color.mode === "rgb") {
    return `#${color.value.toString(16).padStart(6, "0")}`;
  }
  const index = Math.max(0, color.value);
  if (index < COLOR_NAMES.length) {
    return String(theme[COLOR_NAMES[index]] || defaultForeground(theme));
  }
  if (index >= 232) {
    const level = 8 + (index - 232) * 10;
    return `rgb(${level},${level},${level})`;
  }
  const component = (value: number) => (value === 0 ? 0 : 55 + value * 40);
  const cube = index - 16;
  return `rgb(${component(Math.floor(cube / 36))},${component(Math.floor(cube / 6) % 6)},${component(cube % 6)})`;
};

/** Inline style for one run of identically styled cells. */
export const blockRunStyle = (
  run: BlockRun,
  theme: ITheme,
): React.CSSProperties => {
  let color = blockRunColor(run, true, theme);
  let backgroundColor = blockRunColor(run, false, theme);
  if (run.inverse) [color, backgroundColor] = [backgroundColor, color];
  if (run.dim) color = `color-mix(in srgb, ${color} 55%, var(--app-bg))`;
  return {
    color: run.invisible ? "transparent" : color,
    backgroundColor:
      run.background.mode === "default" && !run.inverse
        ? "transparent"
        : backgroundColor,
    // Bold weight comes from the terminal font options (TerminalBlockView).
    fontWeight: run.bold ? "var(--terminal-block-font-weight-bold)" : undefined,
    fontStyle: run.italic ? "italic" : undefined,
    textDecoration:
      [
        run.underline && "underline",
        run.overline && "overline",
        run.strikethrough && "line-through",
      ]
        .filter(Boolean)
        .join(" ") || undefined,
  };
};
