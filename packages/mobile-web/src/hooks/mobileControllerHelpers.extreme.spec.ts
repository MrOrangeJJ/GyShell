import {
  countPendingApprovals,
  deriveSessionStatus,
  findFirstApprovalSession,
  normalizeAgentSettingState,
  normalizeBuiltInTool,
  readExperimentalToolConfirmationRequired,
  type SessionStatusInfo,
} from "./mobileControllerHelpers";
import { createSessionState } from "../session-store";
import type { ChatMessage } from "../types";

const assertEqual = <T>(actual: T, expected: T, message: string): void => {
  if (actual !== expected) {
    throw new Error(
      `${message}. expected=${String(expected)} actual=${String(actual)}`,
    );
  }
};

const assertDeepEqual = <T>(actual: T, expected: T, message: string): void => {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `${message}. expected=${JSON.stringify(expected)} actual=${JSON.stringify(actual)}`,
    );
  }
};

const assertCondition = (condition: unknown, message: string): void => {
  if (!condition) {
    throw new Error(message);
  }
};

const runCase = (name: string, fn: () => void): void => {
  fn();
  console.log(`PASS ${name}`);
};

function makeMessage(overrides: Partial<ChatMessage>): ChatMessage {
  return {
    id: overrides.id ?? "m1",
    role: overrides.role ?? "assistant",
    type: overrides.type ?? "text",
    content: overrides.content ?? "",
    timestamp: overrides.timestamp ?? 1,
    metadata: overrides.metadata,
    streaming: overrides.streaming,
    backendMessageId: overrides.backendMessageId,
  };
}

/* ---------------------------------------------------------------
 * deriveSessionStatus — the single most important signal in the
 * new SessionBrowser. Mobile users open the app to see "what's
 * happening now". The priority order must be: approval > error >
 * busy-phase > idle, and the function must never throw.
 * --------------------------------------------------------------- */

runCase("deriveSessionStatus: empty session => done", () => {
  const session = createSessionState("s1", "Empty");
  const status = deriveSessionStatus(session);
  assertEqual(status.kind, "done", "empty session status kind");
});

runCase("deriveSessionStatus: pending approval (ask no decision) wins over busy", () => {
  const session = createSessionState("s1", "Approval");
  session.isBusy = true;
  session.isThinking = true;
  session.messages.push(
    makeMessage({
      type: "ask",
      metadata: { toolName: "Bash" },
    }),
  );
  const status = deriveSessionStatus(session);
  assertEqual(status.kind, "approval", "approval wins priority");
  assertEqual(status.detail, "approval", "approval detail");
  assertEqual(status.contextName, "Bash", "approval carries tool name");
});

runCase("deriveSessionStatus: pending approval survives later inserted user message", () => {
  const session = createSessionState("s1", "Approval with insertion");
  session.isBusy = true;
  session.isThinking = true;
  session.messages.push(
    makeMessage({
      id: "ask-1",
      type: "ask",
      metadata: { toolName: "Bash" },
    }),
  );
  session.messages.push(
    makeMessage({
      id: "user-2",
      role: "user",
      type: "text",
      content: "Please continue after approval.",
      metadata: { inputKind: "inserted" },
    }),
  );
  const status = deriveSessionStatus(session);
  assertEqual(
    status.kind,
    "approval",
    "inserted follow-up must not hide pending approval",
  );
  assertEqual(
    countPendingApprovals({ s1: session }),
    1,
    "approval badge should still count this session",
  );
});

runCase("deriveSessionStatus: answered ask no longer counts as pending approval", () => {
  const session = createSessionState("s1", "Answered");
  session.messages.push(
    makeMessage({
      type: "ask",
      metadata: { decision: "allow", toolName: "Bash" },
    }),
  );
  const status = deriveSessionStatus(session);
  assertEqual(status.kind, "done", "answered ask -> done");
});

runCase("deriveSessionStatus: explicit deny resolves to done not approval", () => {
  const session = createSessionState("s1", "Denied");
  session.messages.push(
    makeMessage({
      type: "ask",
      metadata: { decision: "deny" },
    }),
  );
  const status = deriveSessionStatus(session);
  assertEqual(status.kind, "done", "denied ask -> done");
});

runCase("deriveSessionStatus: error message beats busy phase", () => {
  const session = createSessionState("s1", "Errored");
  session.isBusy = true;
  session.messages.push(makeMessage({ type: "error" }));
  const status = deriveSessionStatus(session);
  assertEqual(status.kind, "error", "error beats busy");
});

runCase("deriveSessionStatus: busy + reasoning => thinking", () => {
  const session = createSessionState("s1", "Thinking");
  session.isBusy = true;
  session.messages.push(
    makeMessage({ type: "reasoning", streaming: true }),
  );
  const status = deriveSessionStatus(session);
  assertEqual(status.kind, "thinking", "reasoning busy -> thinking");
});

runCase("deriveSessionStatus: busy + tool_call surfaces tool name", () => {
  const session = createSessionState("s1", "Tool");
  session.isBusy = true;
  session.messages.push(
    makeMessage({ type: "tool_call", metadata: { toolName: "Read" } }),
  );
  const status = deriveSessionStatus(session);
  assertEqual(status.kind, "tool", "tool_call -> tool kind");
  assertEqual(status.detail, "tool", "tool detail");
  assertEqual(status.contextName, "Read", "tool carries name");
});

runCase("deriveSessionStatus: nowait command flagged specially", () => {
  const session = createSessionState("s1", "Async");
  session.isBusy = true;
  session.messages.push(
    makeMessage({ type: "command", metadata: { isNowait: true } }),
  );
  const status = deriveSessionStatus(session);
  assertEqual(status.kind, "running", "nowait command -> running");
  assertEqual(status.detail, "command_async", "async command detail");
});

runCase("deriveSessionStatus: trailing tokens_count messages are ignored", () => {
  const session = createSessionState("s1", "Trailing");
  session.isBusy = false;
  session.messages.push(makeMessage({ type: "text", content: "done" }));
  // tokens_count appended after done should not change status
  session.messages.push(
    makeMessage({
      id: "tokens",
      type: "tokens_count",
      metadata: { totalTokens: 10, maxTokens: 100 },
    }),
  );
  const status = deriveSessionStatus(session);
  assertEqual(status.kind, "done", "trailing tokens_count ignored");
});

runCase("deriveSessionStatus: streaming text while busy => thinking/replying", () => {
  const session = createSessionState("s1", "Replying");
  session.isBusy = true;
  session.messages.push(
    makeMessage({ type: "text", streaming: true, content: "Hi" }),
  );
  const status = deriveSessionStatus(session);
  assertEqual(status.kind, "thinking", "streaming reply -> thinking");
  assertEqual(status.detail, "replying", "streaming reply detail");
});

runCase("deriveSessionStatus: never throws on malformed metadata", () => {
  const session = createSessionState("s1", "Malformed");
  // @ts-expect-error deliberately malformed
  session.messages.push(makeMessage({ metadata: "broken" }));
  const status = deriveSessionStatus(session);
  assertEqual(status.kind, "done", "malformed metadata does not crash");
});

/* ---------------------------------------------------------------
 * countPendingApprovals — drives the global approval badge.
 * --------------------------------------------------------------- */

runCase("countPendingApprovals: counts only pending asks across sessions", () => {
  const sessions: Record<string, ReturnType<typeof createSessionState>> = {
    s1: createSessionState("s1", "A"),
    s2: createSessionState("s2", "B"),
    s3: createSessionState("s3", "C"),
  };
  sessions.s1.messages.push(makeMessage({ type: "ask" }));
  sessions.s2.messages.push(
    makeMessage({ type: "ask", metadata: { decision: "allow" } }),
  );
  sessions.s3.messages.push(
    makeMessage({ type: "ask", metadata: { toolName: "Edit" } }),
  );
  const count = countPendingApprovals(sessions);
  assertEqual(count, 2, "should count s1 and s3 only");
});

runCase("countPendingApprovals: empty sessions map => 0", () => {
  assertEqual(countPendingApprovals({}), 0, "empty map returns 0");
});

/* ---------------------------------------------------------------
 * findFirstApprovalSession — must respect sessionOrder (most recent first).
 * --------------------------------------------------------------- */

runCase("findFirstApprovalSession: returns first in sessionOrder", () => {
  const sessions = {
    s1: (() => {
      const s = createSessionState("s1", "A");
      s.messages.push(makeMessage({ type: "ask" }));
      return s;
    })(),
    s2: createSessionState("s2", "B"),
  };
  // sessionOrder says s2 (newest) first, but s2 has no approval; should return s1
  const id = findFirstApprovalSession(
    ["s2", "s1"],
    { s1: { id: "s1", title: "A", updatedAt: 1, messagesCount: 1, loaded: true }, s2: { id: "s2", title: "B", updatedAt: 2, messagesCount: 0, loaded: true } },
    sessions,
  );
  assertEqual(id, "s1", "should skip s2 and return s1");
});

runCase("findFirstApprovalSession: returns null when none pending", () => {
  const id = findFirstApprovalSession(["s1"], {}, {});
  assertEqual(id, null, "no sessions => null");
});

/* ---------------------------------------------------------------
 * normalizeAgentSettingState — robust against malformed payloads.
 * --------------------------------------------------------------- */

runCase("normalizeAgentSettingState: returns empty on null/undefined", () => {
  assertDeepEqual(
    normalizeAgentSettingState(null),
    { profiles: [], activeProfileId: null },
    "null payload",
  );
  assertDeepEqual(
    normalizeAgentSettingState(undefined),
    { profiles: [], activeProfileId: null },
    "undefined payload",
  );
  assertDeepEqual(
    normalizeAgentSettingState("string"),
    { profiles: [], activeProfileId: null },
    "non-object payload",
  );
});

runCase("normalizeAgentSettingState: skips profiles with bad slot numbers", () => {
  const raw = {
    profiles: [
      { id: "p1", slotNumber: 1, createdAt: 1, updatedAt: 2 },
      { id: "p2", slotNumber: 9, createdAt: 1, updatedAt: 2 }, // invalid slot
      { id: "p3", slotNumber: 0, createdAt: 1, updatedAt: 2 }, // invalid slot
      { id: "", slotNumber: 2, createdAt: 1, updatedAt: 2 }, // missing id
      { id: "p6", slotNumber: 6, createdAt: 1, updatedAt: 2 },
    ],
    activeProfileId: "p6",
  };
  const state = normalizeAgentSettingState(raw);
  assertEqual(state.profiles.length, 2, "only valid profiles retained");
  assertEqual(state.profiles[0].id, "p1", "sorted by slot ascending");
  assertEqual(state.profiles[1].id, "p6", "second valid profile");
  assertEqual(state.activeProfileId, "p6", "activeProfileId preserved");
});

runCase("normalizeAgentSettingState: extracts nested snapshot model + policy", () => {
  const raw = {
    profiles: [
      {
        id: "p1",
        slotNumber: 1,
        createdAt: 1,
        updatedAt: 2,
        snapshot: {
          model: { activeProfileId: "gpt-4", activeProfileName: "GPT-4" },
          security: { commandPolicyMode: "safe" },
          tools: {
            builtIn: {
              create_terminal_tab: true,
              close_terminal_tab: false,
              malformed: "yes",
            },
          },
        },
      },
    ],
    activeProfileId: "p1",
  };
  const state = normalizeAgentSettingState(raw);
  assertEqual(state.profiles[0].modelName, "GPT-4", "model name extracted");
  assertEqual(
    state.profiles[0].modelProfileId,
    "gpt-4",
    "model profile id extracted",
  );
  assertEqual(
    state.profiles[0].commandPolicyMode,
    "safe",
    "policy mode extracted",
  );
});

runCase("normalizeBuiltInTool: preserves experimental metadata", () => {
  assertDeepEqual(
    normalizeBuiltInTool({
      name: "create_terminal_tab",
      description: "Create a terminal",
      enabled: false,
      experimental: true,
    }),
    {
      name: "create_terminal_tab",
      description: "Create a terminal",
      enabled: false,
      experimental: true,
    },
    "mobile tools UI needs experimental metadata before enabling",
  );
});

runCase("experimental confirmation challenge: accepts only valid tool names", () => {
  assertDeepEqual(
    readExperimentalToolConfirmationRequired({
      kind: "experimental_tool_confirmation_required",
      experimentalToolNames: ["close_terminal_tab", 42, "close_terminal_tab"],
    }),
    ["close_terminal_tab"],
    "mobile profile apply should recognize the backend confirmation challenge",
  );
  assertDeepEqual(
    readExperimentalToolConfirmationRequired({
      kind: "unrelated",
      experimentalToolNames: ["close_terminal_tab"],
    }),
    null,
    "unrelated payloads must not be treated as confirmation challenges",
  );
});

runCase("normalizeAgentSettingState: invalid commandPolicyMode => undefined", () => {
  const raw = {
    profiles: [
      {
        id: "p1",
        slotNumber: 1,
        createdAt: 1,
        updatedAt: 2,
        snapshot: { security: { commandPolicyMode: "yolo" } },
      },
    ],
    activeProfileId: "p1",
  };
  const state = normalizeAgentSettingState(raw);
  assertEqual(
    state.profiles[0].commandPolicyMode,
    undefined,
    "invalid policy dropped",
  );
});

runCase("normalizeAgentSettingState: handles missing snapshot gracefully", () => {
  const raw = {
    profiles: [{ id: "p1", slotNumber: 1, createdAt: 1, updatedAt: 2 }],
    activeProfileId: "p1",
  };
  const state = normalizeAgentSettingState(raw);
  assertEqual(state.profiles[0].modelName, undefined, "no model name");
  assertEqual(
    state.profiles[0].commandPolicyMode,
    undefined,
    "no policy mode",
  );
});

/* ---------------------------------------------------------------
 * Edge cases for the helper as a whole — types of status returned.
 * --------------------------------------------------------------- */

runCase("all session status kinds form a closed set", () => {
  const validKinds: SessionStatusInfo["kind"][] = [
    "approval",
    "error",
    "thinking",
    "tool",
    "running",
    "done",
  ];
  // sanity: ensure each kind is reachable through deriveSessionStatus
  const seen = new Set<SessionStatusInfo["kind"]>();
  const cases: Array<{ setup: () => ReturnType<typeof createSessionState> }> = [
    {
      setup: () => {
        const s = createSessionState("x", "approval");
        s.messages.push(makeMessage({ type: "ask" }));
        return s;
      },
    },
    {
      setup: () => {
        const s = createSessionState("x", "error");
        s.messages.push(makeMessage({ type: "error" }));
        return s;
      },
    },
    {
      setup: () => {
        const s = createSessionState("x", "thinking");
        s.isBusy = true;
        s.messages.push(makeMessage({ type: "reasoning", streaming: true }));
        return s;
      },
    },
    {
      setup: () => {
        const s = createSessionState("x", "tool");
        s.isBusy = true;
        s.messages.push(makeMessage({ type: "tool_call" }));
        return s;
      },
    },
    {
      setup: () => {
        const s = createSessionState("x", "running");
        s.isBusy = true;
        s.messages.push(makeMessage({ type: "command" }));
        return s;
      },
    },
    {
      setup: () => createSessionState("x", "done"),
    },
  ];
  for (const c of cases) {
    seen.add(deriveSessionStatus(c.setup()).kind);
  }
  for (const kind of validKinds) {
    assertCondition(seen.has(kind), `kind ${kind} not exercised`);
  }
});

console.log("\nAll mobileControllerHelpers extreme tests passed.");
