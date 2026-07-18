import type { BackendSettings, WsGatewayAccess } from "../../types";
import { normalizeModelRequestParameters } from "@gyshell/shared";
import { BUILTIN_TOOL_INFO } from "../AgentHelper/builtInToolMetadata";
import { normalizeAgentSettingState } from "./agentSettings";
import { deepMerge, isObject } from "./objectMerge";

export const BACKEND_SETTINGS_SCHEMA_VERSION = 5;

const DEFAULT_BUILTIN_TOOLS = BUILTIN_TOOL_INFO.reduce(
  (acc: Record<string, boolean>, tool) => {
    acc[tool.name] = tool.defaultEnabled ?? true;
    return acc;
  },
  {},
);

export const DEFAULT_BACKEND_SETTINGS: BackendSettings = {
  schemaVersion: BACKEND_SETTINGS_SCHEMA_VERSION,
  commandPolicyMode: "standard",
  tools: {
    builtIn: DEFAULT_BUILTIN_TOOLS,
    skills: {},
  },
  model: "",
  baseUrl: "",
  apiKey: "",
  models: {
    items: [],
    profiles: [],
    activeProfileId: "",
  },
  connections: {
    ssh: [],
    proxies: [],
    tunnels: [],
  },
  gateway: {
    ws: {
      access: "localhost",
      port: 17888,
      allowedCidrs: [],
    },
    mobileWeb: {
      port: null,
    },
  },
  layout: {
    panelSizes: [50, 50],
    panelOrder: ["chat", "terminal"],
    savedLayouts: [],
    activeSavedLayoutId: null,
  },
  recursionLimit: 200,
  memory: {
    enabled: true,
  },
  agentSettings: {
    profiles: [],
    activeProfileId: null,
  },
  debugMode: false,
  experimental: {
    runtimeThinkingCorrectionEnabled: true,
    taskFinishGuardEnabled: true,
    firstTurnThinkingModelEnabled: false,
    execCommandActionModelEnabled: true,
    writeStdinActionModelEnabled: true,
  },
};

function pickBackendSnapshot(raw: unknown): Partial<BackendSettings> {
  if (!isObject(raw)) return {};
  return {
    schemaVersion: raw.schemaVersion,
    commandPolicyMode: raw.commandPolicyMode,
    model: raw.model,
    baseUrl: raw.baseUrl,
    apiKey: raw.apiKey,
    models: raw.models,
    connections: raw.connections,
    tools: raw.tools,
    gateway: raw.gateway,
    layout: raw.layout,
    recursionLimit: raw.recursionLimit,
    memory: raw.memory,
    agentSettings: raw.agentSettings,
    debugMode: raw.debugMode,
    experimental: raw.experimental,
  } as Partial<BackendSettings>;
}

function normalizeBackendSettings(settings: BackendSettings): BackendSettings {
  const next = deepMerge(DEFAULT_BACKEND_SETTINGS, settings);

  next.models.items = next.models.items.map((item) => ({
    ...item,
    maxTokens:
      typeof item.maxTokens === "number" && item.maxTokens > 0
        ? item.maxTokens
        : 200000,
    requestParameters: (() => {
      const normalized = normalizeModelRequestParameters(item.requestParameters);
      return Object.keys(normalized).length > 0 ? normalized : undefined;
    })(),
    structuredOutputMode:
      item.structuredOutputMode === "on" || item.structuredOutputMode === "off"
        ? item.structuredOutputMode
        : "auto",
    supportsStructuredOutput: item.supportsStructuredOutput === true,
    supportsObjectToolChoice: item.supportsObjectToolChoice === true,
  }));

  const builtIn = { ...(next.tools?.builtIn ?? {}) };
  if (builtIn.send_char !== undefined && builtIn.write_stdin === undefined) {
    builtIn.write_stdin = builtIn.send_char;
  }
  delete builtIn.send_char;

  next.tools = {
    builtIn: {
      ...DEFAULT_BUILTIN_TOOLS,
      ...builtIn,
    },
    skills: {
      ...(next.tools?.skills ?? {}),
    },
  };

  if (!next.models.activeProfileId && next.models.profiles.length > 0) {
    next.models.activeProfileId = next.models.profiles[0].id;
  }

  const activeProfile = next.models.profiles.find(
    (profile) => profile.id === next.models.activeProfileId,
  );
  const activeModel = activeProfile
    ? next.models.items.find((item) => item.id === activeProfile.globalModelId)
    : undefined;

  next.model = activeModel?.model || "";
  next.baseUrl = activeModel?.baseUrl || "";
  next.apiKey = activeModel?.apiKey || "";

  next.recursionLimit =
    typeof next.recursionLimit === "number" &&
    Number.isFinite(next.recursionLimit) &&
    next.recursionLimit > 0
      ? next.recursionLimit
      : 200;

  next.memory = {
    enabled: next.memory?.enabled !== false,
  };

  next.agentSettings = normalizeAgentSettingState(next.agentSettings, {
    recursionLimit: next.recursionLimit,
    experimental: next.experimental ?? DEFAULT_BACKEND_SETTINGS.experimental!,
  });

  next.debugMode = next.debugMode === true;

  next.experimental = {
    runtimeThinkingCorrectionEnabled:
      next.experimental?.runtimeThinkingCorrectionEnabled !== false,
    taskFinishGuardEnabled: next.experimental?.taskFinishGuardEnabled !== false,
    firstTurnThinkingModelEnabled:
      next.experimental?.firstTurnThinkingModelEnabled === true,
    execCommandActionModelEnabled:
      next.experimental?.execCommandActionModelEnabled !== false,
    writeStdinActionModelEnabled:
      next.experimental?.writeStdinActionModelEnabled !== false,
  };

  const access = next.gateway?.ws?.access;
  const normalizedAccess: WsGatewayAccess =
    access === "disabled" ||
    access === "internet" ||
    access === "localhost" ||
    access === "lan" ||
    access === "custom"
      ? access
      : "localhost";
  const port = Number(next.gateway?.ws?.port);
  const allowedCidrs = Array.isArray(next.gateway?.ws?.allowedCidrs)
    ? (next.gateway!.ws.allowedCidrs as string[])
        .map((s) => (typeof s === "string" ? s.trim() : ""))
        .filter((s): s is string => s.length > 0)
    : [];

  const mobileWebPort = next.gateway?.mobileWeb?.port;
  const normalizedMobileWebPort =
    typeof mobileWebPort === "number" &&
    Number.isInteger(mobileWebPort) &&
    mobileWebPort > 0 &&
    mobileWebPort < 65536
      ? mobileWebPort
      : null;

  next.gateway = {
    ws: {
      access: normalizedAccess,
      port: Number.isInteger(port) && port > 0 && port < 65536 ? port : 17888,
      allowedCidrs,
    },
    mobileWeb: {
      port: normalizedMobileWebPort,
    },
  };

  next.schemaVersion = BACKEND_SETTINGS_SCHEMA_VERSION;
  return next;
}

function migrateBackendToV3(
  settings: Partial<BackendSettings>,
): Partial<BackendSettings> {
  const next = { ...(settings as any) };
  delete (next as any).language;
  delete (next as any).themeId;
  delete (next as any).terminal;
  next.schemaVersion = 3;
  return next;
}

function migrateBackendToV4(
  settings: Partial<BackendSettings>,
): Partial<BackendSettings> {
  const next = { ...(settings as any) };
  next.agentSettings = isObject(next.agentSettings)
    ? next.agentSettings
    : { profiles: [], activeProfileId: null };
  next.schemaVersion = 4;
  return next;
}

function migrateBackendToV5(
  settings: Partial<BackendSettings>,
): Partial<BackendSettings> {
  return { ...(settings as any), schemaVersion: 5 };
}

export function migrateBackendSettings(
  raw: unknown,
  legacyRaw?: unknown,
): BackendSettings {
  const legacySnapshot = pickBackendSnapshot(legacyRaw);
  const rawSnapshot = pickBackendSnapshot(raw);

  const rawVersion =
    isObject(raw) && typeof raw.schemaVersion === "number"
      ? raw.schemaVersion
      : 0;
  const legacyVersion =
    isObject(legacyRaw) && typeof legacyRaw.schemaVersion === "number"
      ? legacyRaw.schemaVersion
      : 0;

  let merged = deepMerge(DEFAULT_BACKEND_SETTINGS, legacySnapshot);
  merged = deepMerge(merged, rawSnapshot);

  const fromVersion = Math.max(rawVersion, legacyVersion);
  if (fromVersion < 3) {
    merged = deepMerge(merged, migrateBackendToV3(merged as any) as any);
  }
  if (fromVersion < 4) {
    merged = deepMerge(merged, migrateBackendToV4(merged as any) as any);
  }
  if (fromVersion < 5) {
    merged = deepMerge(merged, migrateBackendToV5(merged as any) as any);
  }

  return normalizeBackendSettings(merged);
}
