import assert from "node:assert/strict";
import type { TerminalActivitySnapshot } from "@gyshell/shared";
import {
  formatTerminalActivityDuration,
  getTerminalActivityCommandPreview,
  mergeTerminalActivities,
  selectTerminalActivityContext,
} from "./terminalActivityModel";

const activity = (
  id: string,
  revision: number,
  updatedAt: number,
  startedAt = updatedAt,
): TerminalActivitySnapshot => ({
  id,
  terminalId: "terminal-a",
  kind: "command",
  actor: "agent",
  origin: "agent-exec-command",
  status: revision > 1 ? "succeeded" : "running",
  revision,
  startedAt,
  updatedAt,
  startOffset: 0,
});

const merged = mergeTerminalActivities(
  [activity("a", 2, 20, 10)],
  [activity("a", 1, 30, 10), activity("b", 1, 15, 15)],
);
assert.deepEqual(
  merged.map((entry) => entry.id),
  ["a", "b"],
);
assert.equal(
  merged[0]?.revision,
  2,
  "stale events must not replace newer state",
);

assert.equal(
  formatTerminalActivityDuration({ ...activity("c", 1, 0), startedAt: 0 }, 950),
  "950ms",
);
assert.equal(
  formatTerminalActivityDuration(
    { ...activity("c", 1, 0), startedAt: 0 },
    61_000,
  ),
  "1m 1s",
);
assert.equal(
  getTerminalActivityCommandPreview({
    ...activity("d", 1, 0),
    command: "npm   test\n-- --runInBand",
  }),
  "npm test -- --runInBand",
);

assert.equal(selectTerminalActivityContext([]), undefined);
const running = activity("running", 1, 1);
const completed = activity("done", 2, 2);
assert.equal(
  selectTerminalActivityContext([running, completed])?.id,
  "running",
);
assert.equal(selectTerminalActivityContext([completed])?.id, "done");
assert.equal(
  selectTerminalActivityContext([running, activity("new-running", 1, 3)])?.id,
  "new-running",
);
assert.equal(
  selectTerminalActivityContext([{ ...completed, status: "outcome-unknown" }])
    ?.status,
  "outcome-unknown",
);

console.log("terminal activity presentation extreme cases: ok");
