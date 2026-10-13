import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { TERMINAL_ACTIVITY_COMMAND_PREVIEW_MAX_UTF8_BYTES } from "@gyshell/shared";
import { TerminalActivityStore } from "./TerminalActivityStore";

const changes: string[] = [];
const store = new TerminalActivityStore(
  (activity) => changes.push(`${activity.id}:${activity.revision}`),
  2,
);

const started = store.start({
  id: "agent-1",
  terminalId: "terminal-a",
  actor: "agent",
  origin: "agent-exec-command",
  command: "printf first",
  startedAt: 10,
  startOffset: 4,
  runtimeGeneration: 7,
  sessionId: "session-1",
  messageId: "message-1",
  intent: "  inspect\tterminal\nstate  ",
});
assert.equal(started.status, "running");
assert.equal(started.revision, 1);
assert.equal(started.intent, "inspect terminal state");

const finished = store.finish({
  terminalId: "terminal-a",
  activityId: "agent-1",
  status: "succeeded",
  endedAt: 20,
  endOffset: 18,
  exitCode: 0,
});
assert.equal(finished?.status, "succeeded");
assert.equal(finished?.revision, 2);
assert.equal(finished?.exitCode, 0);

store.start({
  id: "manual-1",
  terminalId: "terminal-a",
  actor: "user",
  origin: "interactive-shell",
  startedAt: 30,
  startOffset: 20,
});
store.start({
  id: "agent-2",
  terminalId: "terminal-a",
  actor: "agent",
  origin: "agent-exec-command",
  command: "printf second",
  startedAt: 40,
  startOffset: 30,
});

assert.deepEqual(
  store.list("terminal-a").map((activity) => activity.id),
  ["manual-1", "agent-2"],
  "retention should evict the oldest completed activity before active ones",
);

const oversizedCommand = "界".repeat(
  TERMINAL_ACTIVITY_COMMAND_PREVIEW_MAX_UTF8_BYTES,
);
const bounded = store.start({
  id: "agent-large",
  terminalId: "terminal-b",
  actor: "agent",
  origin: "agent-exec-command",
  command: oversizedCommand,
  startedAt: 50,
  startOffset: 0,
});
assert.ok(bounded.command?.endsWith("… [truncated]"));
assert.ok(
  Buffer.byteLength(bounded.command || "", "utf8") <=
    TERMINAL_ACTIVITY_COMMAND_PREVIEW_MAX_UTF8_BYTES,
);

const boundedIntent = store.start({
  id: "agent-intent-limit",
  terminalId: "terminal-b",
  actor: "agent",
  origin: "agent-exec-command",
  command: "printf intent",
  intent: "x".repeat(80),
  startedAt: 55,
  startOffset: 1,
});
assert.equal(boundedIntent.intent?.length, 40);

const duplicate = store.start({
  id: "agent-large",
  terminalId: "terminal-b",
  actor: "user",
  origin: "interactive-shell",
  startedAt: 60,
  startOffset: 100,
});
assert.equal(duplicate.actor, "agent");
assert.deepEqual(changes.slice(0, 2), ["agent-1:1", "agent-1:2"]);

store.clearTerminal("terminal-b");
assert.deepEqual(store.list("terminal-b"), []);
assert.equal(store.get("agent-large"), undefined);

console.log("terminal activity store extreme cases: ok");
