import assert from "node:assert/strict";
import {
  TERMINAL_TITLE_MAX_UTF8_BYTES,
  readTerminalTitle,
  validateTerminalTitle,
} from "./terminalTitles";

const assertRejected = (value: unknown, reason: string): void => {
  const result = validateTerminalTitle(value);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, reason);
};

assert.deepEqual(validateTerminalTitle("  Build \t\n"), {
  ok: true,
  title: "Build",
});
assert.equal(readTerminalTitle("  52 \r"), "52");
assertRejected(undefined, "wrong_type");
assertRejected(new String("Build"), "wrong_type");
assertRejected("", "blank");
assertRejected("  \t\n\u00a0\u200b  ", "blank");
assertRejected("before\u0000after", "control_character");
assertRejected("before\u200dafter", "control_character");
assertRejected("before\u202eafter", "control_character");
assertRejected("\ud800", "malformed_unicode");
assertRejected(`a${"界".repeat(171)}`, "too_long");
const exactBoundaryTitle = `${"界".repeat(170)}aa`;
assert.equal(
  new TextEncoder().encode(exactBoundaryTitle).byteLength,
  TERMINAL_TITLE_MAX_UTF8_BYTES,
);
assert.equal(validateTerminalTitle(` ${exactBoundaryTitle} `).ok, true);
assertRejected("  \u000b\f ", "blank");

console.log("terminalTitles.extreme.spec.ts passed");
