import assert from "node:assert/strict";
import type { TerminalActivitySnapshot } from "@gyshell/shared";
import {
  createTerminalActivityRuntime,
  type TerminalActivityRuntime,
} from "./terminalActivityRuntime";

const activity = (
  id: string,
  revision: number,
  status: TerminalActivitySnapshot["status"],
): TerminalActivitySnapshot => ({
  id,
  terminalId: "terminal-1",
  kind: "command",
  actor: "agent",
  origin: "agent-exec-command",
  status,
  revision,
  startedAt: 1,
  updatedAt: revision,
  startOffset: 0,
  ...(status !== "running" ? { endedAt: revision, endOffset: 4 } : {}),
});

const scheduled: string[] = [];
const cleared: string[] = [];
let listener: ((event: { activity: TerminalActivitySnapshot }) => void) | undefined;
const runtime: TerminalActivityRuntime = {
  terminalId: "terminal-1",
  scheduleActivityMarker: (entry, edge) => scheduled.push(`${entry.id}:${edge}`),
  clearActivityMarker: (id) => cleared.push(id),
};

const activityRuntime = createTerminalActivityRuntime(runtime, (next) => {
  listener = next;
  return () => {
    listener = undefined;
  };
});

listener?.({ activity: activity("activity-1", 2, "succeeded") });
assert.equal(runtime.recoveryMetadata?.activities[0]?.status, "succeeded");
assert.ok(scheduled.includes("activity-1:start"));
assert.ok(scheduled.includes("activity-1:end"));

// A delayed initial RPC must not overwrite a newer event received while the
// retained terminal had no React host.
activityRuntime.recover({
  activities: [activity("activity-1", 1, "running")],
  sessionBoundaries: [
    { id: "boundary-1", terminalId: "terminal-1", resumedAt: 3, offset: 4 },
  ],
});
assert.equal(runtime.recoveryMetadata?.activities[0]?.revision, 2);
assert.equal(runtime.recoveryMetadata?.sessionBoundaries[0]?.id, "boundary-1");
assert.deepEqual(cleared, []);

activityRuntime.dispose();
listener?.({ activity: activity("activity-2", 1, "running") });
assert.equal(
  runtime.recoveryMetadata?.activities.some((entry) => entry.id === "activity-2"),
  false,
  "disposed retained runtimes must stop receiving activity events",
);

console.log("terminal activity runtime remount cases: ok");
