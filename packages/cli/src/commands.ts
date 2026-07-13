import fs from "node:fs/promises";
import path from "node:path";
import {
  assertAllowedFlags,
  enumFlag,
  getFlag,
  getFlags,
  hasFlag,
  integerFlag,
  MAX_TIMER_DELAY_MS,
  requiredFlag,
} from "./arguments";
import { CliUsageError } from "./errors";
import { readJsonSource, readTextSource } from "./io";
import { buildSavedSshConfig } from "./ssh-config";
import type {
  CliIo,
  CommandResult,
  GatewaySessionSnapshot,
  GatewayUiUpdate,
  ParsedArguments,
  RpcClient,
} from "./types";

const SECRET_KEY =
  /(password|passphrase|private.?key|api.?key|access.?token|secret)$/i;
const IMAGE_MIME_BY_EXTENSION: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

type Handler = (
  args: ParsedArguments,
  client: RpcClient,
  io: CliIo,
) => Promise<unknown>;

interface CommandDefinition {
  flags: string[];
  handler: Handler;
}

interface PreparedImageUpload {
  dataBase64: string;
  fileName: string;
  mimeType: string;
}

interface WaitBaseline {
  messageKeys: Set<string>;
  approvalKeys: Set<string>;
}

const COMMANDS: Record<string, CommandDefinition> = {
  status: { flags: [], handler: status },
  "session.list": { flags: [], handler: sessionList },
  "session.get": { flags: ["session-id"], handler: sessionGet },
  "session.create": { flags: [], handler: sessionCreate },
  "session.rename": { flags: ["session-id", "title"], handler: sessionRename },
  "session.delete": { flags: ["session-id"], handler: sessionDelete },
  "session.branch": {
    flags: ["session-id", "message-id"],
    handler: sessionBranch,
  },
  "session.rollback": {
    flags: ["session-id", "message-id"],
    handler: sessionRollback,
  },
  "chat.send": {
    flags: [
      "session-id",
      "message",
      "stdin",
      "image",
      "mode",
      "wait",
      "wait-timeout",
    ],
    handler: chatSend,
  },
  "chat.wait": { flags: ["session-id", "wait-timeout"], handler: chatWait },
  "chat.stop": { flags: ["session-id"], handler: chatStop },
  "approval.reply": {
    flags: ["approval-id", "backend-message-id", "decision"],
    handler: approvalReply,
  },
  "terminal.list": { flags: [], handler: terminalList },
  "terminal.create": {
    flags: ["type", "connection-id", "title", "cwd", "shell", "cols", "rows"],
    handler: terminalCreate,
  },
  "terminal.write": {
    flags: ["terminal-id", "data", "stdin", "enter"],
    handler: terminalWrite,
  },
  "terminal.resize": {
    flags: ["terminal-id", "cols", "rows"],
    handler: terminalResize,
  },
  "terminal.buffer": {
    flags: ["terminal-id", "from-offset"],
    handler: terminalBuffer,
  },
  "terminal.reconnect": { flags: ["terminal-id"], handler: terminalReconnect },
  "terminal.close": { flags: ["terminal-id"], handler: terminalClose },
  "profile.list": { flags: [], handler: profileList },
  "profile.use": { flags: ["profile-id"], handler: profileUse },
  "skill.list": { flags: [], handler: skillList },
  "skill.reload": { flags: [], handler: skillReload },
  "skill.enable": { flags: ["name"], handler: skillEnable },
  "skill.disable": { flags: ["name"], handler: skillDisable },
  "tool.list": { flags: [], handler: toolList },
  "tool.reload": { flags: [], handler: toolReload },
  "tool.enable": {
    flags: ["kind", "name", "ack-experimental-risk"],
    handler: toolEnable,
  },
  "tool.disable": { flags: ["kind", "name"], handler: toolDisable },
  "memory.get": { flags: [], handler: memoryGet },
  "memory.set": { flags: ["content", "file", "stdin"], handler: memorySet },
  "agent-setting.list": { flags: [], handler: agentSettingList },
  "agent-setting.save": { flags: [], handler: agentSettingSave },
  "agent-setting.apply": {
    flags: ["profile-id", "ack-experimental-risk"],
    handler: agentSettingApply,
  },
  "agent-setting.overwrite": {
    flags: ["profile-id"],
    handler: agentSettingOverwrite,
  },
  "agent-setting.delete": {
    flags: ["profile-id"],
    handler: agentSettingDelete,
  },
  "policy.list": { flags: [], handler: policyList },
  "policy.add": { flags: ["list", "rule"], handler: policyAdd },
  "policy.delete": { flags: ["list", "rule"], handler: policyDelete },
  "settings.get": { flags: ["include-secrets"], handler: settingsGet },
  "settings.set": { flags: ["json", "file", "stdin"], handler: settingsSet },
  rpc: { flags: ["params", "file", "stdin"], handler: rawRpc },
};

export async function executeCommand(
  originalArgs: ParsedArguments,
  client: RpcClient,
  io: CliIo,
): Promise<CommandResult> {
  const args = normalizeLegacyAliases(originalArgs);
  const command = resolveCommand(args.positional);
  const definition = COMMANDS[command];
  if (!definition)
    throw new CliUsageError(`Unknown command: ${args.positional.join(" ")}`);
  assertPositionalShape(command, args.positional);
  assertAllowedFlags(args, definition.flags);
  validateCommandOptions(command, args);
  const data = await definition.handler(args, client, io);
  return { command, data };
}

export function validateCommand(args: ParsedArguments): void {
  const normalized = normalizeLegacyAliases(args);
  const command = resolveCommand(normalized.positional);
  const definition = COMMANDS[command];
  if (!definition)
    throw new CliUsageError(
      `Unknown command: ${normalized.positional.join(" ")}`,
    );
  assertPositionalShape(command, normalized.positional);
  assertAllowedFlags(normalized, definition.flags);
  validateCommandOptions(command, normalized);
}

const REQUIRED_FLAGS_BY_COMMAND: Record<string, string[]> = {
  "session.get": ["session-id"],
  "session.rename": ["session-id", "title"],
  "session.delete": ["session-id"],
  "session.branch": ["session-id", "message-id"],
  "session.rollback": ["session-id", "message-id"],
  "chat.wait": ["session-id"],
  "chat.stop": ["session-id"],
  "terminal.write": ["terminal-id"],
  "terminal.resize": ["terminal-id", "cols", "rows"],
  "terminal.buffer": ["terminal-id"],
  "terminal.reconnect": ["terminal-id"],
  "terminal.close": ["terminal-id"],
  "profile.use": ["profile-id"],
  "skill.enable": ["name"],
  "skill.disable": ["name"],
  "tool.enable": ["kind", "name"],
  "tool.disable": ["kind", "name"],
  "agent-setting.apply": ["profile-id"],
  "agent-setting.overwrite": ["profile-id"],
  "agent-setting.delete": ["profile-id"],
  "policy.add": ["list", "rule"],
  "policy.delete": ["list", "rule"],
};

function validateCommandOptions(command: string, args: ParsedArguments): void {
  for (const name of REQUIRED_FLAGS_BY_COMMAND[command] || []) {
    requiredFlag(args, name);
  }

  if (command === "chat.send") {
    validateInputSources(args, ["message"], true, false, "Chat message");
    const hasImages = getFlags(args, "image").length > 0;
    if (!hasChatTextSource(args) && !hasImages) {
      throw new CliUsageError(
        "Chat message text or at least one image is required.",
      );
    }
    const directText = getFlag(args, "message");
    const positionalText = args.positional.slice(2).join(" ");
    if (
      !hasImages &&
      ((directText !== undefined && !directText.trim()) ||
        (directText === undefined &&
          !hasFlag(args, "stdin") &&
          args.positional.slice(2).length > 0 &&
          !positionalText.trim()))
    ) {
      throw new CliUsageError(
        "Chat message text or at least one image is required.",
      );
    }
    const shouldWait = hasFlag(args, "wait");
    if (!shouldWait && getFlag(args, "wait-timeout") !== undefined) {
      throw new CliUsageError("--wait-timeout requires --wait.");
    }
    if (shouldWait) {
      integerFlag(args, "wait-timeout", 600_000, {
        min: 1,
        max: MAX_TIMER_DELAY_MS,
      });
    }
    enumFlag(args, "mode", ["auto", "normal", "inserted"] as const, "auto");
    for (const imagePath of getFlags(args, "image")) {
      if (!IMAGE_MIME_BY_EXTENSION[path.extname(imagePath).toLowerCase()]) {
        throw new CliUsageError(`Unsupported image type: ${imagePath}`);
      }
    }
    return;
  }

  if (command === "chat.wait") {
    integerFlag(args, "wait-timeout", 600_000, {
      min: 1,
      max: MAX_TIMER_DELAY_MS,
    });
    return;
  }

  if (command === "approval.reply") {
    const approvalId = getFlag(args, "approval-id")?.trim();
    const backendMessageId = getFlag(args, "backend-message-id")?.trim();
    if (!!approvalId === !!backendMessageId) {
      throw new CliUsageError(
        "Provide exactly one of --approval-id or --backend-message-id.",
      );
    }
    enumFlag(args, "decision", ["allow", "deny"] as const);
    return;
  }

  if (command === "terminal.create") {
    const type = enumFlag(args, "type", ["local", "ssh"] as const, "local");
    integerFlag(args, "cols", 120, { min: 1, max: 1000 });
    integerFlag(args, "rows", 32, { min: 1, max: 1000 });
    if (type === "ssh") {
      requiredFlag(args, "connection-id");
      if (
        getFlag(args, "title") ||
        getFlag(args, "cwd") ||
        getFlag(args, "shell")
      ) {
        throw new CliUsageError(
          "Saved SSH terminals do not accept --title, --cwd, or --shell overrides.",
        );
      }
    } else if (getFlag(args, "connection-id")) {
      throw new CliUsageError("--connection-id is only valid with --type ssh.");
    }
    return;
  }

  if (command === "terminal.write") {
    validateInputSources(args, ["data"], false, true, "Terminal data");
    return;
  }

  if (command === "terminal.resize") {
    integerFlag(args, "cols", undefined, { min: 1, max: 1000 });
    integerFlag(args, "rows", undefined, { min: 1, max: 1000 });
    return;
  }

  if (command === "terminal.buffer") {
    integerFlag(args, "from-offset", 0, { min: 0 });
    return;
  }

  if (command === "tool.enable" || command === "tool.disable") {
    enumFlag(args, "kind", ["mcp", "built-in"] as const);
    return;
  }

  if (command === "memory.set") {
    validateInputSources(
      args,
      ["content", "file"],
      false,
      true,
      "Memory content",
    );
    return;
  }

  if (command === "policy.add" || command === "policy.delete") {
    enumFlag(args, "list", ["allowlist", "denylist", "asklist"] as const);
    return;
  }

  if (command === "settings.set") {
    validateInputSources(args, ["json", "file"], false, true, "Settings patch");
    validateJsonFlag(args, "json", "Settings patch");
    return;
  }

  if (command === "rpc") {
    validateInputSources(args, ["params", "file"], false, false, "RPC params");
    validateJsonFlag(args, "params", "RPC params");
  }
}

function hasChatTextSource(args: ParsedArguments): boolean {
  return (
    getFlag(args, "message") !== undefined ||
    hasFlag(args, "stdin") ||
    args.positional.slice(2).length > 0
  );
}

function validateInputSources(
  args: ParsedArguments,
  flagNames: string[],
  allowPositional: boolean,
  required: boolean,
  label: string,
): void {
  const sourceCount =
    flagNames.filter((name) => getFlag(args, name) !== undefined).length +
    (hasFlag(args, "stdin") ? 1 : 0) +
    (allowPositional && args.positional.slice(2).length > 0 ? 1 : 0);
  if (sourceCount > 1) {
    throw new CliUsageError(
      `${label} must come from exactly one input source.`,
    );
  }
  if (required && sourceCount === 0) {
    throw new CliUsageError(`${label} is required.`);
  }
}

function validateJsonFlag(
  args: ParsedArguments,
  name: string,
  label: string,
): void {
  const raw = getFlag(args, name);
  if (raw === undefined) return;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("must be an object");
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new CliUsageError(`${label} must be valid JSON: ${detail}`);
  }
}

function assertPositionalShape(command: string, positional: string[]): void {
  if (command === "chat.send") return;
  const expected = command === "status" ? 1 : 2;
  if (positional.length !== expected) {
    throw new CliUsageError(
      `Unexpected positional argument(s) for ${command}.`,
    );
  }
}

function resolveCommand(positional: string[]): string {
  if (positional[0] === "status" || positional[0] === "rpc")
    return positional[0];
  if (positional.length >= 2) return `${positional[0]}.${positional[1]}`;
  throw new CliUsageError(
    "A command is required. Run `gyll --help` for usage.",
  );
}

function normalizeLegacyAliases(args: ParsedArguments): ParsedArguments {
  const first = args.positional[0];
  if (first !== "run" && first !== "hook") return args;
  const flags = new Map(args.flags);
  if (first === "run" && !flags.has("wait")) flags.set("wait", ["true"]);
  return {
    ...args,
    flags,
    positional: ["chat", "send", ...args.positional.slice(1)],
  };
}

async function status(
  _args: ParsedArguments,
  client: RpcClient,
): Promise<unknown> {
  return await client.request("gateway:ping", {});
}

async function sessionList(
  _args: ParsedArguments,
  client: RpcClient,
): Promise<unknown> {
  return await client.request("session:list", {});
}

async function sessionGet(
  args: ParsedArguments,
  client: RpcClient,
): Promise<unknown> {
  return await getSession(client, requiredFlag(args, "session-id"));
}

async function sessionCreate(
  _args: ParsedArguments,
  client: RpcClient,
): Promise<unknown> {
  return await client.request("gateway:createSession", {});
}

async function sessionRename(
  args: ParsedArguments,
  client: RpcClient,
): Promise<unknown> {
  const sessionId = requiredFlag(args, "session-id");
  const newTitle = requiredFlag(args, "title");
  await client.request("agent:renameSession", { sessionId, newTitle });
  return await getSession(client, sessionId);
}

async function sessionDelete(
  args: ParsedArguments,
  client: RpcClient,
): Promise<unknown> {
  const sessionId = requiredFlag(args, "session-id");
  await client.request("agent:deleteChatSession", { sessionId });
  return { sessionId, deleted: true };
}

async function sessionBranch(
  args: ParsedArguments,
  client: RpcClient,
): Promise<unknown> {
  return await client.request("agent:branchFromMessage", {
    sessionId: requiredFlag(args, "session-id"),
    messageId: requiredFlag(args, "message-id"),
  });
}

async function sessionRollback(
  args: ParsedArguments,
  client: RpcClient,
): Promise<unknown> {
  return await client.request("agent:rollbackToMessage", {
    sessionId: requiredFlag(args, "session-id"),
    messageId: requiredFlag(args, "message-id"),
  });
}

async function chatSend(
  args: ParsedArguments,
  client: RpcClient,
  io: CliIo,
): Promise<unknown> {
  const shouldWait = hasFlag(args, "wait");
  if (!shouldWait && getFlag(args, "wait-timeout") !== undefined) {
    throw new CliUsageError("--wait-timeout requires --wait.");
  }
  const waitTimeoutMs = shouldWait
    ? integerFlag(args, "wait-timeout", 600_000, {
        min: 1,
        max: MAX_TIMER_DELAY_MS,
      })
    : undefined;
  const requestedMode = enumFlag(
    args,
    "mode",
    ["auto", "normal", "inserted"] as const,
    "auto",
  );
  const message = hasChatTextSource(args)
    ? await readTextSource(args, io, {
        flag: "message",
        positional: args.positional.slice(2),
        label: "Chat message",
      })
    : "";
  const preparedImages = await prepareImageUploads(getFlags(args, "image"));
  if (!message.trim() && preparedImages.length === 0) {
    throw new CliUsageError(
      "Chat message text or at least one image is required.",
    );
  }
  let sessionId = getFlag(args, "session-id")?.trim();
  if (!sessionId) {
    const created = await client.request<{ sessionId: string }>(
      "gateway:createSession",
      {},
    );
    sessionId = created.sessionId;
  }
  const before = await getSession(client, sessionId);
  const images = await uploadImages(client, preparedImages);
  const startMode =
    requestedMode === "auto"
      ? before?.isBusy
        ? "inserted"
        : "normal"
      : requestedMode;
  await client.request("agent:startTaskAsync", {
    sessionId,
    userInput: { text: message, ...(images.length > 0 ? { images } : {}) },
    options: { startMode },
  });
  if (!shouldWait) {
    return { sessionId, accepted: true, startMode, imageCount: images.length };
  }
  return await waitForSession(client, sessionId, waitTimeoutMs ?? 600_000, {
    messageKeys: collectMessageKeys(before),
    approvalKeys: collectPendingApprovalKeys(before),
  });
}

async function chatWait(
  args: ParsedArguments,
  client: RpcClient,
): Promise<unknown> {
  return await waitForSession(
    client,
    requiredFlag(args, "session-id"),
    integerFlag(args, "wait-timeout", 600_000, {
      min: 1,
      max: MAX_TIMER_DELAY_MS,
    }),
  );
}

async function chatStop(
  args: ParsedArguments,
  client: RpcClient,
): Promise<unknown> {
  const sessionId = requiredFlag(args, "session-id");
  await client.request("agent:stopTask", { sessionId });
  return { sessionId, stopped: true };
}

async function approvalReply(
  args: ParsedArguments,
  client: RpcClient,
): Promise<unknown> {
  const approvalId = getFlag(args, "approval-id")?.trim();
  const backendMessageId = getFlag(args, "backend-message-id")?.trim();
  if (!!approvalId === !!backendMessageId) {
    throw new CliUsageError(
      "Provide exactly one of --approval-id or --backend-message-id.",
    );
  }
  const decision = enumFlag(args, "decision", ["allow", "deny"] as const);
  if (approvalId) {
    await client.request("agent:replyCommandApproval", {
      approvalId,
      decision,
    });
  } else {
    await client.request("agent:replyMessage", {
      messageId: backendMessageId,
      payload: { decision },
    });
  }
  return { approvalId, backendMessageId, decision, replied: true };
}

async function terminalList(
  _args: ParsedArguments,
  client: RpcClient,
): Promise<unknown> {
  return await client.request("terminal:list", {});
}

async function terminalCreate(
  args: ParsedArguments,
  client: RpcClient,
): Promise<unknown> {
  const type = enumFlag(args, "type", ["local", "ssh"] as const, "local");
  const cols = integerFlag(args, "cols", 120, { min: 1, max: 1000 });
  const rows = integerFlag(args, "rows", 32, { min: 1, max: 1000 });
  let config: Record<string, unknown>;
  if (type === "ssh") {
    if (
      getFlag(args, "title") ||
      getFlag(args, "cwd") ||
      getFlag(args, "shell")
    ) {
      throw new CliUsageError(
        "Saved SSH terminals do not accept --title, --cwd, or --shell overrides.",
      );
    }
    const settings = await client.request("settings:get", {});
    config = buildSavedSshConfig(
      settings,
      requiredFlag(args, "connection-id"),
      cols,
      rows,
    );
  } else {
    if (getFlag(args, "connection-id")) {
      throw new CliUsageError("--connection-id is only valid with --type ssh.");
    }
    config = {
      type: "local",
      cols,
      rows,
      ...(getFlag(args, "title") ? { title: getFlag(args, "title") } : {}),
      ...(getFlag(args, "cwd") ? { cwd: getFlag(args, "cwd") } : {}),
      ...(getFlag(args, "shell") ? { shell: getFlag(args, "shell") } : {}),
    };
  }
  const created = await client.request<{ id: string }>("terminal:createTab", {
    config,
  });
  return { ...created, type };
}

async function terminalWrite(
  args: ParsedArguments,
  client: RpcClient,
  io: CliIo,
): Promise<unknown> {
  let data = await readTextSource(args, io, {
    flag: "data",
    label: "Terminal data",
  });
  if (hasFlag(args, "enter")) data += "\r";
  const terminalId = requiredFlag(args, "terminal-id");
  await client.request("terminal:write", { terminalId, data });
  return { terminalId, bytesWritten: Buffer.byteLength(data) };
}

async function terminalResize(
  args: ParsedArguments,
  client: RpcClient,
): Promise<unknown> {
  const terminalId = requiredFlag(args, "terminal-id");
  const cols = integerFlag(args, "cols", undefined, { min: 1, max: 1000 });
  const rows = integerFlag(args, "rows", undefined, { min: 1, max: 1000 });
  await client.request("terminal:resize", { terminalId, cols, rows });
  return { terminalId, cols, rows };
}

async function terminalBuffer(
  args: ParsedArguments,
  client: RpcClient,
): Promise<unknown> {
  return await client.request("terminal:getBufferDelta", {
    terminalId: requiredFlag(args, "terminal-id"),
    fromOffset: integerFlag(args, "from-offset", 0, { min: 0 }),
  });
}

async function terminalReconnect(
  args: ParsedArguments,
  client: RpcClient,
): Promise<unknown> {
  return await client.request("terminal:reconnect", {
    terminalId: requiredFlag(args, "terminal-id"),
  });
}

async function terminalClose(
  args: ParsedArguments,
  client: RpcClient,
): Promise<unknown> {
  const terminalId = requiredFlag(args, "terminal-id");
  await client.request("terminal:kill", { terminalId });
  return { terminalId, closed: true };
}

async function profileList(
  _args: ParsedArguments,
  client: RpcClient,
): Promise<unknown> {
  return await client.request("models:getProfiles", {});
}

async function profileUse(
  args: ParsedArguments,
  client: RpcClient,
): Promise<unknown> {
  return await client.request("models:setActiveProfile", {
    profileId: requiredFlag(args, "profile-id"),
  });
}

async function skillList(
  _args: ParsedArguments,
  client: RpcClient,
): Promise<unknown> {
  return await client.request("skills:list", {});
}

async function skillReload(
  _args: ParsedArguments,
  client: RpcClient,
): Promise<unknown> {
  await client.request("skills:reload", {});
  return await client.request("skills:list", {});
}

async function setSkill(
  args: ParsedArguments,
  client: RpcClient,
  enabled: boolean,
): Promise<unknown> {
  return await client.request("skills:setEnabled", {
    name: requiredFlag(args, "name"),
    enabled,
  });
}

async function skillEnable(
  args: ParsedArguments,
  client: RpcClient,
): Promise<unknown> {
  return await setSkill(args, client, true);
}

async function skillDisable(
  args: ParsedArguments,
  client: RpcClient,
): Promise<unknown> {
  return await setSkill(args, client, false);
}

async function toolList(
  _args: ParsedArguments,
  client: RpcClient,
): Promise<unknown> {
  const [mcp, builtIn] = await Promise.all([
    client.request("tools:getMcp", {}),
    client.request("tools:getBuiltIn", {}),
  ]);
  return { mcp, builtIn };
}

async function toolReload(
  args: ParsedArguments,
  client: RpcClient,
): Promise<unknown> {
  await client.request("tools:reloadMcp", {});
  return await toolList(args, client);
}

async function setTool(
  args: ParsedArguments,
  client: RpcClient,
  enabled: boolean,
): Promise<unknown> {
  const kind = enumFlag(args, "kind", ["mcp", "built-in"] as const);
  const name = requiredFlag(args, "name");
  const method =
    kind === "mcp" ? "tools:setMcpEnabled" : "tools:setBuiltInEnabled";
  const result = await client.request(method, { name, enabled });
  if (kind !== "built-in" || !enabled) return result;
  return await retryExperimentalMutation(args, result, (toolNames) =>
    client.request(method, {
      name,
      enabled,
      acknowledgedExperimentalToolNames: toolNames,
    }),
  );
}

async function toolEnable(
  args: ParsedArguments,
  client: RpcClient,
): Promise<unknown> {
  return await setTool(args, client, true);
}

async function toolDisable(
  args: ParsedArguments,
  client: RpcClient,
): Promise<unknown> {
  return await setTool(args, client, false);
}

async function memoryGet(
  _args: ParsedArguments,
  client: RpcClient,
): Promise<unknown> {
  return await client.request("memory:get", {});
}

async function memorySet(
  args: ParsedArguments,
  client: RpcClient,
  io: CliIo,
): Promise<unknown> {
  const content = await readTextSource(args, io, {
    flag: "content",
    fileFlag: "file",
    label: "Memory content",
  });
  return await client.request("memory:setContent", { content });
}

async function agentSettingList(
  _args: ParsedArguments,
  client: RpcClient,
): Promise<unknown> {
  return await client.request("agentSettings:get", {});
}

async function agentSettingSave(
  _args: ParsedArguments,
  client: RpcClient,
): Promise<unknown> {
  return await client.request("agentSettings:saveCurrent", {});
}

async function agentSettingApply(
  args: ParsedArguments,
  client: RpcClient,
): Promise<unknown> {
  const profileId = requiredFlag(args, "profile-id");
  const result = await client.request("agentSettings:apply", { profileId });
  return await retryExperimentalMutation(args, result, (toolNames) =>
    client.request("agentSettings:apply", {
      profileId,
      acknowledgedExperimentalToolNames: toolNames,
    }),
  );
}

async function retryExperimentalMutation(
  args: ParsedArguments,
  result: unknown,
  retry: (toolNames: string[]) => Promise<unknown>,
): Promise<unknown> {
  const toolNames = readExperimentalConfirmationToolNames(result);
  if (!toolNames) return result;
  if (!hasFlag(args, "ack-experimental-risk")) {
    throw new CliUsageError(
      `Enabling experimental tools (${toolNames.join(", ")}) requires an explicit risk acknowledgement. Re-run with --ack-experimental-risk to confirm that the Agent may use them without another approval prompt.`,
    );
  }
  const retried = await retry(toolNames);
  const remaining = readExperimentalConfirmationToolNames(retried);
  if (remaining) {
    throw new CliUsageError(
      `Experimental tool state changed while applying the request (${remaining.join(", ")}). Review the current settings and run the command again.`,
    );
  }
  return retried;
}

function readExperimentalConfirmationToolNames(
  value: unknown,
): string[] | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (record.kind !== "experimental_tool_confirmation_required") return null;
  if (!Array.isArray(record.experimentalToolNames)) return null;
  const names = Array.from(
    new Set(
      record.experimentalToolNames.filter(
        (name): name is string => typeof name === "string" && name.length > 0,
      ),
    ),
  ).sort();
  return names.length > 0 ? names : null;
}

async function agentSettingOverwrite(
  args: ParsedArguments,
  client: RpcClient,
): Promise<unknown> {
  return await client.request("agentSettings:overwrite", {
    profileId: requiredFlag(args, "profile-id"),
  });
}

async function agentSettingDelete(
  args: ParsedArguments,
  client: RpcClient,
): Promise<unknown> {
  return await client.request("agentSettings:delete", {
    profileId: requiredFlag(args, "profile-id"),
  });
}

async function policyList(
  _args: ParsedArguments,
  client: RpcClient,
): Promise<unknown> {
  return await client.request("settings:getCommandPolicyLists", {});
}

async function mutatePolicy(
  args: ParsedArguments,
  client: RpcClient,
  method: string,
): Promise<unknown> {
  const listName = enumFlag(args, "list", [
    "allowlist",
    "denylist",
    "asklist",
  ] as const);
  return await client.request(method, {
    listName,
    rule: requiredFlag(args, "rule"),
  });
}

async function policyAdd(
  args: ParsedArguments,
  client: RpcClient,
): Promise<unknown> {
  return await mutatePolicy(args, client, "settings:addCommandPolicyRule");
}

async function policyDelete(
  args: ParsedArguments,
  client: RpcClient,
): Promise<unknown> {
  return await mutatePolicy(args, client, "settings:deleteCommandPolicyRule");
}

async function settingsGet(
  args: ParsedArguments,
  client: RpcClient,
): Promise<unknown> {
  const settings = await client.request("settings:get", {});
  return hasFlag(args, "include-secrets") ? settings : redactSecrets(settings);
}

async function settingsSet(
  args: ParsedArguments,
  client: RpcClient,
  io: CliIo,
): Promise<unknown> {
  const settings = await readJsonSource(args, io, {
    flag: "json",
    fileFlag: "file",
    label: "Settings patch",
  });
  const result = await client.request("settings:set", { settings });
  return redactSecrets(result);
}

async function rawRpc(
  args: ParsedArguments,
  client: RpcClient,
  io: CliIo,
): Promise<unknown> {
  const method = args.positional[1]?.trim();
  if (!method) throw new CliUsageError("rpc requires a method name.");
  const hasParams =
    getFlag(args, "params") !== undefined ||
    getFlag(args, "file") !== undefined ||
    hasFlag(args, "stdin");
  const params = hasParams
    ? await readJsonSource(args, io, {
        flag: "params",
        fileFlag: "file",
        label: "RPC params",
      })
    : {};
  return await client.request(method, params);
}

async function getSession(
  client: RpcClient,
  sessionId: string,
): Promise<GatewaySessionSnapshot> {
  const payload = await client.request<{ session: GatewaySessionSnapshot }>(
    "session:get",
    { sessionId },
  );
  return payload.session;
}

function pendingApproval(
  snapshot: GatewaySessionSnapshot,
  ignoredKeys: Set<string> = new Set(),
): Record<string, unknown> | null {
  for (let index = snapshot.messages.length - 1; index >= 0; index -= 1) {
    const message = snapshot.messages[index];
    if (message.type !== "ask") continue;
    const metadata = message.metadata;
    if (metadata && typeof metadata === "object" && !Array.isArray(metadata)) {
      if ((metadata as Record<string, unknown>).decision) continue;
    }
    if (ignoredKeys.has(approvalKey(message))) continue;
    return message;
  }
  return null;
}

async function waitForSession(
  client: RpcClient,
  sessionId: string,
  timeoutMs: number,
  baseline?: WaitBaseline,
): Promise<unknown> {
  return await new Promise<unknown>((resolve, reject) => {
    let settled = false;
    let checking = false;
    let approvalFromEvent: Record<string, unknown> | null = null;
    let activityObserved = !baseline;
    const finish = (value: unknown): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      clearInterval(poll);
      unsubscribe();
      resolve(value);
    };
    const fail = (error: unknown): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      clearInterval(poll);
      unsubscribe();
      reject(error);
    };
    const check = async (): Promise<void> => {
      if (settled || checking) return;
      checking = true;
      try {
        const session = await getSession(client, sessionId);
        if (baseline && hasNewUserMessage(session, baseline.messageKeys)) {
          activityObserved = true;
        }
        const approval =
          approvalFromEvent ||
          pendingApproval(session, baseline?.approvalKeys ?? new Set());
        if (approval) {
          finish({ status: "approval_required", sessionId, approval, session });
        } else if (!session.isBusy && activityObserved) {
          finish({ status: "completed", sessionId, session });
        }
      } catch (error) {
        fail(error);
      } finally {
        checking = false;
      }
    };
    const unsubscribe = client.onUiUpdate((update: GatewayUiUpdate) => {
      if (update.sessionId !== sessionId) return;
      if (
        update.type === "ADD_MESSAGE" &&
        update.message?.type === "ask" &&
        !baseline?.approvalKeys.has(approvalKey(update.message))
      ) {
        approvalFromEvent = update.message;
      }
      if (
        baseline &&
        update.type === "ADD_MESSAGE" &&
        update.message &&
        update.message.role === "user" &&
        !baseline.messageKeys.has(messageKey(update.message))
      ) {
        activityObserved = true;
      }
      if (update.type === "SESSION_READY" || approvalFromEvent) void check();
    });
    const poll = setInterval(() => void check(), 500);
    const timeout = setTimeout(async () => {
      try {
        const session = await getSession(client, sessionId);
        if (baseline && hasNewUserMessage(session, baseline.messageKeys)) {
          activityObserved = true;
        }
        finish({
          status: session.isBusy
            ? "running"
            : activityObserved
              ? "completed"
              : "pending",
          sessionId,
          timedOut: session.isBusy || !activityObserved,
          session,
        });
      } catch (error) {
        fail(error);
      }
    }, timeoutMs);
    void check();
  });
}

function messageKey(message: Record<string, unknown>): string {
  const backendMessageId =
    typeof message.backendMessageId === "string"
      ? message.backendMessageId
      : "";
  const id = typeof message.id === "string" ? message.id : "";
  return backendMessageId || id;
}

function collectMessageKeys(snapshot: GatewaySessionSnapshot): Set<string> {
  return new Set(snapshot.messages.map(messageKey).filter(Boolean));
}

function approvalKey(message: Record<string, unknown>): string {
  const metadata =
    message.metadata &&
    typeof message.metadata === "object" &&
    !Array.isArray(message.metadata)
      ? (message.metadata as Record<string, unknown>)
      : null;
  const approvalId =
    typeof metadata?.approvalId === "string" ? metadata.approvalId : "";
  return approvalId || messageKey(message);
}

function collectPendingApprovalKeys(
  snapshot: GatewaySessionSnapshot,
): Set<string> {
  return new Set(
    snapshot.messages
      .filter((message) => message.type === "ask")
      .map(approvalKey)
      .filter(Boolean),
  );
}

function hasNewUserMessage(
  snapshot: GatewaySessionSnapshot,
  baselineKeys: Set<string>,
): boolean {
  return snapshot.messages.some((message) => {
    const key = messageKey(message);
    return message.role === "user" && !!key && !baselineKeys.has(key);
  });
}

async function prepareImageUploads(
  imagePaths: string[],
): Promise<PreparedImageUpload[]> {
  const prepared: PreparedImageUpload[] = [];
  for (const imagePath of imagePaths) {
    const extension = path.extname(imagePath).toLowerCase();
    const mimeType = IMAGE_MIME_BY_EXTENSION[extension];
    if (!mimeType)
      throw new CliUsageError(`Unsupported image type: ${imagePath}`);
    const bytes = await fs.readFile(imagePath);
    prepared.push({
      dataBase64: bytes.toString("base64"),
      fileName: path.basename(imagePath),
      mimeType,
    });
  }
  return prepared;
}

async function uploadImages(
  client: RpcClient,
  images: PreparedImageUpload[],
): Promise<Array<Record<string, unknown>>> {
  const attachments: Array<Record<string, unknown>> = [];
  for (const image of images) {
    const attachment = await client.request<Record<string, unknown>>(
      "system:saveImageAttachment",
      {
        payload: image,
      },
    );
    attachments.push(attachment);
  }
  return attachments;
}

export function redactSecrets(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => redactSecrets(item));
  if (!value || typeof value !== "object") return value;
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    output[key] =
      SECRET_KEY.test(key) && item ? "[REDACTED]" : redactSecrets(item);
  }
  return output;
}
