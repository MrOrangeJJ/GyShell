import { UIHistoryService } from "./UIHistoryService";

function assertEqual<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) {
    throw new Error(
      `${message}. expected=${String(expected)} actual=${String(actual)}`,
    );
  }
}

const sessions = new Map<string, any>();
const store = {
  listUiSessionSummaries: () => [],
  listUiSessions: () => [...sessions.values()],
  loadUiSession: (sessionId: string) => sessions.get(sessionId) || null,
  saveUiSessions: (
    entries: Array<{ session: { id: string }; summary: unknown }>,
  ) => {
    entries.forEach((entry) => sessions.set(entry.session.id, entry.session));
  },
  deleteUiSessions: () => {},
} as any;

const history = new UIHistoryService({ store });
history.recordEvent("session-1", {
  type: "command_ask",
  messageId: "message-1",
  approvalId: "approval-1",
  command: "git push",
} as any);

const action = history.recordFeedbackDecision("approval-1", "allow");
assertEqual(action?.type, "UPDATE_MESSAGE", "feedback should emit an update");
assertEqual(
  action?.type === "UPDATE_MESSAGE"
    ? action.patch.metadata?.decision
    : undefined,
  "allow",
  "feedback update should carry the decision",
);
assertEqual(
  history
    .getSession("session-1")
    ?.messages.some((message) => message.type === "ask"),
  false,
  "resolved transient asks should not reappear after history flush",
);
assertEqual(
  history.recordFeedbackDecision("approval-1", "allow"),
  null,
  "repeating the same decision should be idempotent",
);

history.recordEvent("session-2", {
  type: "command_ask",
  messageId: "message-2",
  approvalId: "approval-2",
  command: "rm file",
} as any);
const uiMessageId = history.getSession("session-2")?.messages[0]?.id || "";
assertEqual(
  history.recordFeedbackDecision(uiMessageId, "deny"),
  null,
  "UI message ids must not masquerade as backend feedback ids",
);
assertEqual(
  history.getSession("session-2")?.messages[0]?.metadata?.decision,
  undefined,
  "invalid feedback ids must leave the approval pending",
);

console.log("PASS UI history feedback decisions resolve and remain idempotent");
