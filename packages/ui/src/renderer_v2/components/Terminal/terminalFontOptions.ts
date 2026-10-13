import React from "react";
import type { FontWeight, Terminal } from "@xterm/xterm";
import type { AppSettings } from "../../lib/ipcTypes";

/**
 * One source for the terminal's font: the xterm runtime (Classic and the
 * Block view's docked prompt) and the Block view's own rows both read it, so
 * a block reads exactly like the prompt below it.
 */
export interface TerminalFontOptions {
  fontFamily: string;
  fontSize: number;
  lineHeight: number;
  fontWeight: FontWeight;
  fontWeightBold: FontWeight;
}

/** xterm's own default family; there is no font-family setting yet. */
export const TERMINAL_FONT_FAMILY = "monospace";
export const TERMINAL_DEFAULT_FONT_SIZE = 14;
export const TERMINAL_DEFAULT_LINE_HEIGHT = 1.2;
const TERMINAL_FONT_WEIGHT: FontWeight = 500;
const TERMINAL_FONT_WEIGHT_BOLD: FontWeight = "bold";

type TerminalFontSettings = Partial<
  Pick<AppSettings["terminal"], "fontSize" | "lineHeight">
>;

/** Always concrete: a missing or cleared setting falls back to the default. */
export const resolveTerminalFontOptions = (
  settings: TerminalFontSettings | undefined,
): TerminalFontOptions => {
  const fontSize =
    typeof settings?.fontSize === "number" &&
    Number.isFinite(settings.fontSize) &&
    settings.fontSize >= 6
      ? settings.fontSize
      : TERMINAL_DEFAULT_FONT_SIZE;
  const lineHeight =
    typeof settings?.lineHeight === "number" &&
    Number.isFinite(settings.lineHeight) &&
    settings.lineHeight >= 1
      ? settings.lineHeight
      : TERMINAL_DEFAULT_LINE_HEIGHT;
  return {
    fontFamily: TERMINAL_FONT_FAMILY,
    fontSize,
    lineHeight,
    fontWeight: TERMINAL_FONT_WEIGHT,
    fontWeightBold: TERMINAL_FONT_WEIGHT_BOLD,
  };
};

/** xterm only re-renders for options whose value actually changed. */
export const applyTerminalFontOptions = (
  terminal: Terminal,
  font: TerminalFontOptions,
): void => {
  const { options } = terminal;
  options.fontFamily = font.fontFamily;
  options.fontSize = font.fontSize;
  options.lineHeight = font.lineHeight;
  options.fontWeight = font.fontWeight;
  options.fontWeightBold = font.fontWeightBold;
};

/**
 * Pixel pitch of one terminal row as rendered, so overlays and the Block
 * view line up with xterm's rows. Falls back to an estimate before the
 * terminal has a laid-out screen.
 */
export const measureTerminalRowHeight = (terminal: Terminal): number => {
  const screen = terminal.element?.querySelector<HTMLElement>(".xterm-screen");
  const measured = screen ? screen.clientHeight / Math.max(1, terminal.rows) : 0;
  if (measured > 0) return Math.round(measured * 100) / 100;
  const fontSize = terminal.options.fontSize || TERMINAL_DEFAULT_FONT_SIZE;
  const lineHeight = Math.max(1, terminal.options.lineHeight || 1);
  return Math.ceil(fontSize * lineHeight);
};

/**
 * Row height that only re-measures when the terminal resizes or its screen
 * changes size (a font or line-height change re-lays it out).
 */
export const useTerminalRowHeight = (terminal: Terminal | null): number => {
  const [rowHeight, setRowHeight] = React.useState(() =>
    terminal ? measureTerminalRowHeight(terminal) : 0,
  );
  React.useLayoutEffect(() => {
    if (!terminal) {
      setRowHeight(0);
      return undefined;
    }
    const update = () => setRowHeight(measureTerminalRowHeight(terminal));
    update();
    const resize = terminal.onResize(update);
    const screen = terminal.element?.querySelector<HTMLElement>(".xterm-screen");
    const observer = new ResizeObserver(update);
    if (screen) observer.observe(screen);
    return () => {
      resize.dispose();
      observer.disconnect();
    };
  }, [terminal]);
  return rowHeight;
};
