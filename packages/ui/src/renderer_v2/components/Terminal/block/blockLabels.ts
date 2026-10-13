import type { TerminalActivitySnapshot } from "@gyshell/shared";

/** Localized strings for the Block view and the Classic command marks. */
export interface TerminalBlockLabels {
  title: string;
  output: string;
  alternate: string;
  follow: string;
  newOutput: (count: number) => string;
  details: string;
  command: string;
  started: string;
  ended: string;
  duration: string;
  session: string;
  exitCode: (code: number) => string;
  copyOutput: string;
  copyCommand: string;
  copied: string;
  close: string;
  agent: string;
  user: string;
  running: string;
  unknown: string;
  succeeded: string;
  failed: string;
  aborted: string;
  lastCommand: string;
  openBlock: string;
  outputUnavailable: string;
  showInTerminal: string;
  hiddenRows: (count: number) => string;
  hiddenRowsInTerminal: (count: number) => string;
  outputRows: (count: number) => string;
  noOutput: string;
  emptyTitle: string;
  emptyDescription: string;
  emptyConnecting: string;
  emptyDisconnected: string;
  blockHint: string;
}

type StatusLabels = Pick<
  TerminalBlockLabels,
  "running" | "succeeded" | "failed" | "aborted" | "unknown"
>;

/** Also used by the command navigator, whose labels carry the same keys. */
export const blockStatusLabel = (
  status: TerminalActivitySnapshot["status"],
  labels: StatusLabels,
): string => {
  switch (status) {
    case "running":
      return labels.running;
    case "succeeded":
      return labels.succeeded;
    case "failed":
      return labels.failed;
    case "aborted":
      return labels.aborted;
    default:
      return labels.unknown;
  }
};

/** Short status text: exit code when known, otherwise the status label. */
export const blockStatusText = (
  activity: TerminalActivitySnapshot,
  labels: TerminalBlockLabels,
): string =>
  activity.status === "running" || activity.status === "outcome-unknown"
    ? blockStatusLabel(activity.status, labels)
    : activity.exitCode !== undefined
      ? labels.exitCode(activity.exitCode)
      : blockStatusLabel(activity.status, labels);
