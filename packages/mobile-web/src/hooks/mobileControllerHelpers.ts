import type { GatewayClient } from "../gateway-client";
import {
  normalizeDisplayText,
  previewFromSession,
  type SessionMeta,
  type SessionState,
} from "../session-store";
import type {
  AgentSettingProfileSummary,
  AgentSettingStateSummary,
  BuiltInToolSummary,
  CommandPolicyLists,
  CommandPolicyMode,
  GatewayConnectionsSnapshot,
  GatewayMemorySnapshot,
  GatewayProfileSummary,
  GatewaySshConnectionEntry,
  GatewaySshConnectionSummary,
  McpServerSummary,
  SkillSummary,
} from "../types";

export function buildSessionMeta(
  session: SessionState,
  previous: SessionMeta | undefined,
  patch?: Partial<SessionMeta>,
): SessionMeta {
  return {
    id: session.id,
    title: session.title,
    updatedAt: Date.now(),
    messagesCount: session.messages.length,
    lastMessagePreview: previewFromSession(session),
    loaded: previous?.loaded ?? true,
    uiRevision: previous?.uiRevision,
    ...patch,
  };
}

export function safeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

export function compactStatusLabel(text: string, limit = 28): string {
  const normalized = normalizeDisplayText(text || "")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) return "Untitled";
  if (normalized.length <= limit) return normalized;
  return `${normalized.slice(0, Math.max(1, limit - 3))}...`;
}

export function normalizeSkillItem(
  raw: unknown,
  enabledByName: Set<string> | null,
): SkillSummary | null {
  if (!raw || typeof raw !== "object") return null;
  const data = raw as Record<string, unknown>;
  if (typeof data.name !== "string" || !data.name) return null;
  const localEnabled =
    typeof data.enabled === "boolean" ? data.enabled : undefined;
  const enabled = enabledByName
    ? enabledByName.has(data.name)
    : localEnabled !== false;

  return {
    name: data.name,
    description:
      typeof data.description === "string" ? data.description : undefined,
    enabled,
    fileName: typeof data.fileName === "string" ? data.fileName : undefined,
    filePath: typeof data.filePath === "string" ? data.filePath : undefined,
    baseDir: typeof data.baseDir === "string" ? data.baseDir : undefined,
    scanRoot: typeof data.scanRoot === "string" ? data.scanRoot : undefined,
    isNested: data.isNested === true,
    supportingFiles: Array.isArray(data.supportingFiles)
      ? data.supportingFiles.filter(
          (item): item is string => typeof item === "string",
        )
      : undefined,
  };
}

export function mergeSkillsByName(
  previous: SkillSummary[],
  incoming: SkillSummary[],
): SkillSummary[] {
  const byName = new Map(previous.map((skill) => [skill.name, skill]));
  for (const skill of incoming) {
    const prev = byName.get(skill.name);
    byName.set(skill.name, {
      ...(prev || {}),
      ...skill,
    });
  }
  return [...byName.values()].sort((left, right) =>
    left.name.localeCompare(right.name),
  );
}

export function collectEnabledSkillNames(payload: unknown[]): Set<string> {
  return new Set(
    payload
      .map((item) => {
        if (!item || typeof item !== "object") return null;
        if (!("name" in item) || typeof item.name !== "string") return null;
        if ("enabled" in item && item.enabled === false) return null;
        return item.name;
      })
      .filter((name): name is string => !!name),
  );
}

export async function fetchSkillsSnapshot(
  client: GatewayClient,
): Promise<SkillSummary[]> {
  try {
    const [allRaw, enabledRaw] = await Promise.all([
      client.request<unknown>("skills:getAll", {}),
      client.request<unknown>("skills:getEnabled", {}),
    ]);

    if (Array.isArray(allRaw) && Array.isArray(enabledRaw)) {
      const enabledByName = new Set(
        enabledRaw
          .map((item) =>
            item && typeof item === "object" && "name" in item
              ? (item as { name?: unknown }).name
              : null,
          )
          .filter((name): name is string => typeof name === "string" && !!name),
      );
      return allRaw
        .map((item) => normalizeSkillItem(item, enabledByName))
        .filter((item): item is SkillSummary => !!item)
        .sort((left, right) => left.name.localeCompare(right.name));
    }
  } catch {
    // fallback to legacy list API
  }

  const payload = await client.request<{ skills: SkillSummary[] }>(
    "skills:list",
    {},
  );
  return (payload.skills || [])
    .map((item) => normalizeSkillItem(item, null))
    .filter((item): item is SkillSummary => !!item)
    .sort((left, right) => left.name.localeCompare(right.name));
}

export function normalizeMemorySnapshot(raw: unknown): GatewayMemorySnapshot {
  if (!raw || typeof raw !== "object") {
    return { filePath: "", content: "" };
  }
  const item = raw as Record<string, unknown>;
  return {
    filePath: typeof item.filePath === "string" ? item.filePath : "",
    content: typeof item.content === "string" ? item.content : "",
  };
}

export function readMemoryEnabledFromSettings(raw: unknown): boolean {
  if (!raw || typeof raw !== "object") return true;
  const settings = raw as Record<string, unknown>;
  const memory = settings.memory;
  if (!memory || typeof memory !== "object") return true;
  return (memory as Record<string, unknown>).enabled !== false;
}

export function readCommandPolicyModeFromSettings(
  raw: unknown,
): CommandPolicyMode {
  if (!raw || typeof raw !== "object") return "standard";
  const mode = (raw as Record<string, unknown>).commandPolicyMode;
  return mode === "safe" || mode === "smart" || mode === "standard"
    ? mode
    : "standard";
}

export function normalizeCommandPolicyLists(
  raw: unknown,
): CommandPolicyLists {
  const source =
    raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const normalizeList = (value: unknown): string[] =>
    Array.isArray(value)
      ? value.filter((item): item is string => typeof item === "string")
      : [];
  return {
    allowlist: normalizeList(source.allowlist),
    denylist: normalizeList(source.denylist),
    asklist: normalizeList(source.asklist),
  };
}

export function readProfilesFromSettings(raw: unknown): {
  profiles: GatewayProfileSummary[];
  activeProfileId: string;
} {
  if (!raw || typeof raw !== "object") {
    return { profiles: [], activeProfileId: "" };
  }
  const settings = raw as Record<string, unknown>;
  const models = settings.models;
  if (!models || typeof models !== "object") {
    return { profiles: [], activeProfileId: "" };
  }
  const modelRecord = models as Record<string, unknown>;
  const modelItems = Array.isArray(modelRecord.items)
    ? modelRecord.items
    : [];
  const modelNameById = new Map(
    modelItems.flatMap((item) => {
      if (!item || typeof item !== "object") return [];
      const record = item as Record<string, unknown>;
      return typeof record.id === "string"
        ? [[record.id, typeof record.name === "string" ? record.name : ""]]
        : [];
    }),
  );
  const profiles = Array.isArray(modelRecord.profiles)
    ? modelRecord.profiles.flatMap((profile) => {
        if (!profile || typeof profile !== "object") return [];
        const record = profile as Record<string, unknown>;
        if (typeof record.id !== "string" || !record.id) return [];
        if (typeof record.name !== "string") return [];
        const globalModelId =
          typeof record.globalModelId === "string" ? record.globalModelId : "";
        return [
          {
            id: record.id,
            name: record.name,
            globalModelId,
            modelName: modelNameById.get(globalModelId) || undefined,
          },
        ];
      })
    : [];
  return {
    profiles,
    activeProfileId:
      typeof modelRecord.activeProfileId === "string"
        ? modelRecord.activeProfileId
        : "",
  };
}

export function normalizeMcpServer(raw: unknown): McpServerSummary | null {
  if (!raw || typeof raw !== "object") return null;
  const item = raw as Record<string, unknown>;
  if (typeof item.name !== "string" || !item.name) return null;
  const statusRaw = item.status;
  const status: McpServerSummary["status"] =
    statusRaw === "disabled" ||
    statusRaw === "connecting" ||
    statusRaw === "connected" ||
    statusRaw === "error"
      ? statusRaw
      : "disabled";
  return {
    name: item.name,
    enabled: item.enabled !== false,
    status,
    error: typeof item.error === "string" ? item.error : undefined,
    toolCount: typeof item.toolCount === "number" ? item.toolCount : undefined,
  };
}

export function normalizeBuiltInTool(raw: unknown): BuiltInToolSummary | null {
  if (!raw || typeof raw !== "object") return null;
  const item = raw as Record<string, unknown>;
  if (typeof item.name !== "string" || !item.name) return null;
  return {
    name: item.name,
    description: typeof item.description === "string" ? item.description : "",
    enabled: item.enabled !== false,
    experimental: item.experimental === true ? true : undefined,
  };
}

export function readExperimentalToolConfirmationRequired(
  raw: unknown,
): string[] | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  if (record.kind !== "experimental_tool_confirmation_required") return null;
  if (!Array.isArray(record.experimentalToolNames)) return null;
  return Array.from(
    new Set(
      record.experimentalToolNames.filter(
        (name): name is string => typeof name === "string" && name.length > 0,
      ),
    ),
  ).sort();
}

export async function fetchToolsSnapshot(client: GatewayClient): Promise<{
  mcpTools: McpServerSummary[];
  builtInTools: BuiltInToolSummary[];
}> {
  const [mcpRaw, builtInRaw] = await Promise.all([
    client.request<unknown>("tools:getMcp", {}),
    client.request<unknown>("tools:getBuiltIn", {}),
  ]);

  const mcpTools = Array.isArray(mcpRaw)
    ? mcpRaw
        .map((item) => normalizeMcpServer(item))
        .filter((item): item is McpServerSummary => !!item)
    : [];
  const builtInTools = Array.isArray(builtInRaw)
    ? builtInRaw
        .map((item) => normalizeBuiltInTool(item))
        .filter((item): item is BuiltInToolSummary => !!item)
    : [];

  return { mcpTools, builtInTools };
}

function normalizeProxyEntry(
  raw: unknown,
): GatewayConnectionsSnapshot["proxies"][number] | null {
  if (!raw || typeof raw !== "object") return null;
  const item = raw as Record<string, unknown>;
  if (typeof item.id !== "string" || !item.id.trim()) return null;
  if (typeof item.name !== "string") return null;
  if (typeof item.host !== "string" || !item.host.trim()) return null;
  if (
    typeof item.port !== "number" ||
    !Number.isInteger(item.port) ||
    item.port <= 0
  )
    return null;
  if (item.type !== "socks5" && item.type !== "http") return null;
  return {
    id: item.id,
    name: item.name,
    type: item.type,
    host: item.host,
    port: item.port,
    username: typeof item.username === "string" ? item.username : undefined,
    password: typeof item.password === "string" ? item.password : undefined,
  };
}

function normalizeTunnelEntry(
  raw: unknown,
): GatewayConnectionsSnapshot["tunnels"][number] | null {
  if (!raw || typeof raw !== "object") return null;
  const item = raw as Record<string, unknown>;
  if (typeof item.id !== "string" || !item.id.trim()) return null;
  if (typeof item.name !== "string") return null;
  if (typeof item.host !== "string" || !item.host.trim()) return null;
  if (
    typeof item.port !== "number" ||
    !Number.isInteger(item.port) ||
    item.port <= 0
  )
    return null;
  if (
    item.type !== "Local" &&
    item.type !== "Remote" &&
    item.type !== "Dynamic"
  )
    return null;
  return {
    id: item.id,
    name: item.name,
    type: item.type,
    host: item.host,
    port: item.port,
    targetAddress:
      typeof item.targetAddress === "string" ? item.targetAddress : undefined,
    targetPort:
      typeof item.targetPort === "number" && Number.isInteger(item.targetPort)
        ? item.targetPort
        : undefined,
    viaConnectionId:
      typeof item.viaConnectionId === "string"
        ? item.viaConnectionId
        : undefined,
  };
}

function normalizeSshEntry(
  raw: unknown,
  depth = 0,
): GatewaySshConnectionEntry | null {
  if (!raw || typeof raw !== "object") return null;
  const item = raw as Record<string, unknown>;
  if (typeof item.id !== "string" || !item.id.trim()) return null;
  if (typeof item.name !== "string") return null;
  if (typeof item.host !== "string" || !item.host.trim()) return null;
  if (
    typeof item.port !== "number" ||
    !Number.isInteger(item.port) ||
    item.port <= 0
  )
    return null;
  if (typeof item.username !== "string" || !item.username.trim()) return null;
  if (item.authMethod !== "password" && item.authMethod !== "privateKey")
    return null;
  const tunnelIds = Array.isArray(item.tunnelIds)
    ? item.tunnelIds.filter(
        (id): id is string => typeof id === "string" && !!id,
      )
    : undefined;
  const jumpHost =
    depth < 3 ? normalizeSshEntry(item.jumpHost, depth + 1) : null;
  return {
    id: item.id,
    name: item.name,
    host: item.host,
    port: item.port,
    username: item.username,
    authMethod: item.authMethod,
    password: typeof item.password === "string" ? item.password : undefined,
    privateKey:
      typeof item.privateKey === "string" ? item.privateKey : undefined,
    privateKeyPath:
      typeof item.privateKeyPath === "string" ? item.privateKeyPath : undefined,
    passphrase:
      typeof item.passphrase === "string" ? item.passphrase : undefined,
    proxyId:
      typeof item.proxyId === "string" && item.proxyId
        ? item.proxyId
        : undefined,
    tunnelIds,
    jumpHost: jumpHost || undefined,
  };
}

export function normalizeConnectionsSnapshot(
  raw: unknown,
): GatewayConnectionsSnapshot {
  if (!raw || typeof raw !== "object") {
    return { ssh: [], proxies: [], tunnels: [] };
  }
  const settings = raw as Record<string, unknown>;
  const connections =
    settings.connections && typeof settings.connections === "object"
      ? (settings.connections as Record<string, unknown>)
      : null;
  if (!connections) {
    return { ssh: [], proxies: [], tunnels: [] };
  }
  return {
    ssh: Array.isArray(connections.ssh)
      ? connections.ssh
          .map((item) => normalizeSshEntry(item))
          .filter((item): item is GatewaySshConnectionEntry => !!item)
      : [],
    proxies: Array.isArray(connections.proxies)
      ? connections.proxies
          .map((item) => normalizeProxyEntry(item))
          .filter(
            (item): item is GatewayConnectionsSnapshot["proxies"][number] =>
              !!item,
          )
      : [],
    tunnels: Array.isArray(connections.tunnels)
      ? connections.tunnels
          .map((item) => normalizeTunnelEntry(item))
          .filter(
            (item): item is GatewayConnectionsSnapshot["tunnels"][number] =>
              !!item,
          )
      : [],
  };
}

export function buildSshConnectionSummaries(
  connections: GatewayConnectionsSnapshot,
): GatewaySshConnectionSummary[] {
  return connections.ssh
    .map((item) => ({
      id: item.id,
      name: item.name,
      host: item.host,
      port: item.port,
      username: item.username,
      authMethod: item.authMethod,
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

export function toSshConfig(
  entry: GatewaySshConnectionEntry,
  connections: GatewayConnectionsSnapshot,
): Record<string, unknown> {
  const proxy = entry.proxyId
    ? connections.proxies.find((item) => item.id === entry.proxyId)
    : undefined;
  const tunnels =
    entry.tunnelIds && entry.tunnelIds.length > 0
      ? connections.tunnels.filter((item) => entry.tunnelIds?.includes(item.id))
      : undefined;
  const jumpHost = entry.jumpHost
    ? toSshConfig(entry.jumpHost, connections)
    : undefined;
  return {
    type: "ssh",
    title: entry.name || `${entry.username}@${entry.host}`,
    cols: 120,
    rows: 32,
    host: entry.host,
    port: entry.port,
    username: entry.username,
    authMethod: entry.authMethod,
    password: entry.password,
    privateKey: entry.privateKey,
    privateKeyPath: entry.privateKeyPath,
    passphrase: entry.passphrase,
    proxy,
    tunnels,
    jumpHost,
  };
}

/**
 * Derive a compact, human-readable status label for a session in the SessionBrowser.
 *
 * This powers the "task status card" design (Phase 1): mobile-web users open the app
 * to see "what is happening right now". The label is the single most important signal
 * and must surface the approval-waiting state above all else, because approvals are the
 * case where the user MUST intervene or the task stalls.
 */
export type SessionStatusKind =
  | "approval"
  | "error"
  | "thinking"
  | "tool"
  | "running"
  | "done";

/**
 * Structural descriptor of a session's current state. The helper layer stays
 * locale-free: it only reports WHAT the session is doing (kind + an optional
 * sub-detail and a dynamic name like a tool name). The presentation layer is
 * responsible for turning this into a localized label via i18n.
 */
export type SessionStatusDetail =
  | "approval"
  | "error"
  | "thinking"
  | "replying"
  | "tool"
  | "file_edit"
  | "sub_tool"
  | "command"
  | "command_async"
  | "compacting"
  | "running"
  | "done";

export interface SessionStatusInfo {
  kind: SessionStatusKind;
  /** Locale-free sub-classification; the i18n layer maps this to a label. */
  detail: SessionStatusDetail;
  /** Dynamic context (e.g. tool name) to interpolate into the label, if any. */
  contextName?: string;
}

export function deriveSessionStatus(
  session: SessionState,
): SessionStatusInfo {
  const messages = session.messages;
  if (messages.length === 0) {
    return { kind: "done", detail: "done" };
  }

  // Scan from latest backwards for the first "meaningful" message.
  let lastMeaningfulIndex = -1;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (!message) continue;
    if (message.type === "tokens_count") continue;
    lastMeaningfulIndex = i;
    break;
  }
  if (lastMeaningfulIndex < 0) {
    return { kind: "done", detail: "done" };
  }
  const last = messages[lastMeaningfulIndex];

  // Approval pending: an `ask` message without a decision always wins priority,
  // even if later inserted user messages were queued while the run was blocked.
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (!message || message.type !== "ask") continue;
    if (
      message.metadata?.decision === "allow" ||
      message.metadata?.decision === "deny"
    ) {
      continue;
    }
    const toolName = message.metadata?.toolName || "";
    return {
      kind: "approval",
      detail: "approval",
      ...(toolName ? { contextName: toolName } : {}),
    };
  }

  if (last.type === "error") {
    return { kind: "error", detail: "error" };
  }

  // Busy state: use last activity type to describe current phase.
  if (session.isBusy) {
    if (last.type === "tool_call") {
      const toolName = last.metadata?.toolName || "";
      return {
        kind: "tool",
        detail: "tool",
        ...(toolName ? { contextName: toolName } : {}),
      };
    }
    if (last.type === "command") {
      return {
        kind: "running",
        detail: last.metadata?.isNowait ? "command_async" : "command",
      };
    }
    if (last.type === "reasoning") {
      return { kind: "thinking", detail: "thinking" };
    }
    if (last.type === "compaction") {
      return { kind: "running", detail: "compacting" };
    }
    if (last.type === "file_edit") {
      return { kind: "tool", detail: "file_edit" };
    }
    if (last.type === "sub_tool") {
      return { kind: "tool", detail: "sub_tool" };
    }
    if (last.streaming) {
      return { kind: "thinking", detail: "replying" };
    }
    return { kind: "running", detail: "running" };
  }

  return { kind: "done", detail: "done" };
}

/**
 * Count sessions that currently block on an unanswered approval. Used by the global
 * Approval Badge so users don't have to dig into each session to discover pending work.
 */
export function countPendingApprovals(sessions: Record<string, SessionState>): number {
  let count = 0;
  for (const session of Object.values(sessions)) {
    if (!session) continue;
    const info = deriveSessionStatus(session);
    if (info.kind === "approval") count += 1;
  }
  return count;
}

/**
 * Find the first session (most recently updated) that is waiting for an approval.
 * Used by the Approval Badge's tap-to-jump interaction.
 */
export function findFirstApprovalSession(
  sessionOrder: string[],
  sessionMeta: Record<string, SessionMeta>,
  sessions: Record<string, SessionState>,
): string | null {
  for (const sessionId of sessionOrder) {
    const session = sessions[sessionId];
    if (!session) continue;
    if (deriveSessionStatus(session).kind === "approval") {
      return sessionId;
    }
  }
  // sessionOrder is already sorted by updatedAt desc via reorderSessionIds.
  void sessionMeta;
  return null;
}

export function normalizeAgentSettingState(raw: unknown): AgentSettingStateSummary {
  if (!raw || typeof raw !== "object") {
    return { profiles: [], activeProfileId: null };
  }
  const item = raw as Record<string, unknown>;
  const rawProfiles = Array.isArray(item.profiles) ? item.profiles : [];
  const profiles: AgentSettingProfileSummary[] = [];
  for (const entry of rawProfiles) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const id = typeof record.id === "string" ? record.id : "";
    if (!id) continue;
    const slotNumber = Number(record.slotNumber);
    if (!Number.isInteger(slotNumber) || slotNumber < 1 || slotNumber > 6) continue;
    const snapshot =
      record.snapshot && typeof record.snapshot === "object"
        ? (record.snapshot as Record<string, unknown>)
        : null;
    const modelSnapshot =
      snapshot && snapshot.model && typeof snapshot.model === "object"
        ? (snapshot.model as Record<string, unknown>)
        : null;
    const securitySnapshot =
      snapshot && snapshot.security && typeof snapshot.security === "object"
        ? (snapshot.security as Record<string, unknown>)
        : null;
    const commandPolicyModeRaw = securitySnapshot?.commandPolicyMode;
    const commandPolicyMode: CommandPolicyMode | undefined =
      commandPolicyModeRaw === "safe" ||
      commandPolicyModeRaw === "standard" ||
      commandPolicyModeRaw === "smart"
        ? commandPolicyModeRaw
        : undefined;
    profiles.push({
      id,
      slotNumber: slotNumber as AgentSettingProfileSummary["slotNumber"],
      createdAt: typeof record.createdAt === "number" ? record.createdAt : 0,
      updatedAt: typeof record.updatedAt === "number" ? record.updatedAt : 0,
      modelName:
        typeof modelSnapshot?.activeProfileName === "string"
          ? modelSnapshot.activeProfileName
          : undefined,
      modelProfileId:
        typeof modelSnapshot?.activeProfileId === "string"
          ? modelSnapshot.activeProfileId
          : undefined,
      commandPolicyMode,
    });
  }
  profiles.sort((left, right) => left.slotNumber - right.slotNumber);
  return {
    profiles,
    activeProfileId:
      typeof item.activeProfileId === "string" ? item.activeProfileId : null,
  };
}
