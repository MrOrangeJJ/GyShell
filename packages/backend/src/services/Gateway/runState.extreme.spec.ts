import { GatewayService } from "./GatewayService";
import type { StartTaskInput, StartTaskMode } from "./types";

const assertEqual = <T>(actual: T, expected: T, message: string): void => {
  if (actual !== expected) {
    throw new Error(
      `${message}. expected=${String(expected)} actual=${String(actual)}`,
    );
  }
};

const runCase = async (
  name: string,
  fn: () => Promise<void> | void,
): Promise<void> => {
  await fn();
  console.log(`PASS ${name}`);
};

class FakeAgentRuntime {
  renamedSessions: Array<{ sessionId: string; title: string }> = [];
  deleteError: Error | null = null;

  onRun:
    | ((
        context: unknown,
        input: StartTaskInput,
        signal: AbortSignal,
        startMode: StartTaskMode,
      ) => Promise<void> | void)
    | null = null;

  setEventPublisher(): void {}

  setFeedbackWaiter(): void {}

  setQueuedInsertionProvider(): void {}

  setQueuedInsertionAcknowledger(): void {}

  setQueuedInsertionAvailabilityWaiter(): void {}

  setQueuedInsertionEnqueuer(): void {}

  setBackgroundExecCommandRegistrar(): void {}

  setBackgroundExecCommandCompleter(): void {}

  setUnfinishedBackgroundExecCommandProvider(): void {}

  async run(
    context: unknown,
    input: StartTaskInput,
    signal: AbortSignal,
    startMode: StartTaskMode = "normal",
  ): Promise<void> {
    await this.onRun?.(context, input, signal, startMode);
  }

  isAbortError(error: unknown): boolean {
    return error instanceof Error && error.name === "AbortError";
  }

  releaseSessionModelBinding(): void {}

  listStoredChatSessions(): any[] {
    return [];
  }

  listStoredChatSessionSummaries(): any[] {
    return [];
  }

  loadChatSession(): null {
    return null;
  }

  deleteChatSession(): void {
    if (this.deleteError) throw this.deleteError;
  }

  deleteChatSessions(): void {
    if (this.deleteError) throw this.deleteError;
  }

  renameChatSession(sessionId: string, title: string): void {
    this.renamedSessions.push({ sessionId, title });
  }

  exportChatSession(): null {
    return null;
  }

  rollbackToMessage(): { ok: boolean; removedCount: number } {
    return { ok: false, removedCount: 0 };
  }

  branchFromMessage(): { ok: boolean } {
    return { ok: false };
  }
}

class FakeUIHistoryService {
  recordEvent(): any[] {
    return [];
  }

  flush(): void {}

  getAllSessionSummaries(): any[] {
    return [];
  }

  getSession(): null {
    return null;
  }
}

const createGateway = (): {
  gateway: GatewayService;
  agent: FakeAgentRuntime;
} => {
  const agent = new FakeAgentRuntime();
  const gateway = new GatewayService(
    {
      setRawEventPublisher: () => {},
      getAllTerminals: () => [],
    } as any,
    agent as any,
    new FakeUIHistoryService() as any,
    {
      setFeedbackWaiter: () => {},
    } as any,
    {
      getSettings: () =>
        ({
          models: {
            activeProfileId: "profile-1",
          },
        }) as any,
    } as any,
    {
      on: () => ({}),
    } as any,
  );
  return { gateway, agent };
};

const run = async (): Promise<void> => {
  await runCase("run-state listener tracks dispatch completion", async () => {
    const { gateway, agent } = createGateway();
    const activeCounts: number[] = [];

    gateway.onRunStateChanged((snapshot) => {
      activeCounts.push(snapshot.activeCount);
    });

    agent.onRun = async () => {};
    await gateway.dispatchTask("session-1", "hello");

    assertEqual(
      activeCounts.join(","),
      "0,1,0",
      "listener should see idle, running, idle",
    );
  });

  await runCase("run-state listener tracks manual stop", async () => {
    const { gateway, agent } = createGateway();
    const activeCounts: number[] = [];

    gateway.onRunStateChanged((snapshot) => {
      activeCounts.push(snapshot.activeCount);
    });
    agent.onRun = async (_context, _input, signal) => {
      await new Promise<void>((_resolve, reject) => {
        signal.addEventListener(
          "abort",
          () => {
            const error = new Error("AbortError");
            error.name = "AbortError";
            reject(error);
          },
          { once: true },
        );
      });
    };

    const task = gateway.dispatchTask("session-1", "hello");
    await Promise.resolve();
    await gateway.stopTask("session-1");
    await task;

    assertEqual(
      activeCounts.join(","),
      "0,1,0",
      "manual stop should release the active run state",
    );
  });

  await runCase("session rename broadcasts a UI update to every client", () => {
    const { gateway, agent } = createGateway();
    const updates: any[] = [];
    gateway.registerTransport({
      id: "rename-observer",
      type: "other",
      send: () => {},
      emitEvent: () => {},
      sendUIUpdate: (action) => updates.push(action),
    });
    gateway.registerSession("session-1", "window-a");
    gateway.registerSession("session-1", "window-b");
    gateway.unregisterSession("session-1", "window-a");

    gateway.renameSession("session-1", "Renamed Chat");

    assertEqual(
      JSON.stringify(agent.renamedSessions),
      JSON.stringify([{ sessionId: "session-1", title: "Renamed Chat" }]),
      "rename should persist through the agent runtime",
    );
    assertEqual(
      JSON.stringify(updates),
      JSON.stringify([
        {
          type: "SESSION_RENAMED",
          sessionId: "session-1",
          title: "Renamed Chat",
          uiRevision: 1,
        },
      ]),
      "rename should fan out through the canonical UI update transport",
    );
  });

  await runCase("renderer owner cleanup releases empty sessions", () => {
    const { gateway } = createGateway();
    gateway.registerSession("session-owner-cleanup", "window-a");
    gateway.unregisterSessionOwner("window-a");

    let renameRejected = false;
    try {
      gateway.renameSession("session-owner-cleanup", "Must not persist");
    } catch {
      renameRejected = true;
    }

    assertEqual(
      renameRejected,
      true,
      "an empty session should stop being renameable after its last renderer owner exits",
    );
  });

  await runCase("deleted sessions reject delayed rename resurrection", async () => {
    const { gateway, agent } = createGateway();
    gateway.registerSession("session-deleted");
    await gateway.deleteChatSession("session-deleted");

    let registerRejected = false;
    let renameRejected = false;
    let dispatchRejected = false;
    try {
      gateway.registerSession("session-deleted");
    } catch {
      registerRejected = true;
    }
    try {
      gateway.renameSession("session-deleted", "Must not return");
    } catch {
      renameRejected = true;
    }
    try {
      await gateway.dispatchTask("session-deleted", "Must not run");
    } catch {
      dispatchRejected = true;
    }

    assertEqual(
      registerRejected,
      true,
      "deleted ids should remain tombstoned for this gateway lifetime",
    );
    assertEqual(
      renameRejected,
      true,
      "a delayed rename must not recreate deleted history rows",
    );
    assertEqual(
      dispatchRejected,
      true,
      "a delayed task dispatch must not recreate a deleted session",
    );
    assertEqual(
      gateway.getSession("session-deleted"),
      undefined,
      "rejected dispatch must not recreate a runtime context",
    );
    assertEqual(
      agent.renamedSessions.length,
      0,
      "rejected rename must not reach persistence",
    );
  });

  await runCase("session deletion tombstones before waiting for stop", async () => {
    const { gateway } = createGateway();
    let releaseStop: () => void = () => {};
    gateway.stopTask = async () => {
      await new Promise<void>((resolve) => {
        releaseStop = resolve;
      });
    };

    const deletion = gateway.deleteChatSession("session-deleting");
    await Promise.resolve();

    let dispatchRejected = false;
    try {
      await gateway.dispatchTask("session-deleting", "Must not race delete");
    } catch {
      dispatchRejected = true;
    }

    assertEqual(
      dispatchRejected,
      true,
      "dispatch should reject as soon as deletion begins",
    );
    releaseStop();
    await deletion;
  });

  await runCase("failed persistence deletion rolls back the tombstone", async () => {
    const { gateway, agent } = createGateway();
    agent.deleteError = new Error("storage unavailable");

    let deletionRejected = false;
    try {
      await gateway.deleteChatSession("session-delete-failed");
    } catch {
      deletionRejected = true;
    }
    assertEqual(deletionRejected, true, "storage deletion errors should surface");

    agent.deleteError = null;
    await gateway.dispatchTask("session-delete-failed", "Recovery run");
    assertEqual(
      gateway.getSession("session-delete-failed")?.sessionId,
      "session-delete-failed",
      "failed deletion must not strand the retained UI session behind a tombstone",
    );
  });
};

run()
  .then(() => {
    console.log("All Gateway run-state extreme tests passed.");
  })
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
