import assert from "node:assert/strict";
import type { TerminalActivitySnapshot } from "@gyshell/shared";
import type { TerminalCommandAnnotation } from "./block/terminalBlockModel";
import {
  filterTerminalCommands,
  getTerminalCommandSearchHighlights,
  getNavigableTerminalAnnotations,
} from "./terminalCommandNavigation";

const annotation = (
  id: string,
  startLine: number,
  overrides: Partial<TerminalActivitySnapshot> = {},
): TerminalCommandAnnotation => ({
  id,
  startLine,
  activity: {
    id,
    terminalId: "terminal",
    kind: "command",
    actor: "agent",
    origin: "agent-exec-command",
    status: "succeeded",
    revision: 1,
    startedAt: 1,
    updatedAt: 2,
    startOffset: 0,
    ...overrides,
  },
});

const ids = (annotations: readonly TerminalCommandAnnotation[]): string[] =>
  annotations.map(({ id }) => id);

assert.deepEqual(getNavigableTerminalAnnotations([]), []);
const overlapping = [
  annotation("old", 2, { command: "old command", status: "failed" }),
  annotation("last", 2, { command: "new command" }),
  annotation("first-row", 0),
  annotation("next-row", 3),
];
assert.deepEqual(ids(getNavigableTerminalAnnotations(overlapping)), [
  "first-row",
  "last",
  "next-row",
]);
assert.deepEqual(ids(filterTerminalCommands(overlapping, "", false)), [
  "next-row",
  "last",
  "first-row",
]);
assert.deepEqual(
  filterTerminalCommands(overlapping, "old", false),
  [],
  "search cannot resurrect overwritten boundaries",
);
assert.deepEqual(
  filterTerminalCommands(overlapping, "", true),
  [],
  "an overwritten failure must not navigate to the next command's row",
);
assert.deepEqual(
  overlapping.map(({ id }) => id),
  ["old", "last", "first-row", "next-row"],
  "input order must not be mutated",
);

assert.deepEqual(
  ids(
    getNavigableTerminalAnnotations([
      annotation("negative", -1),
      annotation("fraction-negative", -0.1),
      annotation("nan", Number.NaN),
      annotation("infinite", Number.POSITIVE_INFINITY),
      annotation("unsafe", Number.MAX_SAFE_INTEGER + 1),
      annotation("valid", 0),
    ]),
  ),
  ["valid"],
);
assert.equal(
  getNavigableTerminalAnnotations([annotation("fraction", 1.7)])[0].startLine,
  1,
);
assert.deepEqual(
  ids(
    getNavigableTerminalAnnotations([annotation("a", 1), annotation("b", 1.8)]),
  ),
  ["b"],
);

const records = [
  annotation("empty", 0, { actor: "user", origin: "interactive-shell" }),
  annotation("inspect", 1, {
    intent: "Inspect TEST output",
    command: "rg ERROR ./src",
  }),
  annotation("failed", 2, {
    status: "failed",
    exitCode: 1,
    command: "npm test",
  }),
  annotation("aborted", 3, { status: "aborted", command: "npm run watch" }),
  annotation("unknown", 4, { status: "outcome-unknown" }),
  annotation("running", 5, { status: "running", command: "npm run build" }),
];
assert.deepEqual(
  ids(filterTerminalCommands(records, "InSPECT\tErRoR", false)),
  ["inspect"],
  "tokens can match intent and command independently",
);
assert.deepEqual(ids(filterTerminalCommands(records, " npm   ", false)), [
  "running",
  "aborted",
  "failed",
]);
assert.deepEqual(
  ids(filterTerminalCommands(records, "./src", false)),
  ["inspect"],
  "shell punctuation remains literal",
);
assert.deepEqual(
  filterTerminalCommands(records, ".*", false),
  [],
  "search is substring matching, not regex",
);
assert.deepEqual(ids(filterTerminalCommands(records, "", true)), [
  "unknown",
  "aborted",
  "failed",
]);
assert.deepEqual(ids(filterTerminalCommands(records, "npm", true)), [
  "aborted",
  "failed",
]);
assert.equal(
  filterTerminalCommands(records, "", false).length,
  records.length,
  "manual shell boundaries remain available without command metadata",
);
assert.deepEqual(filterTerminalCommands([records[0]], "missing", false), []);
const manualPreview: TerminalCommandAnnotation = {
  ...annotation("manual-preview", 6, {
    actor: "user",
    origin: "interactive-shell",
  }),
  bufferPreview: "PS C:\\workspace> Get-ChildItem ./src",
};
assert.deepEqual(
  ids(filterTerminalCommands([manualPreview], "get-childitem ./src", false)),
  ["manual-preview"],
  "manual commands remain searchable through retained VT preview without command metadata",
);
assert.equal(manualPreview.activity.command, undefined);
assert.deepEqual(
  ids(
    filterTerminalCommands(
      [
        {
          ...manualPreview,
          activity: { ...manualPreview.activity, intent: "Inspect sources" },
        },
      ],
      "inspect get-childitem",
      false,
    ),
  ),
  ["manual-preview"],
  "tokens can span intent and retained VT preview",
);

const frozen = Object.freeze(records.map((record) => Object.freeze(record)));
assert.equal(filterTerminalCommands(frozen, "npm", false).length, 3);
assert.deepEqual(getTerminalCommandSearchHighlights("npm run test", ""), [
  { text: "npm run test", match: false },
]);
assert.deepEqual(
  getTerminalCommandSearchHighlights("Inspect TEST output", "test Inspect"),
  [
    { text: "Inspect", match: true },
    { text: " ", match: false },
    { text: "TEST", match: true },
    { text: " output", match: false },
  ],
);
assert.deepEqual(getTerminalCommandSearchHighlights("npm test", "npm npm"), [
  { text: "npm", match: true },
  { text: " test", match: false },
]);
assert.deepEqual(getTerminalCommandSearchHighlights("abcde", "abc bcd"), [
  { text: "abcd", match: true },
  { text: "e", match: false },
]);
assert.deepEqual(getTerminalCommandSearchHighlights("run .* ./src", ".*"), [
  { text: "run ", match: false },
  { text: ".*", match: true },
  { text: " ./src", match: false },
]);
const longCommandHighlight = getTerminalCommandSearchHighlights(
  `${"long/path/".repeat(25)}target.txt`,
  "target",
);
assert.equal(longCommandHighlight[0].text, "...");
assert.equal(
  longCommandHighlight.find((segment) => segment.match)?.text,
  "target",
);
assert.equal(longCommandHighlight[1].text.length, 12);
console.log(
  "PASS retained command navigation, last-row ownership, invalid boundaries, literal metadata search, missing command metadata, and issue filtering",
);
