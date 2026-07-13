import path from "node:path";
import process from "node:process";
import { TerminalService } from "../../services/TerminalService";
import { FileSystemService } from "../../services/FileSystemService";
import { FileTransferService } from "../../services/FileTransferService";
import { AgentService_v2 } from "../../services/AgentService_v2";
import { UIHistoryService } from "../../services/UIHistoryService";
import { ChatHistoryService } from "../../services/ChatHistoryService";
import { GatewayService } from "../../services/Gateway/GatewayService";
import { WebSocketGatewayAdapter } from "../../services/Gateway/WebSocketGatewayAdapter";
import {
  WebSocketGatewayControlService,
  resolveWsGatewayAccessFromHost,
  resolveWsGatewayPolicyFromEnv,
} from "../../services/Gateway/WebSocketGatewayControlService";
import { NodeSettingsService } from "../../adapters/node/NodeSettingsService";
import { NodeCommandPolicyService } from "../../adapters/node/NodeCommandPolicyService";
import { NodeMcpToolService } from "../../adapters/node/NodeMcpToolService";
import { NodeSkillService } from "../../adapters/node/NodeSkillService";
import { NodeMemoryService } from "../../adapters/node/NodeMemoryService";
import { NodeAccessTokenService } from "../../adapters/node/NodeAccessTokenService";
import { ModelCapabilityService } from "../../services/ModelCapabilityService";
import {
  buildBuiltInToolStatusSummary,
  buildSkillStatusSummary,
} from "../../services/Gateway/toolingSummary";
import { ImageAttachmentService } from "../../services/ImageAttachmentService";
import { TerminalStateStore } from "../../services/terminal/TerminalStateStore";
import { createAutoTerminalConfig } from "../../services/terminal/terminalConnectionSupport";
import { TerminalCommandDraftService } from "../../services/TerminalCommandDraftService";
import { HistoryStorageMigration } from "../../services/history/HistoryStorageMigration";
import { HistorySqliteStore } from "../../services/history/HistorySqliteStore";
import { AgentSettingProfileService } from "../../services/AgentSettingProfileService";
import {
  isExperimentalToolConfirmationRequired,
} from "../../services/settings/experimentalToolConsent";

function boolFromEnv(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (!raw) return fallback;
  return /^(1|true|yes|on)$/i.test(raw);
}

function numberFromEnv(name: string, fallback: number): number {
  const raw = Number(process.env[name] || "");
  if (!Number.isInteger(raw) || raw <= 0 || raw >= 65536) {
    return fallback;
  }
  return raw;
}

function resolveDataDir(): string {
  const custom = (process.env.GYBACKEND_DATA_DIR || "").trim();
  if (custom) {
    return path.resolve(custom);
  }
  return path.join(process.cwd(), ".gybackend-data");
}

export async function startGyBackend(): Promise<void> {
  const dataDir = resolveDataDir();
  process.env.GYSHELL_STORE_DIR = dataDir;
  const historyMigration = new HistoryStorageMigration({ baseDir: dataDir });
  await historyMigration.run();
  const defaultHost =
    (process.env.GYBACKEND_WS_HOST || "0.0.0.0").trim() || "0.0.0.0";
  const defaultPort = numberFromEnv("GYBACKEND_WS_PORT", 17888);
  const startupPolicy = resolveWsGatewayPolicyFromEnv({
    env: process.env,
    defaultPolicy: {
      access: resolveWsGatewayAccessFromHost(defaultHost),
      port: defaultPort,
      hostOverride: defaultHost,
    },
    enableVarName: "GYBACKEND_WS_ENABLE",
    hostVarName: "GYBACKEND_WS_HOST",
    portVarName: "GYBACKEND_WS_PORT",
  });
  const bootstrapLocalTerminal = boolFromEnv(
    "GYBACKEND_BOOTSTRAP_LOCAL_TERMINAL",
    true,
  );

  const settingsService = new NodeSettingsService(dataDir);
  const commandPolicyService = new NodeCommandPolicyService(dataDir);
  const mcpToolService = new NodeMcpToolService(dataDir);
  const skillService = new NodeSkillService(dataDir, settingsService);
  const memoryService = new NodeMemoryService(dataDir);
  const accessTokenService = new NodeAccessTokenService(dataDir);
  const modelCapabilityService = new ModelCapabilityService();
  const imageAttachmentService = new ImageAttachmentService(dataDir);

  const terminalStateStore = new TerminalStateStore(
    path.join(dataDir, "terminal-tabs-state.json"),
  );
  const terminalService = new TerminalService({
    terminalStateStore,
  });
  const fileSystemService = new FileSystemService(terminalService);
  const fileTransferService = new FileTransferService(
    fileSystemService,
    terminalService,
  );
  const historyStore = new HistorySqliteStore();
  process.once("exit", () => {
    terminalService.flushPersistedState();
    historyStore.close();
  });
  const uiHistoryService = new UIHistoryService({ store: historyStore });
  const chatHistoryService = new ChatHistoryService({ store: historyStore });
  const agentService = new AgentService_v2(
    terminalService,
    commandPolicyService,
    mcpToolService,
    skillService,
    memoryService,
    uiHistoryService,
    chatHistoryService,
    imageAttachmentService,
    fileTransferService,
  );
  const agentSettingProfileService = new AgentSettingProfileService({
    settingsService,
    commandPolicyService,
    mcpToolService,
    skillService,
    memoryService,
    onSettingsChanged: (settings) => agentService.updateSettings(settings),
  });

  const gatewayService = new GatewayService(
    terminalService,
    agentService,
    uiHistoryService,
    commandPolicyService,
    settingsService,
    mcpToolService,
  );
  fileTransferService.setRawEventPublisher((channel, data) =>
    gatewayService.broadcastRaw(channel, data),
  );
  const terminalCommandDraftService = new TerminalCommandDraftService(
    terminalService,
    settingsService,
  );

  const terminalRestoreResult =
    await terminalService.restorePersistedTerminals();
  if (
    terminalRestoreResult.restored.length > 0 ||
    terminalRestoreResult.failed.length > 0
  ) {
    console.log(
      `[gybackend] Terminal restore completed. restored=${terminalRestoreResult.restored.length} failed=${terminalRestoreResult.failed.length}`,
    );
    if (terminalRestoreResult.failed.length > 0) {
      terminalRestoreResult.failed.forEach((item) => {
        console.warn(
          `[gybackend] Terminal restore failed for ${item.id}: ${item.reason}`,
        );
      });
    }
  }

  agentService.updateSettings(settingsService.getSettings());
  await skillService.reload();
  await mcpToolService.reloadAll();

  if (
    bootstrapLocalTerminal &&
    terminalService.getDisplayTerminals().length === 0
  ) {
    const terminalId = process.env.GYBACKEND_TERMINAL_ID || "local-main";
    const terminalTitle = process.env.GYBACKEND_TERMINAL_TITLE || "Local";
    const terminalCwd = process.env.GYBACKEND_TERMINAL_CWD;
    const terminalShell = process.env.GYBACKEND_TERMINAL_SHELL;

    try {
      await terminalService.createTerminal({
        type: "local",
        id: terminalId,
        title: terminalTitle,
        cols: 120,
        rows: 32,
        cwd: terminalCwd,
        shell: terminalShell,
      });
      console.log(`[gybackend] Bootstrapped terminal: ${terminalId}`);
    } catch (error) {
      console.warn("[gybackend] Failed to bootstrap default terminal:", error);
    }
  }

  const broadcastAgentSettingResult = (result: {
    settings: unknown;
    commandPolicyLists: unknown;
    mcpTools: unknown;
    builtInTools: unknown;
    skills: unknown;
    memory: unknown;
  }) => {
    gatewayService.broadcastRaw("settings:updated", result.settings);
    gatewayService.broadcastRaw(
      "settings:commandPolicyListsUpdated",
      result.commandPolicyLists,
    );
    gatewayService.broadcastRaw("tools:mcpUpdated", result.mcpTools);
    gatewayService.broadcastRaw("tools:builtInUpdated", result.builtInTools);
    gatewayService.broadcastRaw("skills:updated", result.skills);
    gatewayService.broadcastRaw("memory:updated", result.memory);
  };

  const wsGatewayControlService = new WebSocketGatewayControlService({
    createAdapter: (host, port, ipFilter) =>
      new WebSocketGatewayAdapter(gatewayService, {
        host,
        port,
        accessTokenAuth: {
          verifyToken: (token: string) => accessTokenService.verifyToken(token),
          allowLocalhostWithoutToken: true,
        },
        ipFilter,
        terminalBridge: {
          listTerminals: () =>
            terminalService.getDisplayTerminals().map((terminal) => ({
              id: terminal.id,
              title: terminal.title,
              type: terminal.type,
              cols: terminal.cols,
              rows: terminal.rows,
              runtimeState: terminal.runtimeState,
              lastExitCode: terminal.lastExitCode,
              monitorIdentity:
                terminalService.getMonitorIdentity(terminal.id) ?? undefined,
            })),
          createTab: async (config) => {
            const snapshot = terminalService.getDisplayTerminals();
            const normalized = createAutoTerminalConfig(snapshot, config);
            const tab = await terminalService.createTerminal(normalized as any);
            return { id: tab.id };
          },
          write: async (terminalId, data) => {
            terminalService.write(terminalId, data);
          },
          writePaths: async (terminalId, paths) => {
            terminalService.writePaths(terminalId, paths);
          },
          resize: async (terminalId, cols, rows) => {
            terminalService.resize(terminalId, cols, rows);
          },
          kill: async (terminalId) => {
            if (terminalService.getDisplayTerminals().length <= 1) {
              throw new Error("Cannot close the last terminal tab.");
            }
            terminalService.kill(terminalId);
          },
          reconnect: async (terminalId) => {
            const tab = await terminalService.reconnectTerminal(terminalId);
            return { id: tab.id };
          },
          setSelection: async (terminalId, selectionText) => {
            terminalService.setSelection(terminalId, selectionText);
          },
          getBufferDelta: async (terminalId, fromOffset) => {
            const data = terminalService.getBufferDelta(terminalId, fromOffset);
            const offset = terminalService.getCurrentOffset(terminalId);
            return {
              data,
              offset,
              ...terminalService.getRenderMetadata(terminalId),
            };
          },
          generateCommandDraft: async (terminalId, prompt, profileId) => {
            return await terminalCommandDraftService.generateCommandDraft({
              terminalId,
              prompt,
              profileId,
            });
          },
        },
        filesystemBridge: {
          listDirectory: async (terminalId, dirPath) => {
            return await fileSystemService.listDirectory(terminalId, dirPath);
          },
          readTextFile: async (terminalId, filePath, options) => {
            return await fileSystemService.readTextFile(
              terminalId,
              filePath,
              options,
            );
          },
          readFileBase64: async (terminalId, filePath, options) => {
            return await fileSystemService.readFileBase64(
              terminalId,
              filePath,
              options,
            );
          },
          writeTextFile: async (terminalId, filePath, content) => {
            await fileSystemService.writeTextFile(
              terminalId,
              filePath,
              content,
            );
          },
          writeFileBase64: async (
            terminalId,
            filePath,
            contentBase64,
            options,
          ) => {
            await fileSystemService.writeFileBase64(
              terminalId,
              filePath,
              contentBase64,
              options,
            );
          },
          transferEntries: async (
            sourceTerminalId,
            sourcePaths,
            targetTerminalId,
            targetDirPath,
            options,
          ) => {
            return await fileSystemService.transferEntries(
              sourceTerminalId,
              sourcePaths,
              targetTerminalId,
              targetDirPath,
              options,
            );
          },
          startTransfer: async (input) => {
            return fileTransferService.startTransfer(input);
          },
          getTransfer: async (transferId) => {
            return fileTransferService.getTransfer(transferId);
          },
          listTransfers: async (options) => {
            return fileTransferService.listTransfers(options);
          },
          cancelTransfer: async (transferId) => {
            return fileTransferService.cancelTransfer(transferId);
          },
          cancelTransferTask: async (transferId) => {
            return fileTransferService.cancelTransfer(transferId);
          },
          createDirectory: async (terminalId, dirPath) => {
            await fileSystemService.createDirectory(terminalId, dirPath);
          },
          createFile: async (terminalId, filePath) => {
            await fileSystemService.createFile(terminalId, filePath);
          },
          deletePath: async (terminalId, targetPath, options) => {
            await fileSystemService.deletePath(terminalId, targetPath, options);
          },
          renamePath: async (terminalId, sourcePath, targetPath) => {
            await fileSystemService.renamePath(
              terminalId,
              sourcePath,
              targetPath,
            );
          },
        },
        profileBridge: {
          getProfiles: () => {
            const snapshot = settingsService.getSettings();
            const modelNameById = new Map(
              snapshot.models.items.map((item) => [item.id, item.model]),
            );
            return {
              activeProfileId: snapshot.models.activeProfileId,
              profiles: snapshot.models.profiles.map((profile) => ({
                id: profile.id,
                name: profile.name,
                globalModelId: profile.globalModelId,
                modelName: modelNameById.get(profile.globalModelId),
              })),
            };
          },
          setActiveProfile: (profileId: string) => {
            const snapshot = settingsService.getSettings();
            const exists = snapshot.models.profiles.some(
              (profile) => profile.id === profileId,
            );
            if (!exists) {
              throw new Error(`Profile not found: ${profileId}`);
            }

            settingsService.setSettings({
              models: {
                items: snapshot.models.items,
                profiles: snapshot.models.profiles,
                activeProfileId: profileId,
              },
            });

            const next = settingsService.getSettings();
            agentService.updateSettings(next);

            const modelNameById = new Map(
              next.models.items.map((item) => [item.id, item.model]),
            );
            return {
              activeProfileId: next.models.activeProfileId,
              profiles: next.models.profiles.map((profile) => ({
                id: profile.id,
                name: profile.name,
                globalModelId: profile.globalModelId,
                modelName: modelNameById.get(profile.globalModelId),
              })),
            };
          },
          probeModel: async (model: any) => {
            return await modelCapabilityService.probe(model);
          },
        },
        agentBridge: {
          exportHistory: async (sessionId, mode) => {
            await gatewayService.waitForRunCompletion(sessionId);
            const backendSession = agentService.exportChatSession(sessionId);
            if (!backendSession) {
              throw new Error(`Session with ID ${sessionId} not found`);
            }
            const uiSession = uiHistoryService.getSession(sessionId);
            if (mode === "simple") {
              const markdown = uiHistoryService.toReadableMarkdown(
                uiSession?.messages || [],
                uiSession?.title || backendSession.title,
              );
              return {
                sessionId,
                mode,
                title: uiSession?.title || backendSession.title,
                content: markdown,
              };
            }
            return {
              sessionId: backendSession.id,
              mode,
              title: uiSession?.title || backendSession.title,
              lastCheckpointOffset: backendSession.lastCheckpointOffset,
              createdAt: new Date(backendSession.createdAt).toISOString(),
              updatedAt: new Date(backendSession.updatedAt).toISOString(),
              frontendMessages: uiSession?.messages || [],
              backendMessages: backendSession.messages.map((msg: any) => ({
                messageId: msg.id,
                messageType: msg.type,
                messageData: msg.data,
              })),
            };
          },
          getAllChatHistory: () => agentService.getAllChatHistory(),
          loadChatSession: (sessionId) =>
            agentService.loadChatSession(sessionId),
          getUiMessages: (sessionId) => uiHistoryService.getMessages(sessionId),
        },
        systemBridge: {
          saveImageAttachment: async (payload: {
            dataBase64: string;
            fileName?: string;
            mimeType?: string;
            previewDataUrl?: string;
          }) => {
            return await imageAttachmentService.saveImageAttachment(payload);
          },
        },
        skillBridge: {
          reload: async () => {
            return await skillService.reload();
          },
          getAll: async () => {
            return await skillService.getAll();
          },
          getEnabled: async () => {
            return await skillService.getEnabledSkills();
          },
          create: async () => {
            return await skillService.createSkillFromTemplate();
          },
          delete: async (fileName: string) => {
            await skillService.deleteSkillFile(fileName);
            return await skillService.getAll();
          },
          listSkills: async () => {
            const snapshot = settingsService.getSettings();
            const enabledMap = snapshot.tools?.skills ?? {};
            const skills = await skillService.getAll();
            return skills.map((skill) => ({
              name: skill.name,
              description: skill.description,
              enabled: enabledMap[skill.name] !== false,
            }));
          },
          setSkillEnabled: async (name: string, enabled: boolean) => {
            const snapshot = settingsService.getSettings();
            const nextSkills = { ...(snapshot.tools?.skills ?? {}) };
            nextSkills[name] = enabled;

            settingsService.setSettings({
              tools: {
                builtIn: snapshot.tools?.builtIn ?? {},
                skills: nextSkills,
              },
            });

            const next = settingsService.getSettings();
            agentService.updateSettings(next);
            const skills = await skillService.getAll();
            const summary = buildSkillStatusSummary(skills, next.tools?.skills);
            gatewayService.broadcastRaw("skills:updated", summary);
            return summary;
          },
        },
        memoryBridge: {
          get: async () => {
            return await memoryService.getMemorySnapshot(
              settingsService.getSettings().agentSettings?.activeProfileId ||
                null,
            );
          },
          setContent: async (content: string) => {
            const snapshot = await memoryService.writeMemory(
              content,
              settingsService.getSettings().agentSettings?.activeProfileId ||
                null,
            );
            gatewayService.broadcastRaw("memory:updated", snapshot);
            return snapshot;
          },
        },
        agentSettingsBridge: {
          get: () => agentSettingProfileService.getState(),
          saveCurrent: async () => {
            const result = await agentSettingProfileService.saveCurrent();
            broadcastAgentSettingResult(result);
            return result;
          },
          apply: async (
            profileId: string,
            acknowledgedExperimentalToolNames: string[],
          ) => {
            const result = await agentSettingProfileService.apply(
              profileId,
              acknowledgedExperimentalToolNames,
            );
            if (!isExperimentalToolConfirmationRequired(result)) {
              broadcastAgentSettingResult(result);
            }
            return result;
          },
          overwrite: async (profileId: string) => {
            const result =
              await agentSettingProfileService.overwrite(profileId);
            broadcastAgentSettingResult(result);
            return result;
          },
          delete: async (profileId: string) => {
            const result = await agentSettingProfileService.delete(profileId);
            broadcastAgentSettingResult(result);
            return result;
          },
        },
        settingsBridge: {
          getSettings: () => settingsService.getSettings(),
          setSettings: async (patch) => {
            if ((patch as any)?.gateway?.ws) {
              throw new Error(
                "settings.gateway.ws is not configurable via websocket RPC.",
              );
            }
            const next = await agentSettingProfileService.applySettingsPatch(
              patch as any,
            );
            return next;
          },
        },
        commandPolicyBridge: {
          getLists: async () => {
            return await commandPolicyService.getLists();
          },
          addRule: async (listName, rule) => {
            return await commandPolicyService.addRule(listName, rule);
          },
          deleteRule: async (listName, rule) => {
            return await commandPolicyService.deleteRule(listName, rule);
          },
        },
        toolsBridge: {
          reloadMcp: async () => {
            return await mcpToolService.reloadAll();
          },
          getMcp: () => mcpToolService.getSummaries(),
          setMcpEnabled: async (name, enabled) => {
            return await mcpToolService.setServerEnabled(name, enabled);
          },
          getBuiltIn: () => {
            const settings = settingsService.getSettings();
            return buildBuiltInToolStatusSummary(settings.tools?.builtIn);
          },
          setBuiltInEnabled: async (
            name,
            enabled,
            acknowledgedExperimentalToolNames,
          ) => {
            const result =
              await agentSettingProfileService.setBuiltInToolEnabled(
                name,
                enabled,
                acknowledgedExperimentalToolNames,
              );
            if (!isExperimentalToolConfirmationRequired(result)) {
              gatewayService.broadcastRaw("tools:builtInUpdated", result);
            }
            return result;
          },
        },
      }),
  });
  await wsGatewayControlService.applyPolicy(startupPolicy);

  const shutdown = async (signal: string): Promise<void> => {
    console.log(`[gybackend] Received ${signal}, shutting down...`);
    try {
      await wsGatewayControlService.stop();
    } catch (error) {
      console.warn(
        "[gybackend] Failed to stop websocket adapter cleanly:",
        error,
      );
    }

    for (const terminal of terminalService.getDisplayTerminals()) {
      terminalService.kill(terminal.id);
    }

    process.exit(0);
  };

  process.on("SIGINT", () => {
    void shutdown("SIGINT");
  });
  process.on("SIGTERM", () => {
    void shutdown("SIGTERM");
  });

  console.log("[gybackend] Started.");
  const wsState = wsGatewayControlService.getState();
  if (wsState.running && wsState.host) {
    console.log(
      `[gybackend] WebSocket RPC endpoint: ws://${wsState.host}:${wsState.port}`,
    );
  } else {
    console.log("[gybackend] WebSocket RPC endpoint: disabled");
  }
  console.log(`[gybackend] Data directory: ${dataDir}`);
  console.log(
    `[gybackend] Settings file: ${settingsService.getSettingsPath()}`,
  );
  console.log(
    `[gybackend] Memory file: ${await memoryService.getMemoryFilePath()}`,
  );
  console.log(
    `[gybackend] Access token file: ${accessTokenService.getStorageFilePath()}`,
  );
}
