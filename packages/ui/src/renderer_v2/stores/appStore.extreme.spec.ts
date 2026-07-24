import { isObservable, isObservableArray } from "mobx";
import { AppStore } from "./AppStore";
import { ChatStore } from "./ChatStore";
import type { LayoutTree } from "../layout";
import {
  WINDOW_CONTEXT,
  readDetachedWindowState,
  stashDetachedWindowState,
} from "../lib/windowing";
import type { FileTransferTaskSnapshot } from "../lib/ipcTypes";

const assertCondition = (condition: unknown, message: string): void => {
  if (!condition) {
    throw new Error(message);
  }
};

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

const createStorage = (state: Map<string, string>) => ({
  getItem(key: string) {
    return state.has(key) ? state.get(key)! : null;
  },
  setItem(key: string, value: string) {
    state.set(key, value);
  },
  removeItem(key: string) {
    state.delete(key);
  },
});

const buildPersistedTree = (options?: {
  focusedPanelId?: string;
}): LayoutTree => ({
  schemaVersion: 2,
  root: {
    type: "split",
    id: "root",
    direction: "horizontal",
    children: [
      {
        type: "panel",
        id: "node-chat-a",
        panel: { id: "panel-chat-a", kind: "chat" },
      },
      {
        type: "panel",
        id: "node-chat-b",
        panel: { id: "panel-chat-b", kind: "chat" },
      },
      {
        type: "panel",
        id: "node-terminal",
        panel: { id: "panel-terminal", kind: "terminal" },
      },
    ],
    sizes: [34, 33, 33],
  },
  focusedPanelId: options?.focusedPanelId || "panel-chat-b",
  panelTabs: {
    "panel-chat-a": {
      tabIds: ["chat-a"],
      activeTabId: "chat-a",
    },
    "panel-chat-b": {
      tabIds: ["chat-b", "chat-c"],
      activeTabId: "chat-c",
    },
    "panel-terminal": {
      tabIds: ["term-a"],
      activeTabId: "term-a",
    },
  },
});

const buildFileTransferTask = (
  overrides: Partial<FileTransferTaskSnapshot> & { id: string },
): FileTransferTaskSnapshot => ({
  id: overrides.id,
  origin: overrides.origin || "user",
  mode: overrides.mode || "copy",
  sourceTerminalId: overrides.sourceTerminalId || "source-terminal",
  sourceTerminalName: overrides.sourceTerminalName || "Source",
  sourceMachineIdentity: overrides.sourceMachineIdentity || "local://source",
  sourcePaths: overrides.sourcePaths || ["/src/report.txt"],
  targetTerminalId: overrides.targetTerminalId || "target-terminal",
  targetTerminalName: overrides.targetTerminalName || "Target",
  targetMachineIdentity: overrides.targetMachineIdentity || "ssh://target:22",
  targetDirPath: overrides.targetDirPath || "/dst",
  itemNames: overrides.itemNames || ["report.txt"],
  conflictStrategy: overrides.conflictStrategy || "rename",
  status: overrides.status || "queued",
  bytesDone: overrides.bytesDone || 0,
  totalBytes: overrides.totalBytes || 10,
  transferredFiles: overrides.transferredFiles || 0,
  totalFiles: overrides.totalFiles || 1,
  percent: overrides.percent || 0,
  message: overrides.message ?? null,
  errorMessage: overrides.errorMessage ?? null,
  cancelRequested: overrides.cancelRequested || false,
  createdAt: overrides.createdAt || 1,
  updatedAt: overrides.updatedAt || 1,
  startedAt: overrides.startedAt,
  completedAt: overrides.completedAt,
  sessionId: overrides.sessionId,
  agentRunId: overrides.agentRunId,
  toolMessageId: overrides.toolMessageId,
});

const installBootstrapWindowMock = (
  layoutTree: LayoutTree,
  options?: {
    allChatHistory?: Array<{ id: string; title?: string }>;
    uiMessagesBySessionId?: Record<string, any[]>;
    getUiMessages?: (sessionId: string) => Promise<any[]>;
    getSessionSnapshot?: (sessionId: string) => Promise<any>;
    runtimeSnapshotsBySessionId?: Record<string, any>;
    onUiUpdateRegister?: (callback: (action: any) => void) => void;
    onSettingsUpdatedRegister?: (callback: (settings: any) => void) => void;
    onCommandPolicyListsUpdatedRegister?: (
      callback: (lists: any) => void,
    ) => void;
    onMemoryUpdatedRegister?: (callback: (snapshot: any) => void) => void;
    loadChatSessionCalls?: string[];
    terminalListPayload?: { terminals: any[] };
  },
): void => {
  const versionPayload = {
    status: "up-to-date",
    currentVersion: "1.0.0",
    latestVersion: "1.0.0",
  };

  (globalThis as unknown as { document: unknown }).document = {
    documentElement: {
      style: {
        setProperty: () => {},
      },
    },
  };
  (globalThis as unknown as { window: unknown }).window = {
    gyshell: {
      historyMigration: {
        getState: async () => ({
          status: "done",
          ready: true,
          active: false,
          blocking: false,
          detectedLegacy: false,
          phase: "done",
          title: "History storage ready",
          message: "History storage is ready.",
          completedUnits: 1,
          totalUnits: 1,
          percent: 100,
        }),
        waitUntilSettled: async () => ({
          status: "done",
          ready: true,
          active: false,
          blocking: false,
          detectedLegacy: false,
          phase: "done",
          title: "History storage ready",
          message: "History storage is ready.",
          completedUnits: 1,
          totalUnits: 1,
          percent: 100,
        }),
        onStateChanged: () => () => {},
      },
      settings: {
        get: async () => ({
          themeId: "gyshell-dark",
          language: "en",
          layout: {
            v2: layoutTree,
          },
        }),
        set: async () => {},
        getCommandPolicyLists: async () => ({
          allowlist: [],
          denylist: [],
          asklist: [],
        }),
        onUpdated: (callback: (settings: any) => void) => {
          options?.onSettingsUpdatedRegister?.(callback);
          return () => {};
        },
        onCommandPolicyListsUpdated: (callback: (lists: any) => void) => {
          options?.onCommandPolicyListsUpdatedRegister?.(callback);
          return () => {};
        },
        setWsGatewayConfig: async (ws: {
          access: string;
          port: number;
          allowedCidrs?: string[];
        }) => ws,
      },
      mobileWeb: {
        getStatus: async () => ({ running: false }),
        start: async () => ({ running: true }),
        stop: async () => ({ ok: true }),
        setPort: async () => ({ ok: true }),
      },
      uiSettings: {
        get: async () => ({}),
      },
      themes: {
        getCustom: async () => [],
      },
      agent: {
        onUiUpdate: (callback: (action: any) => void) => {
          options?.onUiUpdateRegister?.(callback);
        },
        getAllChatHistory: async () => options?.allChatHistory || [],
        getUiMessages: async (sessionId: string) => {
          if (options?.getUiMessages) {
            return await options.getUiMessages(sessionId);
          }
          return options?.uiMessagesBySessionId?.[sessionId] || [];
        },
        getSessionSnapshot: async (sessionId: string) => {
          if (options?.getSessionSnapshot) {
            return await options.getSessionSnapshot(sessionId);
          }
          return (
            options?.runtimeSnapshotsBySessionId?.[sessionId] || {
              id: sessionId,
              isBusy: false,
              lockedProfileId: null,
            }
          );
        },
        loadChatSession: async (sessionId: string) => {
          options?.loadChatSessionCalls?.push(sessionId);
          return null;
        },
      },
      terminal: {
        onExit: () => {},
        onTabsUpdated: () => {},
        list: async () =>
          options?.terminalListPayload || {
            terminals: [
              {
                id: "term-a",
                title: "Local",
                type: "local",
                cols: 80,
                rows: 24,
                runtimeState: "ready",
              },
            ],
          },
      },
      filesystem: {
        listTransfers: async () => [],
        onTransferTaskUpdated: () => () => {},
        onTransferTaskRemoved: () => () => {},
        startTransfer: async (input: any) => ({
          id: input.transferId || "transfer-test",
          origin: input.origin || "user",
          mode: input.mode || "copy",
          sourceTerminalId: input.sourceTerminalId,
          sourceTerminalName: "Source",
          sourceMachineIdentity: "local://source",
          sourcePaths: input.sourcePaths || [],
          targetTerminalId: input.targetTerminalId,
          targetTerminalName: "Target",
          targetMachineIdentity: "ssh://target:22",
          targetDirPath: input.targetDirPath,
          itemNames: [],
          conflictStrategy: input.conflictStrategy || "rename",
          status: "queued",
          bytesDone: 0,
          totalBytes: 0,
          transferredFiles: 0,
          totalFiles: 0,
          percent: 0,
          message: null,
          errorMessage: null,
          cancelRequested: false,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        }),
        cancelTransferTask: async () => null,
      },
      monitor: {
        start: async () => ({ ok: true }),
        stop: async () => ({ ok: true }),
        subscribe: async () => ({ ok: true }),
        unsubscribe: async () => ({ ok: true }),
        snapshot: async () => null,
        isMonitoring: async () => ({ monitoring: false }),
        onSnapshot: () => () => {},
      },
      tools: {
        getMcp: async () => [],
        getBuiltIn: async () => [],
        onMcpUpdated: () => {},
        onBuiltInUpdated: () => {},
      },
      skills: {
        getAll: async () => [],
        getEnabled: async () => [],
        onUpdated: () => {},
      },
      memory: {
        get: async () => ({
          filePath: "",
          content: "",
        }),
        onUpdated: (callback: (snapshot: any) => void) => {
          options?.onMemoryUpdatedRegister?.(callback);
          return () => {};
        },
      },
      accessTokens: {
        list: async () => [],
      },
      version: {
        getState: async () => versionPayload,
        check: async () => versionPayload,
      },
    },
  };
};

const run = async (): Promise<void> => {
  await runCase(
    "agent setting operation result refreshes visible settings slices together",
    async () => {
      const originalWindow = (globalThis as any).window;
      try {
        const store = new AppStore();
        store.settings = {
          schemaVersion: 4,
          themeId: "gyshell-dark",
          language: "en",
          commandPolicyMode: "safe",
          commandPolicyRules: [],
          layout: {},
          models: {
            items: [],
            profiles: [],
            activeProfileId: null,
          },
          tools: {
            builtIn: {
              exec_command: false,
            },
            skills: {
              docs: false,
            },
          },
          memory: {
            enabled: true,
          },
          agentSettings: {
            profiles: [],
            activeProfileId: null,
          },
        } as any;
        store.mcpTools = [
          {
            name: "search",
            enabled: false,
            status: "disabled",
          } as any,
        ];
        store.builtInTools = [
          {
            name: "exec_command",
            enabled: false,
          } as any,
        ];
        store.skills = [
          {
            name: "docs",
            description: "Docs",
            enabled: false,
          } as any,
        ];
        store.memoryFilePath = "/tmp/default/memory.md";
        store.memoryContent = "default";

        (globalThis as any).window = {
          gyshell: {
            agentSettings: {
              saveCurrent: async () => ({
                settings: {
                  schemaVersion: 4,
                  commandPolicyMode: "standard",
                  models: {
                    items: [],
                    profiles: [],
                    activeProfileId: null,
                  },
                  tools: {
                    builtIn: {
                      exec_command: true,
                    },
                    skills: {
                      docs: true,
                    },
                  },
                  memory: {
                    enabled: false,
                  },
                  agentSettings: {
                    profiles: [
                      {
                        id: "agent-setting-slot-1",
                        slotNumber: 1,
                        name: "Agent 1",
                        createdAt: 1,
                        updatedAt: 2,
                        snapshot: {
                          version: 1,
                          commandPolicyMode: "standard",
                          commandPolicyLists: {
                            allowlist: [],
                            denylist: [],
                            asklist: [],
                          },
                          mcpTools: {},
                          builtInTools: {
                            exec_command: true,
                          },
                          skills: {
                            docs: true,
                          },
                          memory: {
                            enabled: false,
                          },
                          workflow: {
                            recursionLimit: 500,
                            experimental: {},
                          },
                          model: {
                            activeProfileId: null,
                            activeProfileName: null,
                          },
                        },
                      },
                    ],
                    activeProfileId: "agent-setting-slot-1",
                  },
                },
                commandPolicyLists: {
                  allowlist: ["ls"],
                  denylist: ["rm -rf /"],
                  asklist: [],
                },
                mcpTools: [
                  {
                    name: "search",
                    enabled: true,
                    status: "connected",
                  },
                ],
                builtInTools: [
                  {
                    name: "exec_command",
                    enabled: true,
                  },
                ],
                skills: [
                  {
                    name: "docs",
                    enabled: true,
                  },
                ],
                memory: {
                  filePath: "/tmp/agent-setting-slot-1/memory.md",
                  content: "slot memory",
                },
                warnings: [
                  'Saved model profile "Deep" no longer exists. Current model profile was preserved.',
                ],
              }),
            },
          },
        };

        await store.saveCurrentAgentSetting();

        assertEqual(
          store.agentSettingState.activeProfileId,
          "agent-setting-slot-1",
          "agent setting profile state should update from operation result",
        );
        assertEqual(
          store.commandPolicyLists.allowlist[0],
          "ls",
          "command policy lists should refresh from operation result",
        );
        assertEqual(
          store.mcpTools[0]?.enabled,
          true,
          "mcp tool states should refresh from operation result",
        );
        assertEqual(
          store.settings?.tools.builtIn.exec_command,
          true,
          "built-in tool settings should refresh from operation result",
        );
        assertEqual(
          store.settings?.tools.skills?.docs,
          true,
          "skill settings should refresh from operation result",
        );
        assertEqual(
          store.memoryContent,
          "slot memory",
          "active memory content should refresh from operation result",
        );
        assertEqual(
          store.agentSettingWarnings[0],
          'Saved model profile "Deep" no longer exists. Current model profile was preserved.',
          "agent setting warnings should surface from operation result",
        );

        store.clearAgentSettingWarnings();
        assertEqual(
          store.agentSettingWarnings.length,
          0,
          "agent setting warnings should be dismissible",
        );
      } finally {
        (globalThis as any).window = originalWindow;
      }
    },
  );

  await runCase(
    "AppStore bootstrap consumes cross-window agent setting broadcasts",
    async () => {
      let settingsUpdatedHandler: ((settings: any) => void) | null = null;
      let policyListsUpdatedHandler: ((lists: any) => void) | null = null;
      let memoryUpdatedHandler: ((snapshot: any) => void) | null = null;
      installBootstrapWindowMock(buildPersistedTree(), {
        onSettingsUpdatedRegister: (callback) => {
          settingsUpdatedHandler = callback;
        },
        onCommandPolicyListsUpdatedRegister: (callback) => {
          policyListsUpdatedHandler = callback;
        },
        onMemoryUpdatedRegister: (callback) => {
          memoryUpdatedHandler = callback;
        },
      });

      const store = new AppStore();
      (store.layout as any).bootstrap = () => {};
      (store.layout as any).syncPanelBindings = () => {};
      (store as any).loadTools = async () => {};
      (store as any).loadSkills = async () => {};
      (store as any).loadMemory = async () => {};
      (store as any).loadCommandPolicyLists = async () => {};
      (store as any).loadAccessTokens = async () => {};
      (store as any).loadVersionState = async () => {};
      (store as any).checkVersion = async () => {};

      await store.bootstrap();

      assertCondition(
        !!settingsUpdatedHandler,
        "bootstrap should subscribe to backend settings broadcasts",
      );
      assertCondition(
        !!policyListsUpdatedHandler,
        "bootstrap should subscribe to command policy list broadcasts",
      );
      assertCondition(
        !!memoryUpdatedHandler,
        "bootstrap should subscribe to memory broadcasts",
      );

      settingsUpdatedHandler!({
        schemaVersion: 4,
        commandPolicyMode: "smart",
        recursionLimit: 640,
        models: {
          items: [],
          profiles: [
            {
              id: "profile-deep",
              name: "Deep",
              globalModelId: "model-deep",
            },
          ],
          activeProfileId: "profile-deep",
        },
        tools: {
          builtIn: {},
          skills: {},
        },
        memory: {
          enabled: false,
        },
        agentSettings: {
          profiles: [
            {
              id: "agent-setting-slot-1",
              slotNumber: 1,
              createdAt: 1,
              updatedAt: 2,
              snapshot: {
                version: 1,
                security: {
                  commandPolicyMode: "smart",
                  commandPolicyLists: {
                    allowlist: [],
                    denylist: [],
                    asklist: [],
                  },
                },
                tools: {
                  builtIn: {},
                  mcp: {},
                },
                skills: {},
                memory: {
                  enabled: false,
                },
                workflow: {
                  recursionLimit: 640,
                  experimental: {},
                },
                model: {
                  activeProfileId: "profile-deep",
                  activeProfileName: "Deep",
                },
              },
            },
          ],
          activeProfileId: "agent-setting-slot-1",
        },
      });
      policyListsUpdatedHandler!({
        allowlist: ["ls *"],
        denylist: ["rm -rf /"],
        asklist: ["git push"],
      });
      memoryUpdatedHandler!({
        filePath: "/tmp/agent-setting-slot-1/memory.md",
        content: "slot memory",
      });

      assertEqual(
        store.settings?.commandPolicyMode,
        "smart",
        "settings broadcast should update policy mode",
      );
      assertEqual(
        store.settings?.models.activeProfileId,
        "profile-deep",
        "settings broadcast should update active model profile",
      );
      assertEqual(
        store.settings?.recursionLimit,
        640,
        "settings broadcast should update workflow recursion limit",
      );
      assertEqual(
        store.agentSettingState.activeProfileId,
        "agent-setting-slot-1",
        "settings broadcast should update active agent setting slot",
      );
      assertEqual(
        store.commandPolicyLists.denylist[0],
        "rm -rf /",
        "policy list broadcast should update command policy lists",
      );
      assertEqual(
        store.memoryContent,
        "slot memory",
        "memory broadcast should update active memory content",
      );
    },
  );

  await runCase(
    "filesystem clipboard snapshots remain plain structured-cloneable data",
    () => {
      const store = new AppStore();

      store.setFileSystemClipboard({
        mode: "copy",
        sourceTerminalId: "term-a",
        sourcePaths: ["/tmp/a.txt", "/tmp/b.txt"],
        itemNames: ["a.txt", "b.txt"],
        sourceBasePath: "/tmp",
        createdAt: 123,
      });

      const clipboard = store.fileSystemClipboard;
      assertCondition(!!clipboard, "clipboard should be populated");
      assertCondition(
        !isObservable(clipboard),
        "clipboard snapshot should not be wrapped by MobX",
      );
      assertCondition(
        !isObservableArray(clipboard!.sourcePaths),
        "clipboard source paths should stay plain arrays",
      );
      assertCondition(
        !isObservableArray(clipboard!.itemNames),
        "clipboard item names should stay plain arrays",
      );

      const cloned = structuredClone(clipboard);
      assertEqual(
        JSON.stringify(cloned),
        JSON.stringify({
          mode: "copy",
          sourceTerminalId: "term-a",
          sourcePaths: ["/tmp/a.txt", "/tmp/b.txt"],
          itemNames: ["a.txt", "b.txt"],
          sourceBasePath: "/tmp",
          createdAt: 123,
        }),
        "clipboard snapshot should survive structured cloning",
      );
    },
  );

  await runCase(
    "file transfer updates ignore older snapshots and same-timestamp regressions",
    () => {
      const store = new AppStore();
      store.applyFileTransferTaskUpdate(
        buildFileTransferTask({
          id: "transfer-a",
          status: "running",
          bytesDone: 5,
          percent: 50,
          updatedAt: 20,
        }),
      );

      store.applyFileTransferTaskUpdate(
        buildFileTransferTask({
          id: "transfer-a",
          status: "queued",
          bytesDone: 0,
          percent: 0,
          updatedAt: 10,
        }),
      );
      assertEqual(
        store.fileTransferTasks["transfer-a"].status,
        "running",
        "older startTransfer response should not regress a running task",
      );

      store.applyFileTransferTaskUpdate(
        buildFileTransferTask({
          id: "transfer-a",
          status: "success",
          bytesDone: 10,
          percent: 100,
          updatedAt: 20,
        }),
      );
      store.applyFileTransferTaskUpdate(
        buildFileTransferTask({
          id: "transfer-a",
          status: "running",
          bytesDone: 5,
          percent: 50,
          updatedAt: 20,
        }),
      );
      assertEqual(
        store.fileTransferTasks["transfer-a"].status,
        "success",
        "same-timestamp non-terminal snapshot should not overwrite a terminal state",
      );
    },
  );

  await runCase(
    "file transfer bootstrap list merges without overwriting newer task events",
    () => {
      const store = new AppStore();
      store.applyFileTransferTaskUpdate(
        buildFileTransferTask({
          id: "transfer-a",
          status: "running",
          bytesDone: 5,
          percent: 50,
          updatedAt: 20,
        }),
      );

      store.applyFileTransferTasks([
        buildFileTransferTask({
          id: "transfer-a",
          status: "queued",
          bytesDone: 0,
          percent: 0,
          updatedAt: 10,
        }),
        buildFileTransferTask({
          id: "transfer-b",
          status: "queued",
          updatedAt: 12,
        }),
      ]);

      assertEqual(
        store.fileTransferTasks["transfer-a"].status,
        "running",
        "older bootstrap list item should not regress a newer event",
      );
      assertEqual(
        store.fileTransferTasks["transfer-b"].status,
        "queued",
        "bootstrap list should still add unseen transfer tasks",
      );
    },
  );

  await runCase(
    "createLocalTab marks non-Windows local tabs ready immediately",
    () => {
      (globalThis as unknown as { window: unknown }).window = {
        gyshell: {
          system: {
            platform: "darwin",
          },
        },
      };
      const store = new AppStore();
      (store.layout as any).getPrimaryPanelId = () => null;
      (store.layout as any).ensurePrimaryPanelForKind = () => null;
      (store.layout as any).attachTabToPanel = () => {};
      (store.layout as any).syncPanelBindings = () => {};

      const tabId = store.createLocalTab();
      const tab = store.terminalTabs.find((entry) => entry.id === tabId);

      assertEqual(
        tab?.runtimeState,
        "ready",
        "non-Windows local tabs should not render as disconnected while backend hydration catches up",
      );
    },
  );

  await runCase(
    "createLocalTab without a terminal panel stays unhosted until one exists",
    () => {
      (globalThis as unknown as { window: unknown }).window = {
        gyshell: {
          system: {
            platform: "darwin",
          },
        },
      };
      const store = new AppStore();
      (store.layout as any).saveLayoutDebounced = () => {};
      store.layout.setViewport(1400, 900);

      const initialTerminalPanelId = store.layout.getPrimaryPanelId("terminal");
      assertCondition(
        Boolean(initialTerminalPanelId),
        "default layout should start with a terminal panel",
      );
      store.layout.removePanel(initialTerminalPanelId!);
      assertEqual(
        store.layout.getPrimaryPanelId("terminal"),
        null,
        "test setup should remove all terminal panels before local creation",
      );

      const tabId = store.createLocalTab(undefined, { ensurePanel: false });
      assertEqual(
        store.layout.getPrimaryPanelId("terminal"),
        null,
        "list-panel local creation should not recreate a terminal panel by itself",
      );
      assertCondition(
        store.getLayoutBindableTabIds("terminal").includes(tabId),
        "unhosted local tab should remain eligible for a future terminal panel",
      );

      const restoredPanelId =
        store.layout.ensurePrimaryPanelForKind("terminal");
      assertCondition(
        Boolean(restoredPanelId),
        "terminal panel should be restorable after local background creation",
      );
      assertEqual(
        JSON.stringify(store.layout.getPanelTabIds(restoredPanelId!)),
        JSON.stringify([tabId]),
        "future terminal panel should automatically host the unhosted local tab",
      );
      assertEqual(
        store.layout.getPanelActiveTabId(restoredPanelId!),
        tabId,
        "future terminal panel should activate the unhosted local tab",
      );
    },
  );

  await runCase(
    "createLocalTab can start runtime without attaching to a terminal panel",
    async () => {
      const originalWindow = (globalThis as any).window;
      let createdConfig: any = null;

      (globalThis as any).window = {
        gyshell: {
          system: {
            platform: "darwin",
          },
          terminal: {
            createTab: async (config: any) => {
              createdConfig = config;
              return { id: config.id };
            },
            list: async () => ({
              terminals: createdConfig
                ? [
                    {
                      id: createdConfig.id,
                      title: createdConfig.title,
                      type: "local",
                      cols: createdConfig.cols,
                      rows: createdConfig.rows,
                      runtimeState: "ready",
                    },
                  ]
                : [],
            }),
          },
        },
      };

      try {
        const store = new AppStore();
        (store.layout as any).saveLayoutDebounced = () => {};
        store.layout.setViewport(1400, 900);

        const initialTerminalPanelId =
          store.layout.getPrimaryPanelId("terminal");
        assertCondition(
          Boolean(initialTerminalPanelId),
          "default layout should start with a terminal panel",
        );
        store.layout.removePanel(initialTerminalPanelId!);

        const tabId = store.createLocalTab(undefined, {
          ensurePanel: false,
          startRuntime: true,
        });
        const initializingTab = store.terminalTabs.find(
          (entry) => entry.id === tabId,
        );
        assertEqual(
          initializingTab?.runtimeState,
          "initializing",
          "background local tabs should not look ready before backend creation",
        );
        assertEqual(
          store.layout.getPrimaryPanelId("terminal"),
          null,
          "background local runtime creation should not create a terminal panel",
        );

        await new Promise((resolve) => setTimeout(resolve, 0));

        assertEqual(
          createdConfig?.id,
          tabId,
          "background local creation should create the backend terminal runtime",
        );
        assertEqual(
          store.layout.getPrimaryPanelId("terminal"),
          null,
          "backend local runtime creation should keep the tab unhosted when no terminal panel exists",
        );
        assertCondition(
          store.getLayoutBindableTabIds("terminal").includes(tabId),
          "background local runtime should stay eligible for future terminal panels after reconciliation",
        );
        assertEqual(
          store.activeTerminalId,
          tabId,
          "background local runtime should remain the active terminal after reconciliation",
        );
        assertEqual(
          store.terminalTabs.find((entry) => entry.id === tabId)?.runtimeState,
          "ready",
          "background local runtime should reconcile to the backend ready state",
        );
      } finally {
        (globalThis as any).window = originalWindow;
      }
    },
  );

  await runCase(
    "createSshTab can start runtime without attaching to a terminal panel",
    async () => {
      const originalWindow = (globalThis as any).window;
      let createdConfig: any = null;
      let attachCallCount = 0;
      let syncCallCount = 0;

      (globalThis as any).window = {
        gyshell: {
          terminal: {
            createTab: async (config: any) => {
              createdConfig = config;
              return { id: config.id };
            },
            list: async () => ({
              terminals: createdConfig
                ? [
                    {
                      id: createdConfig.id,
                      title: createdConfig.title,
                      type: "ssh",
                      cols: createdConfig.cols,
                      rows: createdConfig.rows,
                      runtimeState: "initializing",
                    },
                  ]
                : [],
            }),
          },
        },
      };

      try {
        const store = new AppStore();
        store.settings = {
          connections: {
            ssh: [
              {
                id: "ssh-entry",
                name: "Deploy Host",
                host: "deploy.example.test",
                port: 22,
                username: "deploy",
                authMethod: "password",
                password: "secret",
              },
            ],
            proxies: [],
            tunnels: [],
          },
        } as any;
        (store.layout as any).getPrimaryPanelId = () => null;
        (store.layout as any).getPanelIdsByKind = () => [];
        (store.layout as any).attachTabToPanel = () => {
          attachCallCount += 1;
        };
        (store.layout as any).syncPanelBindings = () => {
          syncCallCount += 1;
        };

        const tabId = store.createSshTab("ssh-entry", undefined, {
          ensurePanel: false,
          attachToPanel: false,
          startRuntime: true,
        });
        await new Promise((resolve) => setTimeout(resolve, 0));

        assertCondition(Boolean(tabId), "SSH tab should be created");
        assertEqual(
          attachCallCount,
          0,
          "background SSH creation should not attach to a visible terminal panel",
        );
        assertEqual(
          syncCallCount,
          2,
          "background SSH creation should sync layout locally and after backend reconciliation",
        );
        assertEqual(
          createdConfig?.id,
          tabId,
          "background SSH creation should start the backend runtime with the new tab id",
        );
        assertEqual(
          createdConfig?.host,
          "deploy.example.test",
          "background SSH creation should preserve SSH connection config",
        );
        assertEqual(
          JSON.stringify(store.getOwnedTabIds("terminal")),
          JSON.stringify([tabId]),
          "background SSH creation should keep the tab visible in global terminal inventory",
        );
        assertEqual(
          JSON.stringify(store.getLayoutBindableTabIds("terminal")),
          JSON.stringify([tabId]),
          "background SSH creation should remain bindable when a terminal panel appears later",
        );
        assertEqual(
          store.activeTerminalId,
          tabId,
          "background SSH creation should make the new tab active in global inventory",
        );
      } finally {
        (globalThis as any).window = originalWindow;
      }
    },
  );

  await runCase(
    "background SSH tab binds when a terminal panel appears later",
    async () => {
      const store = new AppStore();
      store.settings = {
        connections: {
          ssh: [
            {
              id: "ssh-entry",
              name: "Deploy Host",
              host: "deploy.example.test",
              port: 22,
              username: "deploy",
              authMethod: "password",
              password: "secret",
            },
          ],
          proxies: [],
          tunnels: [],
        },
      } as any;
      store.layout.setViewport(1400, 900);

      const initialTerminalPanelId = store.layout.getPrimaryPanelId("terminal");
      assertCondition(
        Boolean(initialTerminalPanelId),
        "default main layout should start with a terminal panel",
      );
      store.layout.removePanel(initialTerminalPanelId!);
      assertEqual(
        store.layout.getPrimaryPanelId("terminal"),
        null,
        "test setup should remove all terminal panels before background creation",
      );

      const tabId = store.createSshTab("ssh-entry", undefined, {
        ensurePanel: false,
        attachToPanel: false,
        startRuntime: false,
      });
      assertCondition(Boolean(tabId), "background SSH tab should be created");
      assertEqual(
        store.layout.getPrimaryPanelId("terminal"),
        null,
        "background SSH creation should not recreate a terminal panel by itself",
      );
      assertCondition(
        store.getLayoutBindableTabIds("terminal").includes(tabId!),
        "background SSH tab should stay eligible for future terminal panels",
      );

      const restoredPanelId =
        store.layout.ensurePrimaryPanelForKind("terminal");
      assertCondition(
        Boolean(restoredPanelId),
        "terminal panel should be restorable after background tab creation",
      );
      assertEqual(
        JSON.stringify(store.layout.getPanelTabIds(restoredPanelId!)),
        JSON.stringify([tabId]),
        "restored terminal panel should automatically host the background tab",
      );
      assertEqual(
        store.layout.getPanelActiveTabId(restoredPanelId!),
        tabId,
        "restored terminal panel should activate the background tab",
      );
    },
  );

  await runCase(
    "background SSH tab binds when a terminal panel already exists",
    async () => {
      const store = new AppStore();
      store.settings = {
        connections: {
          ssh: [
            {
              id: "ssh-entry",
              name: "Deploy Host",
              host: "deploy.example.test",
              port: 22,
              username: "deploy",
              authMethod: "password",
              password: "secret",
            },
          ],
          proxies: [],
          tunnels: [],
        },
      } as any;
      (store.layout as any).saveLayoutDebounced = () => {};
      store.layout.setViewport(1400, 900);

      const terminalPanelId = store.layout.getPrimaryPanelId("terminal");
      assertCondition(
        Boolean(terminalPanelId),
        "default main layout should start with a terminal panel",
      );

      const tabId = store.createSshTab("ssh-entry", undefined, {
        ensurePanel: false,
        attachToPanel: false,
        startRuntime: false,
      });
      assertCondition(Boolean(tabId), "background SSH tab should be created");
      assertEqual(
        JSON.stringify(store.getOwnedTabIds("terminal")),
        JSON.stringify([tabId]),
        "background SSH tab should stay visible in global terminal inventory",
      );
      assertEqual(
        JSON.stringify(store.getLayoutBindableTabIds("terminal")),
        JSON.stringify([tabId]),
        "background SSH tab should stay layout-bindable when a terminal panel exists",
      );
      assertEqual(
        JSON.stringify(store.layout.getPanelTabIds(terminalPanelId!)),
        JSON.stringify([tabId]),
        "existing terminal panel should automatically receive a background SSH tab",
      );
      assertEqual(
        store.layout.getPanelActiveTabId(terminalPanelId!),
        tabId,
        "existing terminal panel should activate the new background SSH tab",
      );
    },
  );

  await runCase(
    "background SSH tab binds to an existing monitor without a terminal panel",
    async () => {
      const store = new AppStore();
      store.settings = {
        connections: {
          ssh: [
            {
              id: "ssh-entry",
              name: "Deploy Host",
              host: "deploy.example.test",
              port: 22,
              username: "deploy",
              authMethod: "password",
              password: "secret",
            },
          ],
          proxies: [],
          tunnels: [],
        },
      } as any;
      (store.layout as any).saveLayoutDebounced = () => {};
      store.layout.setViewport(1400, 900);

      const listPanelId = store.layout.ensurePrimaryPanelForKind("listPanel");
      assertCondition(
        Boolean(listPanelId),
        "test setup should create a list panel",
      );
      const initialTerminalPanelId = store.layout.getPrimaryPanelId("terminal");
      assertCondition(
        Boolean(initialTerminalPanelId),
        "default main layout should start with a terminal panel",
      );
      store.layout.removePanel(initialTerminalPanelId!);
      const initialChatPanelId = store.layout.getPrimaryPanelId("chat");
      if (initialChatPanelId) {
        store.layout.removePanel(initialChatPanelId);
      }
      assertEqual(
        store.layout.getPrimaryPanelId("terminal"),
        null,
        "test setup should remove terminal panels before background creation",
      );
      assertEqual(
        store.layout.getPrimaryPanelId("chat"),
        null,
        "test setup should leave only the list panel before adding monitor",
      );
      const monitorPanelId = store.layout.ensurePrimaryPanelForKind("monitor");
      assertCondition(
        Boolean(monitorPanelId),
        "test setup should create a monitor panel",
      );

      const tabId = store.createSshTab("ssh-entry", undefined, {
        ensurePanel: false,
        attachToPanel: false,
        startRuntime: false,
      });
      assertCondition(Boolean(tabId), "background SSH tab should be created");
      assertCondition(
        store.getLayoutBindableTabIds("terminal").includes(tabId!),
        "background SSH tab should remain eligible for a future terminal panel",
      );
      assertCondition(
        !store.getLayoutBindableTabIds("filesystem").includes(tabId!),
        "background SSH tab should remain hidden from filesystem panels",
      );
      assertCondition(
        store.getLayoutBindableTabIds("monitor").includes(tabId!),
        "background SSH tab should stay bindable to the existing monitor panel",
      );
      assertEqual(
        JSON.stringify(store.layout.getPanelTabIds(monitorPanelId!)),
        JSON.stringify([tabId]),
        "existing monitor panel should receive the background SSH tab",
      );
      assertEqual(
        store.layout.getPanelActiveTabId(monitorPanelId!),
        tabId,
        "existing monitor panel should activate the background SSH tab",
      );

      store.reconcileTerminalTabs({
        terminals: [
          {
            id: tabId,
            title: "Deploy Host",
            type: "ssh",
            cols: 80,
            rows: 24,
            runtimeState: "ready",
            monitorIdentity: "ssh://deploy@deploy.example.test:22",
          },
        ],
      } as any);
      assertEqual(
        JSON.stringify(store.layout.getPanelTabIds(monitorPanelId!)),
        JSON.stringify([tabId]),
        "backend reconciliation should preserve the monitor panel binding",
      );
    },
  );

  await runCase(
    "background SSH tab binds to a future monitor but not a future filesystem panel",
    async () => {
      const store = new AppStore();
      store.settings = {
        connections: {
          ssh: [
            {
              id: "ssh-entry",
              name: "Deploy Host",
              host: "deploy.example.test",
              port: 22,
              username: "deploy",
              authMethod: "password",
              password: "secret",
            },
          ],
          proxies: [],
          tunnels: [],
        },
      } as any;
      (store.layout as any).saveLayoutDebounced = () => {};
      store.layout.setViewport(1400, 900);

      const listPanelId = store.layout.ensurePrimaryPanelForKind("listPanel");
      assertCondition(
        Boolean(listPanelId),
        "test setup should create a list panel",
      );
      const initialTerminalPanelId = store.layout.getPrimaryPanelId("terminal");
      assertCondition(
        Boolean(initialTerminalPanelId),
        "default main layout should start with a terminal panel",
      );
      store.layout.removePanel(initialTerminalPanelId!);
      const initialChatPanelId = store.layout.getPrimaryPanelId("chat");
      if (initialChatPanelId) {
        store.layout.removePanel(initialChatPanelId);
      }
      assertEqual(
        store.layout.getPrimaryPanelId("terminal"),
        null,
        "test setup should remove terminal panels before background creation",
      );
      assertEqual(
        store.layout.getPrimaryPanelId("filesystem"),
        null,
        "test setup should not have a filesystem panel before background creation",
      );
      assertEqual(
        store.layout.getPrimaryPanelId("monitor"),
        null,
        "test setup should not have a monitor panel before background creation",
      );

      const tabId = store.createSshTab("ssh-entry", undefined, {
        ensurePanel: false,
        attachToPanel: false,
        startRuntime: false,
      });
      assertCondition(Boolean(tabId), "background SSH tab should be created");
      assertCondition(
        store.getLayoutBindableTabIds("terminal").includes(tabId!),
        "background SSH tab should remain eligible for a future terminal panel",
      );
      assertCondition(
        !store.getLayoutBindableTabIds("filesystem").includes(tabId!),
        "background SSH tab should be hidden from future filesystem panels",
      );
      assertCondition(
        store.getLayoutBindableTabIds("monitor").includes(tabId!),
        "background SSH tab should remain bindable to future monitor panels",
      );

      const filesystemPanelId =
        store.layout.ensurePrimaryPanelForKind("filesystem");
      const monitorPanelId = store.layout.ensurePrimaryPanelForKind("monitor");
      assertCondition(
        Boolean(filesystemPanelId),
        "future filesystem panel should be creatable",
      );
      assertCondition(
        Boolean(monitorPanelId),
        "future monitor panel should be creatable",
      );
      assertEqual(
        JSON.stringify(store.layout.getPanelTabIds(filesystemPanelId!)),
        JSON.stringify([]),
        "future filesystem panel should not auto-host a background SSH tab",
      );
      assertEqual(
        JSON.stringify(store.layout.getPanelTabIds(monitorPanelId!)),
        JSON.stringify([tabId]),
        "future monitor panel should automatically host the background SSH tab",
      );
      assertEqual(
        store.layout.getPanelActiveTabId(monitorPanelId!),
        tabId,
        "future monitor panel should activate the background SSH tab",
      );
    },
  );

  await runCase(
    "terminal title uniqueness preserves numeric suffixes in user titles",
    () => {
      const store = new AppStore();
      (store as any).terminalTabs = [
        {
          id: "gpu-root",
          title: "GPU",
          config: {
            type: "ssh",
            id: "gpu-root",
            title: "GPU",
            cols: 80,
            rows: 24,
          },
          capabilities: { supportsFilesystem: true, supportsMonitor: true },
          runtimeState: "ready",
        },
        {
          id: "gpu-a",
          title: "GPU (8)",
          config: {
            type: "ssh",
            id: "gpu-a",
            title: "GPU (8)",
            cols: 80,
            rows: 24,
          },
          capabilities: { supportsFilesystem: true, supportsMonitor: true },
          runtimeState: "ready",
        },
      ];

      assertEqual(
        store.getUniqueTitle("GPU (8)"),
        "GPU (8) (1)",
        "numeric suffixes in user-provided terminal titles should be preserved",
      );
    },
  );

  await runCase(
    "collectPersistedChatInventoryState preserves focused chat active tab",
    async () => {
      const store = new AppStore();
      const layoutTree = buildPersistedTree({
        focusedPanelId: "panel-chat-b",
      });

      const state = (store as any).collectPersistedChatInventoryState({
        v2: layoutTree,
      });
      assertEqual(
        JSON.stringify(state.tabIds),
        JSON.stringify(["chat-a", "chat-b", "chat-c"]),
        "chat tab ids should preserve persisted ordering by panel binding",
      );
      assertEqual(
        state.preferredActiveTabId,
        "chat-c",
        "focused chat panel active tab should be restored as preferred active tab",
      );
    },
  );

  await runCase(
    "collectPersistedChatInventoryState falls back to first available active chat tab",
    async () => {
      const store = new AppStore();
      const layoutTree = buildPersistedTree({
        focusedPanelId: "panel-terminal",
      });

      const state = (store as any).collectPersistedChatInventoryState({
        v2: layoutTree,
      });
      assertEqual(
        state.preferredActiveTabId,
        "chat-a",
        "first available active chat tab should be used when focused panel is not chat",
      );
    },
  );

  await runCase(
    "ChatStore hydration honors preferred active session id",
    async () => {
      const chatStore = new ChatStore();
      chatStore.hydrateSessionInventoryFromLayout(
        ["chat-a", "chat-b", "chat-c"],
        "chat-c",
      );
      assertEqual(
        chatStore.activeSessionId,
        "chat-c",
        "preferred active chat session should win over default first tab fallback",
      );
    },
  );

  await runCase(
    "creating a chat in one panel preserves the active chat in other panels",
    async () => {
      const store = new AppStore();
      const layoutTree = buildPersistedTree({
        focusedPanelId: "panel-chat-b",
      });
      layoutTree.panelTabs = {
        ...layoutTree.panelTabs,
        "panel-chat-a": {
          tabIds: ["chat-a", "chat-b"],
          activeTabId: "chat-b",
        },
        "panel-chat-b": {
          tabIds: ["chat-c"],
          activeTabId: "chat-c",
        },
      };
      store.settings = { layout: { v2: layoutTree } } as any;
      store.chat.hydrateSessionInventoryFromLayout(
        ["chat-a", "chat-b", "chat-c"],
        "chat-c",
      );
      (store as any).lastKnownChatSessionIds = new Set([
        "chat-a",
        "chat-b",
        "chat-c",
      ]);
      (store as any).shouldPersistLayout = () => false;
      store.layout.bootstrap();

      const newSessionId = store.chat.createSession("New Chat", {
        activate: false,
      });
      store.layout.attachTabToPanel("chat", newSessionId, "panel-chat-b");

      assertEqual(
        store.layout.getPanelActiveTabId("panel-chat-a"),
        "chat-b",
        "creating a chat in panel B must not change panel A's active chat",
      );
      assertEqual(
        store.layout.getPanelActiveTabId("panel-chat-b"),
        newSessionId,
        "the new chat should become active in the panel where it was created",
      );
    },
  );

  await runCase(
    "AppStore bootstrap passes preferred active chat id into hydration",
    async () => {
      const layoutTree = buildPersistedTree({
        focusedPanelId: "panel-chat-b",
      });
      installBootstrapWindowMock(layoutTree);

      const store = new AppStore();
      (store.layout as any).bootstrap = () => {};
      (store.layout as any).syncPanelBindings = () => {};
      (store as any).loadTools = async () => {};
      (store as any).loadSkills = async () => {};
      (store as any).loadMemory = async () => {};
      (store as any).loadCommandPolicyLists = async () => {};
      (store as any).loadAccessTokens = async () => {};
      (store as any).loadVersionState = async () => {};
      (store as any).checkVersion = async () => {};

      const originalHydrate = store.chat.hydrateSessionInventoryFromLayout.bind(
        store.chat,
      );
      let capturedHydrationArgs: {
        tabIds: string[];
        preferredActiveSessionId: string | null;
      } | null = null;
      store.chat.hydrateSessionInventoryFromLayout = ((
        tabIds: string[],
        preferredActiveSessionId?: string | null,
      ) => {
        capturedHydrationArgs = {
          tabIds: [...tabIds],
          preferredActiveSessionId: preferredActiveSessionId ?? null,
        };
        originalHydrate(tabIds, preferredActiveSessionId);
      }) as ChatStore["hydrateSessionInventoryFromLayout"];

      await store.bootstrap();
      assertCondition(
        !!capturedHydrationArgs,
        "bootstrap should hydrate chat inventory exactly once",
      );
      const hydrationArgs = capturedHydrationArgs || {
        tabIds: [],
        preferredActiveSessionId: null,
      };
      assertEqual(
        JSON.stringify(hydrationArgs.tabIds),
        JSON.stringify(["chat-a", "chat-b", "chat-c"]),
        "bootstrap should pass persisted chat tab ids in deterministic order",
      );
      assertEqual(
        hydrationArgs.preferredActiveSessionId,
        "chat-c",
        "bootstrap should pass preferred active chat session id to hydration",
      );
    },
  );

  await runCase(
    "AppStore bootstrap hydrates restored chat tabs with persisted titles/messages",
    async () => {
      const layoutTree = buildPersistedTree({
        focusedPanelId: "panel-chat-b",
      });
      const loadChatSessionCalls: string[] = [];
      installBootstrapWindowMock(layoutTree, {
        allChatHistory: [
          { id: "chat-a", title: "Alpha Chat" },
          { id: "chat-b", title: "Beta Chat" },
          { id: "chat-c", title: "Gamma Chat" },
        ],
        uiMessagesBySessionId: {
          "chat-a": [
            {
              id: "msg-a1",
              role: "user",
              type: "text",
              content: "hello",
              timestamp: 1,
            },
          ],
          "chat-b": [
            {
              id: "msg-b1",
              role: "assistant",
              type: "text",
              content: "ok",
              timestamp: 2,
            },
          ],
          "chat-c": [
            {
              id: "msg-c1",
              role: "user",
              type: "text",
              content: "resume",
              timestamp: 3,
            },
          ],
        },
        runtimeSnapshotsBySessionId: {
          "chat-c": {
            id: "chat-c",
            isBusy: true,
            lockedProfileId: "profile-1",
          },
        },
        loadChatSessionCalls,
      });

      const store = new AppStore();
      (store.layout as any).bootstrap = () => {};
      (store.layout as any).syncPanelBindings = () => {};
      (store as any).loadTools = async () => {};
      (store as any).loadSkills = async () => {};
      (store as any).loadMemory = async () => {};
      (store as any).loadCommandPolicyLists = async () => {};
      (store as any).loadAccessTokens = async () => {};
      (store as any).loadVersionState = async () => {};
      (store as any).checkVersion = async () => {};

      await store.bootstrap();

      assertEqual(
        store.chat.getSessionById("chat-a")?.title,
        "Alpha Chat",
        "restored chat-a title should be hydrated",
      );
      assertEqual(
        store.chat.getSessionById("chat-b")?.title,
        "Beta Chat",
        "restored chat-b title should be hydrated",
      );
      assertEqual(
        store.chat.getSessionById("chat-c")?.title,
        "Gamma Chat",
        "restored chat-c title should be hydrated",
      );
      assertEqual(
        store.chat.getSessionById("chat-c")?.messageIds.length,
        1,
        "restored chat-c messages should be hydrated",
      );
      assertEqual(
        store.chat.activeSessionId,
        "chat-c",
        "preferred active restored tab should stay active after hydration",
      );
      assertEqual(
        JSON.stringify(loadChatSessionCalls),
        JSON.stringify(["chat-c"]),
        "bootstrap should load runtime backend context for active restored chat session",
      );
    },
  );

  await runCase(
    "reconcileTerminalTabs pins unresolved terminal panels only on first hydration",
    async () => {
      const store = new AppStore();
      let missingCallCount = 0;
      let pinCallCount = 0;
      let capturedIncomingIds: string[] = [];
      let capturedPinnedPanels: string[] = [];

      (store.layout as any).getPanelsWithMissingTabBindings = (
        _kind: string,
        ownerTabIds: string[],
      ) => {
        missingCallCount += 1;
        capturedIncomingIds = [...ownerTabIds];
        return ["panel-term-missing"];
      };
      (store.layout as any).pinPanelsAsRestorePlaceholder = (
        panelIds: string[],
      ) => {
        pinCallCount += 1;
        capturedPinnedPanels = [...panelIds];
      };
      (store.layout as any).syncPanelBindings = () => {};

      store.reconcileTerminalTabs({
        terminals: [
          {
            id: "term-1",
            title: "Local",
            type: "local",
            cols: 80,
            rows: 24,
            runtimeState: "ready",
          },
        ],
      } as any);

      assertEqual(
        missingCallCount,
        1,
        "first hydration should detect unresolved terminal panels",
      );
      assertEqual(
        pinCallCount,
        1,
        "first hydration should pin unresolved terminal panels",
      );
      assertEqual(
        JSON.stringify(capturedIncomingIds),
        JSON.stringify(["term-1"]),
        "incoming ids should be forwarded to layout",
      );
      assertEqual(
        JSON.stringify(capturedPinnedPanels),
        JSON.stringify(["panel-term-missing"]),
        "layout should receive unresolved panel ids",
      );

      store.reconcileTerminalTabs({
        terminals: [
          {
            id: "term-1",
            title: "Local",
            type: "local",
            cols: 120,
            rows: 40,
            runtimeState: "ready",
          },
        ],
      } as any);

      assertEqual(
        missingCallCount,
        1,
        "subsequent updates should not re-run first hydration placeholder detection",
      );
      assertEqual(
        pinCallCount,
        1,
        "subsequent updates should not re-pin placeholders",
      );
    },
  );

  await runCase(
    "reconcileTerminalTabs keeps display titles unique across duplicate backend titles",
    () => {
      const store = new AppStore();
      (store.layout as any).getPanelsWithMissingTabBindings = () => [];
      (store.layout as any).pinPanelsAsRestorePlaceholder = () => {};
      (store.layout as any).syncPanelBindings = () => {};

      const duplicatePayload = {
        terminals: [
          {
            id: "local-a",
            title: "Local (1)",
            type: "local",
            cols: 80,
            rows: 24,
            runtimeState: "ready",
          },
          {
            id: "local-b",
            title: "Local (1)",
            type: "local",
            cols: 80,
            rows: 24,
            runtimeState: "ready",
          },
          {
            id: "local-c",
            title: "Local (3)",
            type: "local",
            cols: 80,
            rows: 24,
            runtimeState: "ready",
          },
        ],
      } as any;

      store.reconcileTerminalTabs(duplicatePayload);
      assertEqual(
        JSON.stringify(store.terminalTabs.map((tab) => tab.title)),
        JSON.stringify(["Local (1)", "Local (1) (1)", "Local (3)"]),
        "duplicate backend terminal titles should keep user numeric suffixes intact",
      );

      store.reconcileTerminalTabs(duplicatePayload);
      assertEqual(
        JSON.stringify(store.terminalTabs.map((tab) => tab.title)),
        JSON.stringify(["Local (1)", "Local (1) (1)", "Local (3)"]),
        "repeated duplicate backend snapshots should keep stable display titles",
      );
      assertEqual(
        JSON.stringify(store.terminalTabs.map((tab) => tab.config.title)),
        JSON.stringify(["Local (1)", "Local (1) (1)", "Local (3)"]),
        "terminal configs should carry the unique display title",
      );
    },
  );

  await runCase(
    "AppStore bootstrap should buffer ui updates emitted during chat hydration",
    async () => {
      const layoutTree = buildPersistedTree({
        focusedPanelId: "panel-chat-b",
      });
      let uiUpdateHandler: ((action: any) => void) | null = null;
      let resolveHydrationGate: (() => void) | null = null;
      const hydrationGate = new Promise<void>((resolve) => {
        resolveHydrationGate = resolve;
      });

      installBootstrapWindowMock(layoutTree, {
        allChatHistory: [
          { id: "chat-a", title: "Alpha Chat" },
          { id: "chat-b", title: "Beta Chat" },
          { id: "chat-c", title: "Gamma Chat" },
        ],
        onUiUpdateRegister: (callback) => {
          uiUpdateHandler = callback;
        },
        getUiMessages: async (sessionId: string) => {
          if (sessionId === "chat-c") {
            await hydrationGate;
          }
          return [];
        },
      });

      const store = new AppStore();
      (store.layout as any).bootstrap = () => {};
      (store.layout as any).syncPanelBindings = () => {};
      (store as any).loadTools = async () => {};
      (store as any).loadSkills = async () => {};
      (store as any).loadMemory = async () => {};
      (store as any).loadCommandPolicyLists = async () => {};
      (store as any).loadAccessTokens = async () => {};
      (store as any).loadVersionState = async () => {};
      (store as any).checkVersion = async () => {};

      const bootstrapPromise = store.bootstrap();
      for (let i = 0; i < 20 && !uiUpdateHandler; i += 1) {
        await Promise.resolve();
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      assertCondition(
        !!uiUpdateHandler,
        "bootstrap should register ui update listener before hydration awaits",
      );

      uiUpdateHandler!({
        type: "ADD_MESSAGE",
        sessionId: "chat-c",
        message: {
          id: "msg-during-hydration",
          role: "assistant",
          type: "text",
          content: "streaming while hydrating",
          timestamp: 10,
        },
      });

      resolveHydrationGate!();

      await bootstrapPromise;

      const restoredSession = store.chat.getSessionById("chat-c");
      assertCondition(
        !!restoredSession,
        "restored session should exist after bootstrap",
      );
      assertCondition(
        restoredSession?.messageIds.includes("msg-during-hydration"),
        "ui update emitted during hydration should be replayed after hydration",
      );
    },
  );

  await runCase(
    "AppStore bootstrap replay should not duplicate messages already present in hydrated snapshot",
    async () => {
      const layoutTree = buildPersistedTree({
        focusedPanelId: "panel-chat-b",
      });
      let uiUpdateHandler: ((action: any) => void) | null = null;
      let resolveHydrationGate: (() => void) | null = null;
      const hydrationGate = new Promise<void>((resolve) => {
        resolveHydrationGate = resolve;
      });

      installBootstrapWindowMock(layoutTree, {
        allChatHistory: [
          { id: "chat-a", title: "Alpha Chat" },
          { id: "chat-b", title: "Beta Chat" },
          { id: "chat-c", title: "Gamma Chat" },
        ],
        onUiUpdateRegister: (callback) => {
          uiUpdateHandler = callback;
        },
        getUiMessages: async (sessionId: string) => {
          if (sessionId === "chat-c") {
            await hydrationGate;
            return [
              {
                id: "msg-shared",
                role: "assistant",
                type: "text",
                content: "shared message",
                timestamp: 20,
              },
            ];
          }
          return [];
        },
      });

      const store = new AppStore();
      (store.layout as any).bootstrap = () => {};
      (store.layout as any).syncPanelBindings = () => {};
      (store as any).loadTools = async () => {};
      (store as any).loadSkills = async () => {};
      (store as any).loadMemory = async () => {};
      (store as any).loadCommandPolicyLists = async () => {};
      (store as any).loadAccessTokens = async () => {};
      (store as any).loadVersionState = async () => {};
      (store as any).checkVersion = async () => {};

      const bootstrapPromise = store.bootstrap();
      for (let i = 0; i < 20 && !uiUpdateHandler; i += 1) {
        await Promise.resolve();
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      assertCondition(
        !!uiUpdateHandler,
        "bootstrap should register ui update listener before hydration awaits",
      );

      uiUpdateHandler!({
        type: "ADD_MESSAGE",
        sessionId: "chat-c",
        message: {
          id: "msg-shared",
          role: "assistant",
          type: "text",
          content: "shared message",
          timestamp: 20,
        },
      });

      resolveHydrationGate!();
      await bootstrapPromise;

      const restoredSession = store.chat.getSessionById("chat-c");
      assertCondition(
        !!restoredSession,
        "restored session should exist after bootstrap",
      );
      const duplicateCount =
        restoredSession?.messageIds.filter((id) => id === "msg-shared")
          .length || 0;
      assertEqual(
        duplicateCount,
        1,
        "deferred replay should not duplicate hydrated message ids",
      );
    },
  );

  await runCase(
    "detached bootstrap restores filesystem visibility after terminal hydration",
    async () => {
      const originalWindow = (globalThis as any).window;
      const originalContext = {
        role: WINDOW_CONTEXT.role,
        detachedStateToken: WINDOW_CONTEXT.detachedStateToken,
        sourceClientId: WINDOW_CONTEXT.sourceClientId,
      };
      const localStorageState = new Map<string, string>();
      const sessionStorageState = new Map<string, string>();
      const token = "detached-fs-bootstrap";
      const detachedLayoutTree: LayoutTree = {
        schemaVersion: 2,
        root: {
          type: "panel",
          id: "node-fs",
          panel: { id: "panel-fs", kind: "filesystem" },
        },
        focusedPanelId: "panel-fs",
        panelTabs: {
          "panel-fs": {
            tabIds: ["term-a"],
            activeTabId: "term-a",
          },
        },
      };

      try {
        installBootstrapWindowMock(buildPersistedTree());
        (globalThis as any).window.localStorage =
          createStorage(localStorageState);
        (globalThis as any).window.sessionStorage =
          createStorage(sessionStorageState);
        stashDetachedWindowState(token, {
          sourceClientId: "win-main",
          layoutTree: detachedLayoutTree,
          createdAt: 123,
        });
        (WINDOW_CONTEXT as any).role = "detached";
        (WINDOW_CONTEXT as any).detachedStateToken = token;
        (WINDOW_CONTEXT as any).sourceClientId = "win-main";

        const store = new AppStore();
        (store.layout as any).bootstrap = () => {};
        (store.layout as any).syncPanelBindings = () => {};
        (store as any).loadTools = async () => {};
        (store as any).loadSkills = async () => {};
        (store as any).loadMemory = async () => {};
        (store as any).loadCommandPolicyLists = async () => {};
        (store as any).loadAccessTokens = async () => {};
        (store as any).loadVersionState = async () => {};
        (store as any).loadMobileWebStatus = async () => {};
        (store as any).checkVersion = async () => {};

        await store.bootstrap();

        assertEqual(
          JSON.stringify(store.getOwnedTabIds("filesystem")),
          JSON.stringify(["term-a"]),
          "detached bootstrap should restore file-capable terminal visibility for filesystem panels",
        );
      } finally {
        (WINDOW_CONTEXT as any).role = originalContext.role;
        (WINDOW_CONTEXT as any).detachedStateToken =
          originalContext.detachedStateToken;
        (WINDOW_CONTEXT as any).sourceClientId = originalContext.sourceClientId;
        (globalThis as any).window = originalWindow;
      }
    },
  );

  await runCase(
    "detached bootstrap materializes terminal snapshots before backend runtime exists",
    async () => {
      const originalWindow = (globalThis as any).window;
      const originalContext = {
        role: WINDOW_CONTEXT.role,
        detachedStateToken: WINDOW_CONTEXT.detachedStateToken,
        sourceClientId: WINDOW_CONTEXT.sourceClientId,
      };
      const localStorageState = new Map<string, string>();
      const sessionStorageState = new Map<string, string>();
      const token = "detached-ssh-bootstrap";
      const detachedLayoutTree: LayoutTree = {
        schemaVersion: 2,
        root: {
          type: "panel",
          id: "node-terminal",
          panel: { id: "panel-terminal-detached", kind: "terminal" },
        },
        focusedPanelId: "panel-terminal-detached",
        panelTabs: {
          "panel-terminal-detached": {
            tabIds: ["ssh-detached"],
            activeTabId: "ssh-detached",
          },
        },
      };

      try {
        installBootstrapWindowMock(buildPersistedTree(), {
          terminalListPayload: { terminals: [] },
        });
        (globalThis as any).window.localStorage =
          createStorage(localStorageState);
        (globalThis as any).window.sessionStorage =
          createStorage(sessionStorageState);
        stashDetachedWindowState(token, {
          sourceClientId: "win-main",
          layoutTree: detachedLayoutTree,
          createdAt: 123,
          terminalTabs: [
            {
              id: "ssh-detached",
              title: "Deploy Host",
              config: {
                type: "ssh",
                id: "ssh-detached",
                title: "Deploy Host",
                cols: 120,
                rows: 32,
                host: "deploy.example.test",
                port: 22,
                username: "deploy",
                authMethod: "password",
              } as any,
              connectionRef: { type: "ssh", entryId: "ssh-entry" },
              runtimeState: "initializing",
            },
          ],
        });
        (WINDOW_CONTEXT as any).role = "detached";
        (WINDOW_CONTEXT as any).detachedStateToken = token;
        (WINDOW_CONTEXT as any).sourceClientId = "win-main";

        const store = new AppStore();
        (store.layout as any).bootstrap = () => {};
        (store.layout as any).syncPanelBindings = () => {};
        (store as any).loadTools = async () => {};
        (store as any).loadSkills = async () => {};
        (store as any).loadMemory = async () => {};
        (store as any).loadCommandPolicyLists = async () => {};
        (store as any).loadAccessTokens = async () => {};
        (store as any).loadVersionState = async () => {};
        (store as any).loadMobileWebStatus = async () => {};
        (store as any).checkVersion = async () => {};

        await store.bootstrap();

        assertEqual(
          JSON.stringify(store.getOwnedTabIds("terminal")),
          JSON.stringify(["ssh-detached"]),
          "detached bootstrap should expose the transferred SSH terminal tab",
        );
        assertEqual(
          store.activeTerminalId,
          "ssh-detached",
          "detached bootstrap should activate the transferred SSH terminal tab",
        );
        assertEqual(
          (store.terminalTabs[0]?.config as any).host,
          "deploy.example.test",
          "detached bootstrap should preserve the SSH config needed to create the runtime",
        );
      } finally {
        (WINDOW_CONTEXT as any).role = originalContext.role;
        (WINDOW_CONTEXT as any).detachedStateToken =
          originalContext.detachedStateToken;
        (WINDOW_CONTEXT as any).sourceClientId = originalContext.sourceClientId;
        (globalThis as any).window = originalWindow;
      }
    },
  );

  await runCase(
    "canClosePanel blocks dirty file editor when user cancels discard",
    async () => {
      const originalWindow = (globalThis as any).window;
      let confirmCalled = 0;
      (globalThis as any).window = {
        confirm: () => {
          confirmCalled += 1;
          return false;
        },
      };
      try {
        const store = new AppStore();
        (store.fileEditor as any).mode = "text";
        (store.fileEditor as any).dirty = true;
        const allowed = store.canClosePanel("fileEditor");
        assertEqual(
          allowed,
          false,
          "dirty editor close should be rejected when user cancels",
        );
        assertEqual(
          confirmCalled,
          1,
          "dirty editor close should ask for confirmation once",
        );
      } finally {
        (globalThis as any).window = originalWindow;
      }
    },
  );

  await runCase(
    "canClosePanel allows close without prompt when editor is clean",
    async () => {
      const originalWindow = (globalThis as any).window;
      let confirmCalled = 0;
      (globalThis as any).window = {
        confirm: () => {
          confirmCalled += 1;
          return true;
        },
      };
      try {
        const store = new AppStore();
        (store.fileEditor as any).mode = "text";
        (store.fileEditor as any).dirty = false;
        const allowed = store.canClosePanel("fileEditor");
        assertEqual(
          allowed,
          true,
          "clean editor close should pass immediately",
        );
        assertEqual(
          confirmCalled,
          0,
          "clean editor close should not prompt for confirmation",
        );
      } finally {
        (globalThis as any).window = originalWindow;
      }
    },
  );

  await runCase(
    "fileSystemTabs inventory includes both local and ssh terminal tabs",
    async () => {
      const store = new AppStore();
      (store.layout as any).syncPanelBindings = () => {};
      store.reconcileTerminalTabs({
        terminals: [
          {
            id: "local-1",
            title: "Local",
            type: "local",
            cols: 80,
            rows: 24,
            runtimeState: "ready",
          },
          {
            id: "ssh-1",
            title: "SSH",
            type: "ssh",
            cols: 120,
            rows: 32,
            runtimeState: "ready",
          },
        ],
      } as any);

      assertEqual(
        store.fileSystemTabs.length,
        2,
        "filesystem inventory should include local and ssh tabs",
      );
      assertCondition(
        store.fileSystemTabs.some((tab) => tab.config.type === "local"),
        "filesystem inventory should include local tab",
      );
      assertCondition(
        store.fileSystemTabs.some((tab) => tab.config.type === "ssh"),
        "filesystem inventory should include ssh tab",
      );
    },
  );

  await runCase(
    "fileSystemTabs inventory excludes terminal-only connection types",
    async () => {
      const store = new AppStore();
      (store.layout as any).syncPanelBindings = () => {};
      store.reconcileTerminalTabs({
        terminals: [
          {
            id: "local-1",
            title: "Local",
            type: "local",
            cols: 80,
            rows: 24,
            runtimeState: "ready",
          },
          {
            id: "serial-1",
            title: "Serial",
            type: "serial",
            cols: 80,
            rows: 24,
            runtimeState: "ready",
          },
        ],
      } as any);

      assertEqual(
        JSON.stringify(store.fileSystemTabs.map((tab) => tab.id)),
        JSON.stringify(["local-1"]),
        "filesystem inventory should include only file-capable terminal tabs",
      );
      assertEqual(
        JSON.stringify(store.getOwnedTabIds("filesystem")),
        JSON.stringify(["local-1"]),
        "filesystem owner ids should exclude terminal-only connection types",
      );
    },
  );

  await runCase(
    "detached getOwnedTabIds filters terminal/filesystem to detached-visible tab set",
    async () => {
      const store = new AppStore();
      (store as any).windowRole = "detached";
      (store as any).detachedVisibleTabIdsByKind = {
        chat: new Set<string>(),
        terminal: new Set<string>(["term-b"]),
        filesystem: new Set<string>(["term-b"]),
      };
      (store as any).suppressedTabIdsByKind = {
        chat: new Set<string>(),
        terminal: new Set<string>(),
        filesystem: new Set<string>(),
      };
      store.terminalTabs = [
        {
          id: "term-a",
          title: "Local A",
          config: {
            type: "local",
            id: "term-a",
            title: "Local A",
            cols: 80,
            rows: 24,
          },
          capabilities: { supportsFilesystem: true, supportsMonitor: true },
          connectionRef: { type: "local" },
          runtimeState: "ready",
        },
        {
          id: "term-b",
          title: "Local B",
          config: {
            type: "local",
            id: "term-b",
            title: "Local B",
            cols: 80,
            rows: 24,
          },
          capabilities: { supportsFilesystem: true, supportsMonitor: true },
          connectionRef: { type: "local" },
          runtimeState: "ready",
        },
      ];
      store.terminalTabsHydrated = true;

      assertEqual(
        JSON.stringify(store.getOwnedTabIds("terminal")),
        JSON.stringify(["term-b"]),
        "detached terminal owner tabs should be constrained to detached-visible set",
      );
      assertEqual(
        JSON.stringify(store.getOwnedTabIds("filesystem")),
        JSON.stringify(["term-b"]),
        "detached filesystem owner tabs should be constrained to detached-visible set",
      );
    },
  );

  await runCase(
    "detached terminal-only tabs do not mirror into filesystem visibility",
    async () => {
      const store = new AppStore();
      (store as any).windowRole = "detached";
      (store as any).detachedVisibleTabIdsByKind = {
        chat: new Set<string>(),
        terminal: new Set<string>(["term-a"]),
        filesystem: new Set<string>(["term-a"]),
      };
      store.terminalTabs = [
        {
          id: "term-a",
          title: "Local A",
          config: {
            type: "local",
            id: "term-a",
            title: "Local A",
            cols: 80,
            rows: 24,
          },
          capabilities: { supportsFilesystem: true, supportsMonitor: true },
          connectionRef: { type: "local" },
          runtimeState: "ready",
        },
        {
          id: "term-b",
          title: "Local B",
          config: {
            type: "serial",
            id: "term-b",
            title: "Local B",
            cols: 80,
            rows: 24,
          },
          capabilities: { supportsFilesystem: false },
          connectionRef: { type: "serial", entryId: "serial-entry" },
          runtimeState: "ready",
        },
      ] as any;
      store.terminalTabsHydrated = true;
      let syncCallCount = 0;
      (store.layout as any).syncPanelBindings = () => {
        syncCallCount += 1;
      };

      store.unsuppressTabs("terminal", ["term-b"]);
      assertEqual(
        JSON.stringify(
          Array.from(
            (
              (store as any).detachedVisibleTabIdsByKind
                .filesystem as Set<string>
            ).values(),
          ),
        ),
        JSON.stringify(["term-a"]),
        "terminal-only tabs should not be mirrored into detached filesystem visibility",
      );
      assertEqual(
        syncCallCount,
        1,
        "unsuppress should still trigger a single layout sync",
      );
    },
  );

  await runCase(
    "detached filesystem visibility still restores known file-capable tabs from persisted layout",
    async () => {
      const store = new AppStore();
      (store as any).windowRole = "detached";
      store.terminalTabs = [
        {
          id: "term-a",
          title: "Local A",
          config: {
            type: "local",
            id: "term-a",
            title: "Local A",
            cols: 80,
            rows: 24,
          },
          capabilities: { supportsFilesystem: true, supportsMonitor: true },
          connectionRef: { type: "local" },
          runtimeState: "ready",
        },
      ];
      const visible = (store as any).collectDetachedVisibleTabIdsByKind({
        schemaVersion: 2,
        root: {
          type: "panel",
          id: "node-fs",
          panel: { id: "panel-fs", kind: "filesystem" },
        },
        panelTabs: {
          "panel-fs": { tabIds: ["term-a"], activeTabId: "term-a" },
        },
      });

      assertEqual(
        JSON.stringify(Array.from(visible.filesystem.values())),
        JSON.stringify(["term-a"]),
        "filesystem panels in detached layouts should preserve file-capable tab visibility",
      );
    },
  );

  await runCase(
    "detached suppress/unsuppress updates detached-visible tab set for terminal/filesystem",
    async () => {
      const store = new AppStore();
      (store as any).windowRole = "detached";
      (store as any).detachedVisibleTabIdsByKind = {
        chat: new Set<string>(),
        terminal: new Set<string>(["term-a"]),
        filesystem: new Set<string>(["term-a"]),
      };
      store.terminalTabs = [
        {
          id: "term-a",
          title: "Local A",
          config: {
            type: "local",
            id: "term-a",
            title: "Local A",
            cols: 80,
            rows: 24,
          },
          capabilities: { supportsFilesystem: true, supportsMonitor: true },
          connectionRef: { type: "local" },
          runtimeState: "ready",
        },
        {
          id: "term-b",
          title: "Local B",
          config: {
            type: "local",
            id: "term-b",
            title: "Local B",
            cols: 80,
            rows: 24,
          },
          capabilities: { supportsFilesystem: true, supportsMonitor: true },
          connectionRef: { type: "local" },
          runtimeState: "ready",
        },
      ];
      store.terminalTabsHydrated = true;
      let syncCallCount = 0;
      (store.layout as any).syncPanelBindings = () => {
        syncCallCount += 1;
      };

      store.unsuppressTabs("terminal", ["term-b"]);
      assertEqual(
        JSON.stringify(store.getOwnedTabIds("terminal")),
        JSON.stringify(["term-a", "term-b"]),
        "unsuppress in detached should make tab visible inside detached terminal owner inventory",
      );
      assertEqual(
        JSON.stringify(store.getOwnedTabIds("filesystem")),
        JSON.stringify(["term-a", "term-b"]),
        "unsuppress in detached should mirror visibility to filesystem owner inventory",
      );

      store.suppressTabs("filesystem", ["term-a"]);
      assertEqual(
        JSON.stringify(store.getOwnedTabIds("terminal")),
        JSON.stringify(["term-b"]),
        "suppress in detached should hide tab from detached terminal owner inventory",
      );
      assertEqual(
        JSON.stringify(store.getOwnedTabIds("filesystem")),
        JSON.stringify(["term-b"]),
        "suppress in detached should hide tab from detached filesystem owner inventory",
      );
      assertCondition(
        syncCallCount >= 2,
        "detached visibility updates should trigger binding sync",
      );
    },
  );

  await runCase(
    "detached new chat sessions become visible to the current window immediately",
    async () => {
      const store = new AppStore();
      (store as any).windowRole = "detached";
      const existingChatIds = store.chat.sessions.map((session) => session.id);
      (store as any).detachedVisibleTabIdsByKind = {
        chat: new Set<string>(existingChatIds),
        terminal: new Set<string>(),
        filesystem: new Set<string>(),
      };
      (store as any).lastKnownChatSessionIds = new Set(existingChatIds);
      let syncCallCount = 0;
      (store.layout as any).syncPanelBindings = () => {
        syncCallCount += 1;
      };

      const sessionId = store.chat.createSession("Detached Chat");

      assertCondition(
        store.getOwnedTabIds("chat").includes(sessionId),
        "new detached chat session should be visible to detached chat owner inventory",
      );
      assertCondition(
        syncCallCount >= 1,
        "new detached chat session should trigger layout binding sync",
      );
    },
  );

  await runCase(
    "ensureTabInventoryEntry materializes missing chat sessions for cross-window drops",
    async () => {
      const store = new AppStore();
      (store as any).windowRole = "detached";
      const existingChatIds = store.chat.sessions.map((session) => session.id);
      (store as any).detachedVisibleTabIdsByKind = {
        chat: new Set<string>(existingChatIds),
        terminal: new Set<string>(),
        filesystem: new Set<string>(),
      };
      (store as any).lastKnownChatSessionIds = new Set(existingChatIds);
      (store.layout as any).syncPanelBindings = () => {};

      store.ensureTabInventoryEntry("chat", "chat-remote-new");

      assertCondition(
        !!store.chat.getSessionById("chat-remote-new"),
        "cross-window chat drop target should create a placeholder session when inventory is missing",
      );
      assertCondition(
        store.getOwnedTabIds("chat").includes("chat-remote-new"),
        "materialized chat session should be immediately visible to detached chat owner inventory",
      );
    },
  );

  await runCase(
    "ensureTabInventoryEntry materializes missing terminal inventory for cross-window drops",
    async () => {
      const store = new AppStore();
      (store as any).terminalTabs = [
        {
          id: "term-existing",
          title: "Remote Terminal",
          config: {
            type: "local",
            id: "term-existing",
            title: "Remote Terminal",
            cols: 80,
            rows: 24,
          },
          capabilities: { supportsFilesystem: true, supportsMonitor: true },
          connectionRef: { type: "local" },
          runtimeState: "ready",
        },
      ];
      (store.layout as any).syncPanelBindings = () => {};

      store.ensureTabInventoryEntry("terminal", "term-remote-new", {
        terminalTab: {
          id: "term-remote-new",
          title: "Remote Terminal",
          config: {
            type: "local",
            id: "term-remote-new",
            title: "Remote Terminal",
            cols: 80,
            rows: 24,
          },
          connectionRef: { type: "local" },
          runtimeState: "ready",
        },
      });

      assertCondition(
        store.getOwnedTabIds("terminal").includes("term-remote-new"),
        "terminal drop target should seed missing terminal inventory before backend onTabsUpdated arrives",
      );
      const materialized = store.terminalTabs.find(
        (tab) => tab.id === "term-remote-new",
      );
      assertEqual(
        materialized?.title,
        "Remote Terminal (1)",
        "transferred terminal placeholder should receive a unique title",
      );
      assertEqual(
        materialized?.config.title,
        "Remote Terminal (1)",
        "transferred terminal placeholder config should use the unique title",
      );
      assertCondition(
        store.getOwnedTabIds("filesystem").includes("term-remote-new"),
        "filesystem owner inventory should see the same shared terminal placeholder",
      );
    },
  );

  await runCase(
    "materializeTransferredTabs restores detached-created chat sessions before unsuppress",
    async () => {
      const store = new AppStore();
      (store.layout as any).syncPanelBindings = () => {};

      const restoredIds = store.materializeTransferredTabs("chat", [
        "chat-detached-new",
        "chat-detached-new",
      ]);

      assertEqual(
        JSON.stringify(restoredIds),
        JSON.stringify(["chat-detached-new"]),
        "materializeTransferredTabs should normalize duplicate transferred chat ids",
      );
      assertCondition(
        !!store.chat.getSessionById("chat-detached-new"),
        "main window should materialize detached-created chat inventory before unsuppressing it back into layout",
      );
    },
  );

  await runCase(
    "materializeTransferredTabs seeds terminal placeholders from payload snapshots",
    async () => {
      const store = new AppStore();
      (store.layout as any).syncPanelBindings = () => {};

      const restoredIds = store.materializeTransferredTabs(
        "filesystem",
        ["term-fs-remote"],
        {
          terminalTabs: [
            {
              id: "term-fs-remote",
              title: "Shared Terminal",
              config: {
                type: "local",
                id: "term-fs-remote",
                title: "Shared Terminal",
                cols: 120,
                rows: 32,
              },
              connectionRef: { type: "local" },
              runtimeState: "ready",
            },
          ],
        },
      );

      assertEqual(
        JSON.stringify(restoredIds),
        JSON.stringify(["term-fs-remote"]),
        "materializeTransferredTabs should normalize transferred terminal ids",
      );
      assertCondition(
        store.getOwnedTabIds("filesystem").includes("term-fs-remote"),
        "filesystem drop target should keep the transferred terminal placeholder visible",
      );
    },
  );

  await runCase(
    "hydrateTransferredTabEntry hydrates chat history without forcing activation",
    async () => {
      const store = new AppStore();
      let hydratedSessionId: string | null = null;
      let hydrateActivate: boolean | undefined;
      let hydrateLoadAgentContext: boolean | undefined;
      (store.chat as any).hydrateSessionFromBackend = async (
        sessionId: string,
        options?: { activate?: boolean; loadAgentContext?: boolean },
      ) => {
        hydratedSessionId = sessionId;
        hydrateActivate = options?.activate;
        hydrateLoadAgentContext = options?.loadAgentContext;
      };

      store.hydrateTransferredTabEntry("chat", "chat-remote-history");

      await Promise.resolve();

      assertCondition(
        !!store.chat.getSessionById("chat-remote-history"),
        "background hydration should still materialize a placeholder chat session first",
      );
      assertEqual(
        hydratedSessionId,
        "chat-remote-history",
        "transferred chat hydration should target the moved session id",
      );
      assertEqual(
        hydrateActivate,
        false,
        "transferred chat hydration should not steal active focus",
      );
      assertEqual(
        hydrateLoadAgentContext,
        false,
        "transferred chat hydration should not switch backend agent context during cross-window drop",
      );
    },
  );

  await runCase(
    "hydrateTransferredTabs hydrates every moved chat session in the background",
    async () => {
      const store = new AppStore();
      const hydratedSessionIds: string[] = [];
      (store.chat as any).hydrateSessionFromBackend = async (
        sessionId: string,
        options?: { activate?: boolean; loadAgentContext?: boolean },
      ) => {
        hydratedSessionIds.push(
          `${sessionId}:${String(options?.activate)}:${String(options?.loadAgentContext)}`,
        );
      };

      store.hydrateTransferredTabs("chat", ["chat-1", "chat-2"]);

      await Promise.resolve();

      assertEqual(
        JSON.stringify(hydratedSessionIds),
        JSON.stringify(["chat-1:false:false", "chat-2:false:false"]),
        "bulk transferred chat hydration should preserve the non-activating background load contract",
      );
    },
  );

  await runCase(
    "openChatSessionFromHistory restores a moved chat session to the current window",
    async () => {
      const loadChatSessionCalls: string[] = [];
      installBootstrapWindowMock(buildPersistedTree(), {
        allChatHistory: [
          { id: "chat-a", title: "Chat A" },
          { id: "chat-b", title: "Chat B" },
          { id: "chat-c", title: "Chat C" },
          { id: "chat-remote", title: "Remote Session" },
        ],
        uiMessagesBySessionId: {
          "chat-remote": [
            {
              id: "msg-remote",
              role: "assistant",
              type: "text",
              content: "Recovered remote message",
              timestamp: 1,
            },
          ],
        },
        runtimeSnapshotsBySessionId: {
          "chat-a": {
            id: "chat-a",
            title: "Chat A",
            isBusy: false,
            lockedProfileId: null,
          },
          "chat-b": {
            id: "chat-b",
            title: "Chat B",
            isBusy: false,
            lockedProfileId: null,
          },
          "chat-c": {
            id: "chat-c",
            title: "Chat C",
            isBusy: false,
            lockedProfileId: null,
          },
          "chat-remote": {
            id: "chat-remote",
            title: "Remote Session",
            isBusy: false,
            lockedProfileId: null,
          },
        },
        loadChatSessionCalls,
      });

      const store = new AppStore();
      await store.bootstrap();

      store.suppressTabs("chat", ["chat-remote"]);
      await store.openChatSessionFromHistory("chat-remote");

      assertEqual(
        store.chat.activeSessionId,
        "chat-remote",
        "history reopen should activate the restored session",
      );
      assertCondition(
        store.getOwnedTabIds("chat").includes("chat-remote"),
        "history reopen should unsuppress the moved chat session",
      );
      assertCondition(
        store.layout
          .getPanelIdsByKind("chat")
          .some((panelId) =>
            store.layout.getPanelTabIds(panelId).includes("chat-remote"),
          ),
        "history reopen should bind the restored chat session back into a chat panel",
      );
      const restoredPanelId = store.layout
        .getPanelIdsByKind("chat")
        .find((panelId) =>
          store.layout.getPanelTabIds(panelId).includes("chat-remote"),
        );
      assertEqual(
        restoredPanelId
          ? store.layout.getPanelActiveTabId(restoredPanelId)
          : null,
        "chat-remote",
        "history reopen should select the restored session in its chat panel",
      );
      assertCondition(
        loadChatSessionCalls.includes("chat-remote"),
        "history reopen should restore backend agent context for the selected session",
      );
    },
  );

  await runCase(
    "bootstrap prunes stale chat session ids from persisted layout inventory",
    async () => {
      const orphanLayoutTree: LayoutTree = {
        schemaVersion: 2,
        root: {
          type: "split",
          id: "root",
          direction: "horizontal",
          children: [
            {
              type: "panel",
              id: "node-chat",
              panel: { id: "panel-chat", kind: "chat" },
            },
            {
              type: "panel",
              id: "node-terminal",
              panel: { id: "panel-terminal", kind: "terminal" },
            },
          ],
          sizes: [50, 50],
        },
        focusedPanelId: "panel-chat",
        panelTabs: {
          "panel-chat": {
            tabIds: ["chat-stale"],
            activeTabId: "chat-stale",
          },
          "panel-terminal": {
            tabIds: ["term-a"],
            activeTabId: "term-a",
          },
        },
      };

      installBootstrapWindowMock(orphanLayoutTree, {
        allChatHistory: [],
        getSessionSnapshot: async (sessionId: string) => {
          if (sessionId === "chat-stale") {
            throw new Error("Session not found: chat-stale");
          }
          return {
            id: sessionId,
            isBusy: false,
            lockedProfileId: null,
          };
        },
      });

      const store = new AppStore();
      await store.bootstrap();

      assertCondition(
        !store.chat.sessions.some((session) => session.id === "chat-stale"),
        "bootstrap should drop stale chat sessions that no longer exist in backend or UI history",
      );
      assertCondition(
        !store.layout
          .getPanelIdsByKind("chat")
          .flatMap((panelId) => store.layout.getPanelTabIds(panelId))
          .includes("chat-stale"),
        "layout sync should remove stale chat session ids after bootstrap pruning",
      );
    },
  );

  await runCase(
    "main suppress terminal should not hide filesystem owner inventory",
    async () => {
      const store = new AppStore();
      (store as any).suppressedTabIdsByKind = {
        chat: new Set<string>(),
        terminal: new Set<string>(),
        filesystem: new Set<string>(),
      };
      store.terminalTabs = [
        {
          id: "term-a",
          title: "Local A",
          config: {
            type: "local",
            id: "term-a",
            title: "Local A",
            cols: 80,
            rows: 24,
          },
          capabilities: { supportsFilesystem: true, supportsMonitor: true },
          connectionRef: { type: "local" },
          runtimeState: "ready",
        },
      ];
      store.terminalTabsHydrated = true;
      (store.layout as any).syncPanelBindings = () => {};

      store.suppressTabs("terminal", ["term-a"]);
      assertEqual(
        JSON.stringify(store.getOwnedTabIds("terminal")),
        JSON.stringify([]),
        "terminal suppression should hide terminal owner tab",
      );
      assertEqual(
        JSON.stringify(store.getOwnedTabIds("filesystem")),
        JSON.stringify(["term-a"]),
        "terminal suppression should not hide filesystem owner tab",
      );
    },
  );

  await runCase(
    "collectAssignedTabsByKind reflects live layout bindings after detach",
    async () => {
      const store = new AppStore();
      (store.layout as any).tree = {
        schemaVersion: 2,
        root: {
          type: "split",
          id: "root",
          direction: "horizontal",
          children: [
            {
              type: "panel",
              id: "node-chat",
              panel: { id: "panel-chat", kind: "chat" },
            },
            {
              type: "panel",
              id: "node-terminal",
              panel: { id: "panel-terminal", kind: "terminal" },
            },
          ],
          sizes: [50, 50],
        },
        focusedPanelId: "panel-terminal",
        panelTabs: {
          "panel-chat": {
            tabIds: ["chat-a"],
            activeTabId: "chat-a",
          },
          "panel-terminal": {
            tabIds: ["term-a", "term-b"],
            activeTabId: "term-a",
          },
        },
      } as LayoutTree;

      assertEqual(
        JSON.stringify(store.collectAssignedTabsByKind()),
        JSON.stringify({
          chat: ["chat-a"],
          terminal: ["term-a", "term-b"],
          filesystem: [],
          monitor: [],
        }),
        "assigned tabs should include currently bound ids",
      );

      store.layout.detachTabFromLayout("terminal", "term-a");
      assertEqual(
        JSON.stringify(store.collectAssignedTabsByKind()),
        JSON.stringify({
          chat: ["chat-a"],
          terminal: ["term-b"],
          filesystem: [],
          monitor: [],
        }),
        "detached tab should not remain in detached-closing payload inventory",
      );
    },
  );

  await runCase(
    "setWsGatewayCustomCidrs commits custom mode only after a non-empty draft",
    async () => {
      const calls: Array<{
        access: string;
        port: number;
        allowedCidrs?: string[];
      }> = [];
      (globalThis as unknown as { window: unknown }).window = {
        gyshell: {
          settings: {
            set: async () => {},
            setWsGatewayConfig: async (ws: {
              access: string;
              port: number;
              allowedCidrs?: string[];
            }) => {
              calls.push(ws);
              return ws;
            },
          },
        },
      };

      const store = new AppStore();
      (store as any).settings = {
        gateway: {
          ws: {
            access: "localhost",
            port: 17888,
            allowedCidrs: [],
          },
        },
      };

      const emptyApplied = await store.setWsGatewayCustomCidrs(" \n ");
      assertEqual(
        emptyApplied,
        false,
        "empty custom draft should not be applied",
      );
      assertEqual(
        calls.length,
        0,
        "empty custom draft should not call the IPC setter",
      );

      const applied = await store.setWsGatewayCustomCidrs(
        "192.168.1.0/24\n10.0.0.0/8",
      );
      assertEqual(applied, true, "non-empty custom draft should be applied");
      assertEqual(
        calls.length,
        1,
        "non-empty custom draft should call the IPC setter once",
      );
      assertEqual(
        calls[0].access,
        "custom",
        "custom draft should switch gateway access mode",
      );
      assertEqual(
        JSON.stringify(calls[0].allowedCidrs),
        JSON.stringify(["192.168.1.0/24", "10.0.0.0/8"]),
        "custom draft should preserve parsed CIDR entries",
      );
    },
  );

  await runCase(
    "setWsGatewayCidrs refuses to clear an active custom filter",
    async () => {
      const calls: Array<{
        access: string;
        port: number;
        allowedCidrs?: string[];
      }> = [];
      (globalThis as unknown as { window: unknown }).window = {
        gyshell: {
          settings: {
            set: async () => {},
            setWsGatewayConfig: async (ws: {
              access: string;
              port: number;
              allowedCidrs?: string[];
            }) => {
              calls.push(ws);
              return ws;
            },
          },
        },
      };

      const store = new AppStore();
      (store as any).settings = {
        gateway: {
          ws: {
            access: "custom",
            port: 17888,
            allowedCidrs: ["192.168.1.0/24"],
          },
        },
      };

      const applied = await store.setWsGatewayCidrs("   ");
      assertEqual(
        applied,
        false,
        "clearing the active custom filter should be rejected",
      );
      assertEqual(
        calls.length,
        0,
        "rejected custom CIDR clear should not call the IPC setter",
      );
    },
  );

  await runCase(
    "monitor sessions follow assigned monitor tabs and stop after the last one closes",
    async () => {
      const startCalls: Array<{ terminalId: string; intervalMs?: number }> = [];
      const stopCalls: string[] = [];
      const subscribeCalls: string[] = [];
      const unsubscribeCalls: string[] = [];
      (globalThis as unknown as { window: unknown }).window = {
        gyshell: {
          settings: {
            set: async () => {},
          },
          monitor: {
            start: async (terminalId: string, intervalMs?: number) => {
              startCalls.push({ terminalId, intervalMs });
              return { ok: true };
            },
            stop: async (terminalId: string) => {
              stopCalls.push(terminalId);
              return { ok: true };
            },
            subscribe: async (terminalId: string) => {
              subscribeCalls.push(terminalId);
              return { ok: true };
            },
            unsubscribe: async (terminalId: string) => {
              unsubscribeCalls.push(terminalId);
              return { ok: true };
            },
            onSnapshot: () => () => {},
          },
        },
      };

      const store = new AppStore();
      (store as any).isBootstrapped = true;
      (store.layout as any).syncPanelBindings = () => {};
      let assignedMonitorTabIds = ["term-a", "term-b"];
      (store as any).collectAssignedTabsByKind = () => ({
        chat: [],
        terminal: [],
        filesystem: [],
        monitor: assignedMonitorTabIds,
      });

      // Pre-enable the monitor sources so sessions will start
      // (new connections default to disabled; restored connections restore their state)
      (store as any).monitorEnabledSources = ["local://default", "term-b"];

      store.reconcileTerminalTabs({
        terminals: [
          {
            id: "term-a",
            title: "Linux A",
            type: "local",
            cols: 80,
            rows: 24,
            runtimeState: "ready",
          },
          {
            id: "term-b",
            title: "SSH B",
            type: "ssh",
            cols: 80,
            rows: 24,
            runtimeState: "ready",
          },
          {
            id: "term-c",
            title: "SSH C",
            type: "ssh",
            cols: 80,
            rows: 24,
            runtimeState: "ready",
          },
        ],
      } as any);
      await Promise.resolve();

      assertEqual(
        JSON.stringify(startCalls),
        JSON.stringify([
          { terminalId: "term-a", intervalMs: 3500 },
          { terminalId: "term-b", intervalMs: 3500 },
        ]),
        "only ready terminals with assigned monitor tabs should retain backend monitor sessions",
      );
      assertEqual(
        JSON.stringify(subscribeCalls),
        JSON.stringify(["term-a", "term-b"]),
        "only assigned monitor tabs should subscribe for snapshot delivery",
      );

      assignedMonitorTabIds = ["term-b"];
      await (store as any).syncMonitorSessions();
      await Promise.resolve();

      assertEqual(
        JSON.stringify(stopCalls),
        JSON.stringify(["term-a"]),
        "closing one monitor tab should release only that tab's backend monitor retention",
      );
      assertEqual(
        JSON.stringify(unsubscribeCalls),
        JSON.stringify(["term-a"]),
        "closing one monitor tab should unsubscribe only that tab",
      );

      assignedMonitorTabIds = [];
      await (store as any).syncMonitorSessions();
      await Promise.resolve();

      assertEqual(
        JSON.stringify(stopCalls),
        JSON.stringify(["term-a", "term-b"]),
        "closing the last monitor tab for a terminal should stop its backend retention",
      );
      assertEqual(
        JSON.stringify(unsubscribeCalls),
        JSON.stringify(["term-a", "term-b"]),
        "closing the last monitor tab should also unsubscribe that terminal snapshot stream",
      );
    },
  );

  await runCase(
    "applyMonitorSnapshot ignores terminals that the current window is not subscribed to",
    async () => {
      const store = new AppStore();
      (store as any).monitorSubscribedTabIds = new Set(["term-a"]);

      (store as any).applyMonitorSnapshot({
        terminalId: "term-b",
        timestamp: 1,
        cpu: { usagePercent: 90 },
      });
      (store as any).applyMonitorSnapshot({
        terminalId: "term-a",
        timestamp: 2,
        cpu: { usagePercent: 30 },
      });

      assertCondition(
        store.getMonitorTerminalState("term-b") === null,
        "unsubscribed monitor snapshots should not allocate window-local state",
      );
      assertEqual(
        store.getMonitorTerminalState("term-a")?.snapshot?.cpu?.usagePercent,
        30,
        "subscribed monitor snapshots should still populate window-local state",
      );
    },
  );

  await runCase(
    "suppressing a monitor tab releases monitor retention even before layout bindings update",
    async () => {
      const originalWindow = (globalThis as unknown as { window?: unknown })
        .window;
      const startCalls: Array<{ terminalId: string; intervalMs?: number }> = [];
      const stopCalls: string[] = [];
      const subscribeCalls: string[] = [];
      const unsubscribeCalls: string[] = [];

      try {
        (globalThis as unknown as { window: unknown }).window = {
          gyshell: {
            settings: {
              set: async () => {},
            },
            monitor: {
              start: async (terminalId: string, intervalMs?: number) => {
                startCalls.push({ terminalId, intervalMs });
                return { ok: true };
              },
              stop: async (terminalId: string) => {
                stopCalls.push(terminalId);
                return { ok: true };
              },
              subscribe: async (terminalId: string) => {
                subscribeCalls.push(terminalId);
                return { ok: true };
              },
              unsubscribe: async (terminalId: string) => {
                unsubscribeCalls.push(terminalId);
                return { ok: true };
              },
              onSnapshot: () => () => {},
            },
          },
        };

        const store = new AppStore();
        (store as any).isBootstrapped = true;
        (store.layout as any).syncPanelBindings = () => {};
        (store as any).collectAssignedTabsByKind = () => ({
          chat: [],
          terminal: [],
          filesystem: [],
          monitor: ["term-a"],
        });
        (store as any).monitorEnabledSources = ["local://default"];

        store.reconcileTerminalTabs({
          terminals: [
            {
              id: "term-a",
              title: "Local A",
              type: "local",
              cols: 80,
              rows: 24,
              runtimeState: "ready",
            },
          ],
        } as any);
        await Promise.resolve();

        assertEqual(
          JSON.stringify(startCalls),
          JSON.stringify([{ terminalId: "term-a", intervalMs: 3500 }]),
          "assigned ready monitor tabs should start a retained backend session",
        );
        assertEqual(
          JSON.stringify(subscribeCalls),
          JSON.stringify(["term-a"]),
          "assigned ready monitor tabs should subscribe before suppression",
        );

        store.suppressTabs("monitor", ["term-a"], { syncLayout: false });
        await Promise.resolve();

        assertEqual(
          JSON.stringify(stopCalls),
          JSON.stringify(["term-a"]),
          "suppressed monitor tabs should stop backend retention immediately even before layout mutation",
        );
        assertEqual(
          JSON.stringify(unsubscribeCalls),
          JSON.stringify(["term-a"]),
          "suppressed monitor tabs should unsubscribe immediately even before layout mutation",
        );
      } finally {
        (globalThis as unknown as { window?: unknown }).window = originalWindow;
      }
    },
  );

  await runCase(
    "applyMonitorSnapshot keeps bounded histories per terminal",
    async () => {
      const store = new AppStore();
      (store as any).monitorSubscribedTabIds = new Set(["term-a"]);
      for (let index = 0; index < 80; index += 1) {
        (store as any).applyMonitorSnapshot({
          terminalId: "term-a",
          timestamp: index,
          cpu: { usagePercent: index },
          memory: {
            usagePercent: index,
            totalBytes: 100,
            usedBytes: 50,
            availableBytes: 50,
          },
          network: [
            {
              interface: "eth0",
              rxBytesPerSec: index * 10,
              txBytesPerSec: index * 5,
            },
          ],
        });
      }

      const state = store.getMonitorTerminalState("term-a");
      assertCondition(
        state !== null,
        "monitor state should exist after applying snapshots",
      );
      assertEqual(
        state!.cpuHistory.length,
        64,
        "cpu history should be bounded",
      );
      assertEqual(
        state!.memoryHistory.length,
        64,
        "memory history should be bounded",
      );
      assertEqual(state!.rxHistory.length, 64, "rx history should be bounded");
      assertEqual(state!.txHistory.length, 64, "tx history should be bounded");
      assertEqual(
        state!.cpuHistory[0],
        16,
        "history should retain the most recent values",
      );
      assertEqual(
        state!.cpuHistory[63],
        79,
        "history tail should match the latest snapshot",
      );
    },
  );

  await runCase(
    "setPanelTabDisplayMode updates local settings and persists through uiSettings IPC",
    async () => {
      const originalWindow = (globalThis as any).window;
      const uiSettingsSetCalls: any[] = [];

      try {
        (globalThis as any).window = {
          gyshell: {
            uiSettings: {
              set: async (payload: any) => {
                uiSettingsSetCalls.push(payload);
              },
            },
          },
        };

        const store = new AppStore();
        (store as any).settings = {
          panelTabs: {
            displayMode: "auto",
          },
        };

        await store.setPanelTabDisplayMode("select");

        assertEqual(
          store.panelTabDisplayMode,
          "select",
          "panel tab display mode getter should reflect the latest UI preference",
        );
        assertEqual(
          JSON.stringify(uiSettingsSetCalls),
          JSON.stringify([
            {
              panelTabs: {
                displayMode: "select",
              },
            },
          ]),
          "panel tab display mode should persist through the uiSettings IPC channel",
        );
      } finally {
        (globalThis as any).window = originalWindow;
      }
    },
  );

  await runCase(
    "openDetachedFileEditorForPath stashes a loading editor snapshot for the new window",
    async () => {
      const originalWindow = (globalThis as any).window;
      const localStorageState = new Map<string, string>();
      const sessionStorageState = new Map<string, string>();
      const openDetachedCalls: Array<{
        token: string;
        sourceClientId: string;
      }> = [];

      try {
        (globalThis as any).window = {
          localStorage: createStorage(localStorageState),
          sessionStorage: createStorage(sessionStorageState),
          gyshell: {
            windowing: {
              openDetached: async (token: string, sourceClientId: string) => {
                openDetachedCalls.push({ token, sourceClientId });
                return { ok: true };
              },
            },
          },
        };

        const store = new AppStore();
        const opened = await store.openDetachedFileEditorForPath(
          "term-a",
          "/tmp/demo.txt",
        );

        assertEqual(
          opened,
          true,
          "detached file editor open should succeed when IPC open succeeds",
        );
        assertEqual(
          openDetachedCalls.length,
          1,
          "detached file editor should request exactly one window",
        );
        assertEqual(
          openDetachedCalls[0].sourceClientId,
          store.windowClientId,
          "detached file editor should forward the current renderer client id",
        );

        const detachedState = readDetachedWindowState(
          openDetachedCalls[0].token,
        );
        assertCondition(
          detachedState !== null,
          "detached file editor should stash a detached window state",
        );
        assertEqual(
          detachedState!.sourceClientId,
          store.windowClientId,
          "detached file editor state should preserve the source client id",
        );
        assertCondition(
          detachedState!.layoutTree.root.type === "panel",
          "detached file editor should use a single-panel layout",
        );
        if (detachedState!.layoutTree.root.type !== "panel") {
          throw new Error("detached file editor layout root should be a panel");
        }
        assertEqual(
          detachedState!.layoutTree.root.panel.kind,
          "fileEditor",
          "detached file editor layout should target the fileEditor panel kind",
        );
        assertEqual(
          JSON.stringify(detachedState!.fileEditorSnapshot),
          JSON.stringify({
            terminalId: "term-a",
            filePath: "/tmp/demo.txt",
            mode: "loading",
            content: "",
            dirty: false,
            errorMessage: null,
            statusMessage: null,
          }),
          "detached file editor should seed the loading snapshot for the requested path",
        );
      } finally {
        (globalThis as any).window = originalWindow;
      }
    },
  );

  await runCase(
    "resolveMonitorSourceKey groups local terminals under the same key",
    async () => {
      const store = new AppStore();
      const localA = {
        id: "local-a",
        title: "Local A",
        config: { type: "local" },
        capabilities: { supportsMonitor: true },
      } as any;
      const localB = {
        id: "local-b",
        title: "Local B",
        config: { type: "local" },
        capabilities: { supportsMonitor: true },
      } as any;

      const keyA = store.resolveMonitorSourceKey(localA);
      const keyB = store.resolveMonitorSourceKey(localB);
      assertEqual(
        keyA,
        "local://default",
        "local terminals should resolve to the shared local monitor identity",
      );
      assertEqual(
        keyA,
        keyB,
        "all local terminals should share the same source key",
      );
    },
  );

  await runCase(
    "resolveMonitorSourceKey groups ssh terminals by monitorIdentity",
    async () => {
      const store = new AppStore();
      const sshA = {
        id: "ssh-1",
        title: "SSH A",
        config: { type: "ssh" },
        capabilities: { supportsMonitor: true },
        monitorIdentity: "ssh://admin@10.0.0.1:22",
      } as any;
      const sshB = {
        id: "ssh-2",
        title: "SSH B",
        config: { type: "ssh" },
        capabilities: { supportsMonitor: true },
        monitorIdentity: "ssh://admin@10.0.0.1:22",
      } as any;
      const sshC = {
        id: "ssh-3",
        title: "SSH C",
        config: { type: "ssh" },
        capabilities: { supportsMonitor: true },
        monitorIdentity: "ssh://root@10.0.0.2:22",
      } as any;

      const keyA = store.resolveMonitorSourceKey(sshA);
      const keyB = store.resolveMonitorSourceKey(sshB);
      const keyC = store.resolveMonitorSourceKey(sshC);
      assertEqual(
        keyA,
        "ssh://admin@10.0.0.1:22",
        "ssh source key should be the monitorIdentity",
      );
      assertEqual(
        keyA,
        keyB,
        "same monitorIdentity should produce the same source key",
      );
      assertCondition(
        keyA !== keyC,
        "different monitorIdentities should produce different source keys",
      );
    },
  );

  await runCase(
    "resolveMonitorSourceKey derives ssh identity before monitorIdentity hydration",
    async () => {
      const store = new AppStore();
      const sshPending = {
        id: "ssh-pending",
        title: "SSH Pending",
        config: {
          type: "ssh",
          host: "Example.COM",
          port: 22,
          username: "Admin",
        },
        capabilities: { supportsMonitor: true },
        connectionRef: { type: "ssh", entryId: "conn-abc" },
      } as any;

      const key = store.resolveMonitorSourceKey(sshPending);
      assertEqual(
        key,
        "ssh://admin@example.com:22",
        "ssh placeholders should derive the canonical monitor identity before hydration",
      );
    },
  );

  await runCase(
    "resolveMonitorSourceKey prefers monitorIdentity over connectionRef.entryId",
    async () => {
      const store = new AppStore();
      const sshWithBoth = {
        id: "ssh-1",
        title: "SSH Both",
        config: { type: "ssh" },
        capabilities: { supportsMonitor: true },
        connectionRef: { type: "ssh", entryId: "conn-abc" },
        monitorIdentity: "ssh://admin@10.0.0.1:22",
      } as any;

      const key = store.resolveMonitorSourceKey(sshWithBoth);
      assertEqual(
        key,
        "ssh://admin@10.0.0.1:22",
        "monitorIdentity should take priority over connectionRef.entryId",
      );
    },
  );

  await runCase(
    "resolveMonitorSourceKey falls back to terminal id when ssh has no identity",
    async () => {
      const store = new AppStore();
      const sshNoEntry = {
        id: "ssh-orphan",
        title: "SSH Orphan",
        config: { type: "ssh" },
        capabilities: { supportsMonitor: true },
      } as any;

      const key = store.resolveMonitorSourceKey(sshNoEntry);
      assertEqual(
        key,
        "ssh-orphan",
        "ssh without monitorIdentity or entryId should fall back to terminal id",
      );
    },
  );

  await runCase(
    "setMonitorEnabled toggles the source key in monitorEnabledSources",
    async () => {
      const originalWindow = (globalThis as any).window;
      (globalThis as any).window = {
        gyshell: {
          uiSettings: { set: async () => {} },
          monitor: {
            start: async () => ({ ok: true }),
            stop: async () => ({ ok: true }),
            subscribe: async () => ({ ok: true }),
            unsubscribe: async () => ({ ok: true }),
            onSnapshot: () => () => {},
          },
        },
      };
      try {
        const store = new AppStore();
        (store as any).terminalTabs = [
          {
            id: "local-a",
            title: "Local A",
            config: { type: "local" },
            capabilities: { supportsMonitor: true },
            connectionRef: { type: "local" },
            runtimeState: "ready",
          },
          {
            id: "ssh-1",
            title: "SSH Win",
            config: { type: "ssh" },
            capabilities: { supportsMonitor: true },
            connectionRef: { type: "ssh", entryId: "conn-win" },
            runtimeState: "ready",
          },
        ];

        assertEqual(
          store.isMonitorSourceEnabled("local-a"),
          false,
          "new terminals should default to disabled",
        );

        store.setMonitorEnabled("local-a", true);
        assertEqual(
          store.isMonitorSourceEnabled("local-a"),
          true,
          "enabling should update the source state",
        );
        assertEqual(
          store.monitorEnabledSources.includes("local://default"),
          true,
          "local source key should be in enabled list",
        );

        store.setMonitorEnabled("local-a", false);
        assertEqual(
          store.isMonitorSourceEnabled("local-a"),
          false,
          "disabling should remove the source from enabled list",
        );

        store.setMonitorEnabled("ssh-1", true);
        assertEqual(
          store.isMonitorSourceEnabled("ssh-1"),
          true,
          "ssh source should be independently toggleable",
        );
        assertEqual(
          store.isMonitorSourceEnabled("local-a"),
          false,
          "local should remain disabled when ssh is enabled",
        );
      } finally {
        (globalThis as any).window = originalWindow;
      }
    },
  );

  await runCase(
    "monitorEnabledSources stay enabled when monitorIdentity arrives after hydration",
    async () => {
      const originalWindow = (globalThis as any).window;
      (globalThis as any).window = {
        gyshell: {
          uiSettings: { set: async () => {} },
          monitor: {
            start: async () => ({ ok: true }),
            stop: async () => ({ ok: true }),
            subscribe: async () => ({ ok: true }),
            unsubscribe: async () => ({ ok: true }),
            onSnapshot: () => () => {},
          },
        },
      };
      try {
        const store = new AppStore();
        (store as any).isBootstrapped = true;
        (store.layout as any).syncPanelBindings = () => {};
        (store as any).collectAssignedTabsByKind = () => ({
          chat: [],
          terminal: [],
          filesystem: [],
          monitor: ["ssh-pending"],
        });
        (store as any).terminalTabs = [
          {
            id: "ssh-pending",
            title: "SSH Pending",
            config: {
              type: "ssh",
              host: "Example.COM",
              port: 22,
              username: "Admin",
            },
            capabilities: { supportsMonitor: true },
            connectionRef: { type: "ssh", entryId: "conn-abc" },
            runtimeState: "initializing",
          },
        ];

        store.setMonitorEnabled("ssh-pending", true);
        assertEqual(
          JSON.stringify(store.monitorEnabledSources),
          JSON.stringify(["ssh://admin@example.com:22"]),
          "pre-hydration monitor state should be stored under the canonical source key",
        );

        store.reconcileTerminalTabs({
          terminals: [
            {
              id: "ssh-pending",
              title: "SSH Pending",
              type: "ssh",
              cols: 80,
              rows: 24,
              runtimeState: "ready",
              monitorIdentity: "ssh://admin@example.com:22",
            },
          ],
        } as any);

        assertEqual(
          store.isMonitorSourceEnabled("ssh-pending"),
          true,
          "hydration should not pause a source that was already enabled",
        );
      } finally {
        (globalThis as any).window = originalWindow;
      }
    },
  );

  await runCase(
    "monitor sessions retain a ready sibling for an enabled initializing source tab",
    async () => {
      const originalWindow = (globalThis as unknown as { window?: unknown })
        .window;
      const startCalls: Array<{ terminalId: string; intervalMs?: number }> = [];
      const subscribeCalls: string[] = [];

      try {
        (globalThis as unknown as { window: unknown }).window = {
          gyshell: {
            settings: {
              set: async () => {},
            },
            uiSettings: {
              set: async () => {},
            },
            monitor: {
              start: async (terminalId: string, intervalMs?: number) => {
                startCalls.push({ terminalId, intervalMs });
                return { ok: true };
              },
              stop: async () => ({ ok: true }),
              subscribe: async (terminalId: string) => {
                subscribeCalls.push(terminalId);
                return { ok: true };
              },
              unsubscribe: async () => ({ ok: true }),
              onSnapshot: () => () => {},
            },
          },
        };

        const store = new AppStore();
        (store as any).isBootstrapped = true;
        (store.layout as any).syncPanelBindings = () => {};
        (store as any).collectAssignedTabsByKind = () => ({
          chat: [],
          terminal: [],
          filesystem: [],
          monitor: ["local-b"],
        });
        (store as any).monitorEnabledSources = ["local://default"];

        store.reconcileTerminalTabs({
          terminals: [
            {
              id: "local-a",
              title: "Local A",
              type: "local",
              cols: 80,
              rows: 24,
              runtimeState: "ready",
              monitorIdentity: "local://default",
            },
            {
              id: "local-b",
              title: "Local B",
              type: "local",
              cols: 80,
              rows: 24,
              runtimeState: "initializing",
              monitorIdentity: "local://default",
            },
          ],
        } as any);
        await Promise.resolve();

        assertEqual(
          JSON.stringify(startCalls),
          JSON.stringify([
            { terminalId: "local-a", intervalMs: 3500 },
            { terminalId: "local-b", intervalMs: 3500 },
          ]),
          "an enabled source should retain a ready sibling first, then the assigned owner tab",
        );
        assertEqual(
          JSON.stringify(subscribeCalls),
          JSON.stringify(["local-b"]),
          "only the assigned monitor tab should subscribe for snapshot delivery",
        );
      } finally {
        (globalThis as unknown as { window?: unknown }).window = originalWindow;
      }
    },
  );

  await runCase(
    "setMonitorEnabled links all terminals sharing the same source key",
    async () => {
      const originalWindow = (globalThis as any).window;
      (globalThis as any).window = {
        gyshell: {
          uiSettings: { set: async () => {} },
          monitor: {
            start: async () => ({ ok: true }),
            stop: async () => ({ ok: true }),
            subscribe: async () => ({ ok: true }),
            unsubscribe: async () => ({ ok: true }),
            onSnapshot: () => () => {},
          },
        },
      };
      try {
        const store = new AppStore();
        (store as any).terminalTabs = [
          {
            id: "ssh-a",
            title: "SSH A",
            config: { type: "ssh" },
            capabilities: { supportsMonitor: true },
            monitorIdentity: "ssh://admin@10.0.0.1:22",
            runtimeState: "ready",
          },
          {
            id: "ssh-b",
            title: "SSH B",
            config: { type: "ssh" },
            capabilities: { supportsMonitor: true },
            monitorIdentity: "ssh://admin@10.0.0.1:22",
            runtimeState: "ready",
          },
          {
            id: "ssh-c",
            title: "SSH C",
            config: { type: "ssh" },
            capabilities: { supportsMonitor: true },
            monitorIdentity: "ssh://root@10.0.0.2:22",
            runtimeState: "ready",
          },
        ];

        store.setMonitorEnabled("ssh-a", true);
        assertEqual(
          store.isMonitorSourceEnabled("ssh-b"),
          true,
          "ssh-b should be linked to ssh-a via shared monitorIdentity",
        );
        assertEqual(
          store.isMonitorSourceEnabled("ssh-c"),
          false,
          "ssh-c should remain independent (different monitorIdentity)",
        );

        store.setMonitorEnabled("ssh-b", false);
        assertEqual(
          store.isMonitorSourceEnabled("ssh-a"),
          false,
          "disabling via ssh-b should also disable ssh-a (same source)",
        );
      } finally {
        (globalThis as any).window = originalWindow;
      }
    },
  );

  await runCase(
    "monitorEnabledSources restores from persisted settings array",
    async () => {
      const store = new AppStore();
      const persisted = ["local://default", "ssh://admin@win-server:22"];
      (store as any).monitorEnabledSources = persisted;
      (store as any).terminalTabs = [
        {
          id: "local-a",
          title: "Local A",
          config: { type: "local" },
          capabilities: { supportsMonitor: true },
          monitorIdentity: "local://default",
          runtimeState: "ready",
        },
        {
          id: "ssh-1",
          title: "SSH Win",
          config: { type: "ssh" },
          capabilities: { supportsMonitor: true },
          monitorIdentity: "ssh://admin@win-server:22",
          runtimeState: "ready",
        },
        {
          id: "ssh-2",
          title: "SSH LA",
          config: { type: "ssh" },
          capabilities: { supportsMonitor: true },
          monitorIdentity: "ssh://user@la-server:22",
          runtimeState: "ready",
        },
      ];

      assertEqual(
        store.isMonitorSourceEnabled("local-a"),
        true,
        "restored local source should be enabled",
      );
      assertEqual(
        store.isMonitorSourceEnabled("ssh-1"),
        true,
        "restored ssh source should be enabled",
      );
      assertEqual(
        store.isMonitorSourceEnabled("ssh-2"),
        false,
        "non-restored ssh source should remain disabled",
      );
    },
  );
};

void run()
  .then(() => {
    console.log("All AppStore extreme tests passed.");
  })
  .catch((error) => {
    console.error(error);
    throw error;
  });
