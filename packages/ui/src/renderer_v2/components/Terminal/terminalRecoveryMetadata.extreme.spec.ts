import assert from "node:assert/strict";
import {
  loadTerminalRecoveryMetadata,
  type TerminalRecoveryMetadataApi,
} from "./terminalRecoveryMetadata";

const runCase = async (
  name: string,
  fn: () => Promise<void>,
): Promise<void> => {
  await fn();
  console.log(`PASS ${name}`);
};

const run = async (): Promise<void> => {
  await runCase("recovery metadata loads both stores", async () => {
    const api: TerminalRecoveryMetadataApi = {
      getSessionBoundaries: async () => ({
        boundaries: [
          {
            id: "boundary-1",
            terminalId: "terminal-1",
            resumedAt: 1,
            offset: 10,
          },
        ],
      }),
      getActivities: async () => ({
        activities: [
          {
            id: "activity-1",
            terminalId: "terminal-1",
            kind: "command",
            actor: "user",
            origin: "interactive-shell",
            status: "succeeded",
            revision: 1,
            startedAt: 1,
            updatedAt: 2,
            endedAt: 2,
            startOffset: 2,
            endOffset: 8,
          },
        ],
      }),
    };

    const metadata = await loadTerminalRecoveryMetadata(api, "terminal-1");
    assert.equal(metadata.sessionBoundaries.length, 1);
    assert.equal(metadata.activities.length, 1);
  });

  await runCase(
    "a failed metadata store does not block the other store",
    async () => {
      const api: TerminalRecoveryMetadataApi = {
        getSessionBoundaries: async () => {
          throw new Error("boundaries unavailable");
        },
        getActivities: async () => ({
          activities: [
            {
              id: "activity-2",
              terminalId: "terminal-2",
              kind: "command",
              actor: "agent",
              origin: "agent-exec-command",
              status: "running",
              revision: 1,
              startedAt: 3,
              updatedAt: 3,
              startOffset: 4,
            },
          ],
        }),
      };

      const metadata = await loadTerminalRecoveryMetadata(api, "terminal-2");
      assert.deepEqual(metadata.sessionBoundaries, []);
      assert.equal(metadata.activities[0]?.id, "activity-2");
    },
  );

  await runCase(
    "missing recovery metadata APIs degrade to empty metadata",
    async () => {
      const metadata = await loadTerminalRecoveryMetadata(
        {},
        "terminal-without-metadata-api",
      );
      assert.deepEqual(metadata, {
        activities: [],
        sessionBoundaries: [],
      });
    },
  );

  await runCase("synchronous metadata failures degrade to empty metadata", async () => {
    const metadata = await loadTerminalRecoveryMetadata(
      {
        getSessionBoundaries: () => {
          throw new Error("legacy bridge failure");
        },
        getActivities: () => {
          throw new Error("legacy bridge failure");
        },
      },
      "terminal-with-sync-failure",
    );
    assert.deepEqual(metadata, {
      activities: [],
      sessionBoundaries: [],
    });
  });
};

void run().catch((error) => {
  console.error(error);
  process.exit(1);
});
