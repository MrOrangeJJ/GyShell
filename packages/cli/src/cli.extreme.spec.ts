import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { parseArguments } from "./arguments";
import { executeCommand, redactSecrets, validateCommand } from "./commands";
import { runCli } from "./index";
import { GatewayClient, sanitizeGatewayUrl } from "./gateway-client";
import { buildSavedSshConfig } from "./ssh-config";
import type {
  CliIo,
  GatewayUiUpdate,
  ParsedArguments,
  RpcClient,
} from "./types";

class FakeClient implements RpcClient {
  readonly calls: Array<{ method: string; params: Record<string, unknown> }> =
    [];
  readonly responses = new Map<string, unknown>();
  private listeners = new Set<(update: GatewayUiUpdate) => void>();

  async connect(): Promise<void> {}

  async request<T>(
    method: string,
    params: Record<string, unknown> = {},
  ): Promise<T> {
    this.calls.push({ method, params });
    if (!this.responses.has(method)) return { ok: true } as T;
    const response = this.responses.get(method);
    if (typeof response === "function") {
      return (response as (params: Record<string, unknown>) => T)(params);
    }
    return response as T;
  }

  onUiUpdate(listener: (update: GatewayUiUpdate) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(update: GatewayUiUpdate): void {
    this.listeners.forEach((listener) => listener(update));
  }

  close(): void {}
}

function io(stdin = ""): { io: CliIo; stdout: string[]; stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    io: {
      stdin: Readable.from([stdin]),
      stdout: { write: (value) => (stdout.push(String(value)), true) },
      stderr: { write: (value) => (stderr.push(String(value)), true) },
    },
  };
}

function args(argv: string[]): ParsedArguments {
  return parseArguments(argv, {});
}

async function runCase(
  name: string,
  test: () => void | Promise<void>,
): Promise<void> {
  await test();
  process.stdout.write(`PASS ${name}\n`);
}

await runCase(
  "argument parsing keeps repeated image flags and environment defaults",
  () => {
    const parsed = parseArguments(
      ["chat", "send", "hello", "--image", "a.png", "--image=b.jpg"],
      { GYBACKEND_WS_PORT: "18888", GYSHELL_TOKEN: "secret" },
    );
    assert.deepEqual(parsed.positional, ["chat", "send", "hello"]);
    assert.deepEqual(parsed.flags.get("image"), ["a.png", "b.jpg"]);
    assert.equal(parsed.global.url, "ws://127.0.0.1:18888");
    assert.equal(parsed.global.token, "secret");
  },
);

await runCase("boolean switches reject explicit values", () => {
  assert.throws(
    () => parseArguments(["settings", "get", "--include-secrets=false"], {}),
    /boolean switch and does not accept a value/,
  );
  assert.throws(
    () => parseArguments(["chat", "send", "work", "--wait=false"], {}),
    /boolean switch and does not accept a value/,
  );
});

await runCase("timer flags reject Node timeout overflows", () => {
  assert.throws(
    () => parseArguments(["status", "--timeout", "2147483648"], {}),
    /must be at most 2147483647/,
  );
  assert.throws(
    () =>
      validateCommand(
        args([
          "chat",
          "wait",
          "--session-id",
          "session-1",
          "--wait-timeout",
          "2147483648",
        ]),
      ),
    /must be at most 2147483647/,
  );
});

await runCase(
  "session rename uses the stable gateway RPC contract",
  async () => {
    const client = new FakeClient();
    client.responses.set("session:get", {
      session: {
        id: "s1",
        title: "Next",
        updatedAt: 1,
        messages: [],
        isBusy: false,
        lockedProfileId: null,
      },
    });
    const result = await executeCommand(
      args(["session", "rename", "--session-id", "s1", "--title", "Next"]),
      client,
      io().io,
    );
    assert.equal(result.command, "session.rename");
    assert.deepEqual(client.calls[0], {
      method: "agent:renameSession",
      params: { sessionId: "s1", newTitle: "Next" },
    });
  },
);

await runCase(
  "chat hook creates a session and dispatches asynchronously",
  async () => {
    const client = new FakeClient();
    client.responses.set("gateway:createSession", { sessionId: "new-session" });
    client.responses.set("session:get", {
      session: {
        id: "new-session",
        title: "New Chat",
        updatedAt: 1,
        messages: [],
        isBusy: false,
        lockedProfileId: null,
      },
    });
    const result = await executeCommand(
      args(["hook", "do", "the", "work"]),
      client,
      io().io,
    );
    assert.equal(result.command, "chat.send");
    assert.deepEqual(client.calls.at(-1), {
      method: "agent:startTaskAsync",
      params: {
        sessionId: "new-session",
        userInput: { text: "do the work" },
        options: { startMode: "normal" },
      },
    });
  },
);

await runCase(
  "chat send validates wait timeout before creating or dispatching",
  async () => {
    const client = new FakeClient();
    await assert.rejects(
      executeCommand(
        args(["chat", "send", "work", "--wait", "--wait-timeout", "invalid"]),
        client,
        io().io,
      ),
      /wait-timeout must be an integer/,
    );
    assert.deepEqual(client.calls, []);
  },
);

await runCase(
  "chat send preserves explicit session lookup failures",
  async () => {
    const client = new FakeClient();
    client.responses.set("session:get", () => {
      throw new Error("NOT_FOUND: Session not found: missing-session");
    });
    await assert.rejects(
      executeCommand(
        args(["chat", "send", "work", "--session-id", "missing-session"]),
        client,
        io().io,
      ),
      /Session not found/,
    );
    assert.equal(
      client.calls.some((call) => call.method === "agent:startTaskAsync"),
      false,
    );
    assert.equal(
      client.calls.some((call) => call.method === "gateway:createSession"),
      false,
    );
  },
);

await runCase(
  "chat send validates every image before creating a session",
  async () => {
    const client = new FakeClient();
    await assert.rejects(
      executeCommand(
        args(["chat", "send", "inspect", "--image", "unsupported.txt"]),
        client,
        io().io,
      ),
      /Unsupported image type/,
    );
    assert.deepEqual(client.calls, []);
  },
);

await runCase("chat send supports image-only prompts", async () => {
  const client = new FakeClient();
  const imagePath = fileURLToPath(
    new URL("../../../demo_imgs/icon.png", import.meta.url),
  );
  client.responses.set("gateway:createSession", { sessionId: "image-session" });
  client.responses.set("session:get", {
    session: {
      id: "image-session",
      title: "New Chat",
      updatedAt: 1,
      messages: [],
      isBusy: false,
      lockedProfileId: null,
    },
  });
  client.responses.set("system:saveImageAttachment", {
    attachmentId: "image-1",
    status: "ready",
  });
  await executeCommand(
    args(["chat", "send", "--image", imagePath]),
    client,
    io().io,
  );
  const dispatch = client.calls.find(
    (call) => call.method === "agent:startTaskAsync",
  );
  assert.deepEqual(dispatch?.params.userInput, {
    text: "",
    images: [{ attachmentId: "image-1", status: "ready" }],
  });
});

await runCase("chat send rejects an empty combined payload", () => {
  assert.throws(
    () => validateCommand(args(["chat", "send", "--message", ""])),
    /text or at least one image is required/,
  );
});

await runCase("chat send wait ignores the pre-run idle gap", async () => {
  const client = new FakeClient();
  let snapshotReadCount = 0;
  client.responses.set("session:get", () => {
    snapshotReadCount += 1;
    const hasNewUserMessage = snapshotReadCount >= 3;
    return {
      session: {
        id: "existing-session",
        title: "Existing",
        updatedAt: hasNewUserMessage ? 2 : 1,
        messages: hasNewUserMessage
          ? [{ id: "new-user", role: "user", type: "text", content: "work" }]
          : [],
        isBusy: false,
        lockedProfileId: null,
      },
    };
  });
  const result = await executeCommand(
    args([
      "chat",
      "send",
      "work",
      "--session-id",
      "existing-session",
      "--wait",
      "--wait-timeout",
      "2000",
    ]),
    client,
    io().io,
  );
  assert.equal((result.data as { status: string }).status, "completed");
  assert.ok(snapshotReadCount >= 3, "wait must observe the new user message");
});

await runCase(
  "chat send wait ignores approvals from the dispatch baseline",
  async () => {
    const client = new FakeClient();
    let snapshotReadCount = 0;
    client.responses.set("session:get", () => {
      snapshotReadCount += 1;
      const hasNewUserMessage = snapshotReadCount >= 3;
      return {
        session: {
          id: "approval-session",
          title: "Approval",
          updatedAt: hasNewUserMessage ? 2 : 1,
          messages: [
            {
              id: "old-ask-ui",
              backendMessageId: "old-ask-backend",
              role: "system",
              type: "ask",
              content: "Old approval",
              metadata: { approvalId: "old-approval" },
            },
            ...(hasNewUserMessage
              ? [
                  {
                    id: "new-user",
                    role: "user",
                    type: "text",
                    content: "replacement work",
                  },
                ]
              : []),
          ],
          isBusy: snapshotReadCount === 1,
          lockedProfileId: null,
        },
      };
    });
    const result = await executeCommand(
      args([
        "chat",
        "send",
        "replacement work",
        "--session-id",
        "approval-session",
        "--wait",
        "--wait-timeout",
        "2000",
      ]),
      client,
      io().io,
    );
    assert.equal((result.data as { status: string }).status, "completed");
  },
);

await runCase("saved SSH config resolves proxy, tunnel, and jump host", () => {
  const config = buildSavedSshConfig(
    {
      connections: {
        proxies: [
          { id: "proxy-1", type: "socks5", host: "127.0.0.1", port: 1080 },
        ],
        tunnels: [
          { id: "tunnel-1", type: "Local", host: "127.0.0.1", port: 9000 },
        ],
        ssh: [
          {
            id: "ssh-1",
            name: "Server",
            host: "server.example",
            port: 22,
            username: "agent",
            authMethod: "password",
            password: "secret",
            proxyId: "proxy-1",
            tunnelIds: ["tunnel-1"],
            jumpHost: {
              host: "jump.example",
              port: 22,
              username: "jump",
              authMethod: "password",
            },
          },
        ],
      },
    },
    "ssh-1",
    100,
    40,
  );
  assert.equal(config.host, "server.example");
  assert.equal((config.proxy as Record<string, unknown>).id, "proxy-1");
  assert.equal((config.tunnels as unknown[]).length, 1);
  assert.equal(
    (config.jumpHost as Record<string, unknown>).host,
    "jump.example",
  );
});

await runCase(
  "chat wait surfaces a pending approval without approving it",
  async () => {
    const client = new FakeClient();
    client.responses.set("session:get", {
      session: {
        id: "waiting-session",
        title: "Waiting",
        updatedAt: 1,
        messages: [
          {
            id: "ask-1",
            backendMessageId: "backend-ask-1",
            role: "assistant",
            type: "ask",
            content: "Allow command?",
            metadata: { approvalId: "approval-1" },
          },
        ],
        isBusy: true,
        lockedProfileId: "profile-1",
      },
    });
    const result = await executeCommand(
      args([
        "chat",
        "wait",
        "--session-id",
        "waiting-session",
        "--wait-timeout",
        "1000",
      ]),
      client,
      io().io,
    );
    assert.equal(
      (result.data as { status: string }).status,
      "approval_required",
    );
    assert.equal(
      (result.data as { approval: { metadata: { approvalId: string } } })
        .approval.metadata.approvalId,
      "approval-1",
    );
    assert.equal(
      client.calls.some((call) => call.method === "agent:replyCommandApproval"),
      false,
    );
  },
);

await runCase(
  "approval reply sends the canonical backend message id",
  async () => {
    const client = new FakeClient();
    await executeCommand(
      args([
        "approval",
        "reply",
        "--backend-message-id",
        "backend-ask-1",
        "--decision",
        "deny",
      ]),
      client,
      io().io,
    );
    assert.deepEqual(client.calls.at(-1), {
      method: "agent:replyMessage",
      params: {
        messageId: "backend-ask-1",
        payload: { decision: "deny" },
      },
    });
  },
);

await runCase("settings output redacts nested credentials by default", () => {
  assert.deepEqual(
    redactSecrets({
      apiKey: "one",
      nested: { password: "two", safe: "visible" },
      emptyToken: "",
    }),
    {
      apiKey: "[REDACTED]",
      nested: { password: "[REDACTED]", safe: "visible" },
      emptyToken: "",
    },
  );
});

await runCase(
  "gateway error URLs redact query and authority credentials",
  () => {
    const sanitized = sanitizeGatewayUrl(
      "ws://agent:password@example.test:17888/?access_token=top-secret&safe=value",
    );
    assert.doesNotMatch(sanitized, /password|top-secret/);
    assert.match(sanitized, /safe=value/);
  },
);

await runCase(
  "synchronous websocket construction errors redact URL tokens",
  async () => {
    const client = new GatewayClient(
      "ws://[invalid]?access_token=top-secret",
      undefined,
      100,
    );
    let message = "";
    try {
      await client.connect();
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    assert.match(message, /Unable to connect/);
    assert.doesNotMatch(message, /top-secret/);
  },
);

await runCase(
  "experimental tool enable requires an explicit CLI risk acknowledgement",
  async () => {
    const challenge = {
      kind: "experimental_tool_confirmation_required",
      experimentalToolNames: ["create_terminal_tab"],
    };
    const withoutAck = new FakeClient();
    withoutAck.responses.set("tools:setBuiltInEnabled", challenge);
    await assert.rejects(
      executeCommand(
        args([
          "tool",
          "enable",
          "--kind",
          "built-in",
          "--name",
          "create_terminal_tab",
        ]),
        withoutAck,
        io().io,
      ),
      /--ack-experimental-risk/,
    );
    assert.equal(withoutAck.calls.length, 1);

    const withAck = new FakeClient();
    withAck.responses.set(
      "tools:setBuiltInEnabled",
      (params: Record<string, unknown>) =>
        Array.isArray(params.acknowledgedExperimentalToolNames)
          ? [{ name: "create_terminal_tab", enabled: true }]
          : challenge,
    );
    const result = await executeCommand(
      args([
        "tool",
        "enable",
        "--kind",
        "built-in",
        "--name",
        "create_terminal_tab",
        "--ack-experimental-risk",
      ]),
      withAck,
      io().io,
    );
    assert.deepEqual(result.data, [
      { name: "create_terminal_tab", enabled: true },
    ]);
    assert.deepEqual(withAck.calls[1]?.params, {
      name: "create_terminal_tab",
      enabled: true,
      acknowledgedExperimentalToolNames: ["create_terminal_tab"],
    });
  },
);

await runCase(
  "agent setting apply retries a consent challenge only with the CLI risk flag",
  async () => {
    const client = new FakeClient();
    client.responses.set(
      "agentSettings:apply",
      (params: Record<string, unknown>) =>
        Array.isArray(params.acknowledgedExperimentalToolNames)
          ? { settings: { applied: true } }
          : {
              kind: "experimental_tool_confirmation_required",
              experimentalToolNames: ["close_terminal_tab"],
            },
    );
    await executeCommand(
      args([
        "agent-setting",
        "apply",
        "--profile-id",
        "agent-setting-slot-1",
        "--ack-experimental-risk",
      ]),
      client,
      io().io,
    );
    assert.deepEqual(client.calls[1]?.params, {
      profileId: "agent-setting-slot-1",
      acknowledgedExperimentalToolNames: ["close_terminal_tab"],
    });
  },
);

await runCase(
  "runCli reports unresolved experimental consent as a failed mutation",
  async () => {
    const client = new FakeClient();
    client.responses.set("tools:setBuiltInEnabled", {
      kind: "experimental_tool_confirmation_required",
      experimentalToolNames: ["create_terminal_tab"],
    });
    const streams = io();
    const exitCode = await runCli({
      argv: [
        "tool",
        "enable",
        "--kind",
        "built-in",
        "--name",
        "create_terminal_tab",
      ],
      env: {},
      io: streams.io,
      createClient: () => client,
    });
    assert.equal(exitCode, 2);
    assert.equal(streams.stdout.length, 0);
    assert.match(streams.stderr.join(""), /ack-experimental-risk/);
  },
);

await runCase(
  "runCli rejects unknown options before opening a connection",
  async () => {
    let created = false;
    const streams = io();
    const exitCode = await runCli({
      argv: ["session", "list", "--sesion-id", "typo"],
      env: {},
      io: streams.io,
      createClient: () => {
        created = true;
        return new FakeClient();
      },
    });
    assert.equal(exitCode, 2);
    assert.equal(created, false);
    const error = JSON.parse(streams.stderr.join("")) as {
      error: { code: string };
    };
    assert.equal(error.error.code, "USAGE_ERROR");
  },
);

await runCase(
  "runCli validates required flags before opening a connection",
  async () => {
    let created = false;
    const streams = io();
    const exitCode = await runCli({
      argv: ["session", "get"],
      env: {},
      io: streams.io,
      createClient: () => {
        created = true;
        return new FakeClient();
      },
    });
    assert.equal(exitCode, 2);
    assert.equal(created, false);
    const error = JSON.parse(streams.stderr.join("")) as {
      error: { code: string };
    };
    assert.equal(error.error.code, "USAGE_ERROR");
  },
);

await runCase(
  "runCli prints one machine-readable success envelope",
  async () => {
    const client = new FakeClient();
    client.responses.set("gateway:ping", { pong: true, ts: 123 });
    const streams = io();
    const exitCode = await runCli({
      argv: ["status"],
      env: {},
      io: streams.io,
      createClient: () => client,
    });
    assert.equal(exitCode, 0);
    assert.deepEqual(JSON.parse(streams.stdout.join("")), {
      ok: true,
      command: "status",
      data: { pong: true, ts: 123 },
    });
  },
);

await runCase(
  "node websocket transport authenticates and routes RPC plus UI updates",
  async () => {
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("Missing websocket test address.");
    let authorization = "";
    server.on("connection", (socket, request) => {
      authorization = String(request.headers.authorization || "");
      socket.on("message", (raw) => {
        const payload = JSON.parse(raw.toString()) as { id: string };
        socket.send(
          JSON.stringify({
            type: "gateway:response",
            id: payload.id,
            ok: true,
            result: { pong: true },
          }),
        );
        socket.send(
          JSON.stringify({
            type: "gateway:ui-update",
            payload: { type: "SESSION_READY", sessionId: "session-1" },
          }),
        );
      });
    });

    const client = new GatewayClient(
      `ws://127.0.0.1:${address.port}`,
      "token-value",
      1000,
    );
    const uiUpdate = new Promise<GatewayUiUpdate>((resolve) =>
      client.onUiUpdate(resolve),
    );
    await client.connect();
    const pong = await client.request<{ pong: boolean }>("gateway:ping", {});
    assert.deepEqual(pong, { pong: true });
    assert.equal((await uiUpdate).type, "SESSION_READY");
    assert.equal(authorization, "Bearer token-value");
    client.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  },
);

process.stdout.write("All GyShell CLI tests passed.\n");
