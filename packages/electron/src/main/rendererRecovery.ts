export type RendererRecoveryReason =
  | "crashed"
  | "killed"
  | "oom"
  | "unresponsive"
  | "child-process-gone"
  | "load-failure";

export interface RendererRecoveryDecision {
  action: "reload" | "recreate" | "safe-mode" | "ignore";
  safeMode: boolean;
  attempt: number;
  reason: RendererRecoveryReason;
}

export interface RendererRecoveryPolicyOptions {
  now?: number;
  maxAutomaticAttempts?: number;
  recentFailureWindowMs?: number;
  lastFailureAt?: number;
  attempts?: number;
}

export const decideRendererRecovery = (
  reason: RendererRecoveryReason,
  options: RendererRecoveryPolicyOptions = {},
): RendererRecoveryDecision => {
  const now = options.now ?? Date.now();
  const maxAutomaticAttempts = Math.max(
    1,
    Math.floor(options.maxAutomaticAttempts ?? 1),
  );
  const recentFailureWindowMs = Math.max(
    1_000,
    Math.floor(options.recentFailureWindowMs ?? 60_000),
  );
  const previousAttempts =
    options.lastFailureAt !== undefined &&
    now - options.lastFailureAt <= recentFailureWindowMs
      ? Math.max(0, Math.floor(options.attempts ?? 0))
      : 0;
  const attempt = previousAttempts + 1;
  if (attempt <= maxAutomaticAttempts) {
    return {
      action: "reload",
      safeMode: false,
      attempt,
      reason,
    };
  }
  return {
    action: "safe-mode",
    safeMode: true,
    attempt,
    reason,
  };
};

export const normalizeRendererRecoveryReason = (
  value: unknown,
): RendererRecoveryReason => {
  switch (String(value || "").toLowerCase()) {
    case "killed":
      return "killed";
    case "oom":
      return "oom";
    case "unresponsive":
      return "unresponsive";
    case "child-process-gone":
      return "child-process-gone";
    case "load-failure":
      return "load-failure";
    default:
      return "crashed";
  }
};

export const isRendererTerminalFailure = (reason: string): boolean =>
  ["crashed", "killed", "oom", "child-process-gone"].includes(
    String(reason || "").toLowerCase(),
  );

export const shouldRecoverWindowsForChildProcess = (details: {
  type?: unknown;
  reason?: unknown;
}): boolean => {
  if (String(details.type || "").toLowerCase() !== "gpu") return false;
  return [
    "abnormal-exit",
    "killed",
    "crashed",
    "oom",
    "launch-failed",
    "integrity-failure",
    "memory-eviction",
  ].includes(String(details.reason || "").toLowerCase());
};
