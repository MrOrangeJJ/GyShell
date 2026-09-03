import { hasOnlyPairedUtf16Surrogates } from "./opaqueIdentifiers";

export const TERMINAL_TITLE_MAX_UTF8_BYTES = 512;

export type TerminalTitleValidationFailure =
  | "wrong_type"
  | "blank"
  | "malformed_unicode"
  | "control_character"
  | "too_long";

export type TerminalTitleValidationResult =
  | { ok: true; title: string }
  | { ok: false; reason: TerminalTitleValidationFailure };

/**
 * Validates and normalizes a user-visible terminal title. Unlike terminal IDs,
 * titles are mutable display labels, so surrounding whitespace is discarded.
 */
export const validateTerminalTitle = (
  value: unknown,
): TerminalTitleValidationResult => {
  if (typeof value !== "string") {
    return { ok: false, reason: "wrong_type" };
  }
  if (!hasOnlyPairedUtf16Surrogates(value)) {
    return { ok: false, reason: "malformed_unicode" };
  }

  const title = value.trim();
  if (
    !title ||
    !Array.from(title).some(
      (character) => !/[\p{White_Space}\p{Cf}\p{Cc}]/u.test(character),
    )
  ) {
    return { ok: false, reason: "blank" };
  }
  if (
    /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u.test(
      title,
    )
  ) {
    return { ok: false, reason: "control_character" };
  }
  if (
    new TextEncoder().encode(title).byteLength > TERMINAL_TITLE_MAX_UTF8_BYTES
  ) {
    return { ok: false, reason: "too_long" };
  }

  return { ok: true, title };
};

export const readTerminalTitle = (value: unknown): string | undefined => {
  const result = validateTerminalTitle(value);
  return result.ok ? result.title : undefined;
};
