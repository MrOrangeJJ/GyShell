import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import * as net from "node:net";
import { PortForwardType, type SSHConnectionConfig } from "../types";
import { SSHBackend } from "./SSHBackend";

type ForwardCallback = (error?: Error, stream?: LateForwardStream) => void;

class PendingForwardClient extends EventEmitter {
  forwardCallback: ForwardCallback | undefined;
  forwardCalls = 0;
  private resolveForwardRequested: (() => void) | undefined;
  readonly forwardRequested = new Promise<void>((resolve) => {
    this.resolveForwardRequested = resolve;
  });

  forwardOut(
    _sourceHost: string,
    _sourcePort: number,
    _targetHost: string,
    _targetPort: number,
    callback: ForwardCallback,
  ): void {
    this.forwardCalls += 1;
    this.forwardCallback = callback;
    this.resolveForwardRequested?.();
  }
}

class LateForwardStream extends EventEmitter {
  destroyCalls = 0;

  destroy(): this {
    this.destroyCalls += 1;
    this.emit("close");
    return this;
  }
}

const createForwardSession = (client: PendingForwardClient) =>
  ({
    client,
    dataCallbacks: new Set(),
    exitCallbacks: new Set(),
    forwardServers: [],
    remoteForwards: [],
    remoteForwardHandlerInstalled: false,
  }) as any;

const createForwardConfig = (
  type: PortForwardType.Local | PortForwardType.Dynamic,
): SSHConnectionConfig => ({
  type: "ssh",
  id: `forward-${type.toLowerCase()}`,
  title: `${type} forward`,
  cols: 80,
  rows: 24,
  host: "ssh.example.test",
  port: 22,
  username: "test",
  authMethod: "password",
  password: "secret",
  tunnels: [
    {
      id: `tunnel-${type.toLowerCase()}`,
      name: `${type} tunnel`,
      type,
      host: "127.0.0.1",
      port: 0,
      ...(type === PortForwardType.Local
        ? { targetAddress: "127.0.0.1", targetPort: 8080 }
        : {}),
    },
  ],
});

const getListenPort = (server: net.Server): number => {
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return address.port;
};

const connectToServer = async (server: net.Server): Promise<net.Socket> => {
  const socket = net.createConnection({
    host: "127.0.0.1",
    port: getListenPort(server),
  });
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  socket.on("error", () => {});
  socket.on("data", () => {});
  await new Promise<void>((resolve) => setImmediate(resolve));
  return socket;
};

const waitForSocketClose = (socket: net.Socket): Promise<void> =>
  new Promise<void>((resolve, reject) => {
    if (socket.destroyed) {
      resolve();
      return;
    }
    const timer = setTimeout(
      () => reject(new Error("Timed out waiting for forwarded socket close.")),
      1_000,
    );
    socket.once("close", () => {
      clearTimeout(timer);
      resolve();
    });
  });

const closeServer = async (server: net.Server): Promise<void> => {
  if (!server.listening) return;
  await new Promise<void>((resolve) => server.close(() => resolve()));
};

const runCase = async (
  name: string,
  fn: () => Promise<void> | void,
): Promise<void> => {
  await fn();
  console.log(`PASS ${name}`);
};

await runCase(
  "fatal cancellation closes a Dynamic SOCKS socket stalled in handshake",
  async () => {
    const backend = new SSHBackend() as any;
    const client = new PendingForwardClient();
    const instance = createForwardSession(client);
    const controller = new AbortController();
    await backend.setupPortForwards(
      instance,
      createForwardConfig(PortForwardType.Dynamic),
      controller.signal,
    );
    const server = instance.forwardServers[0] as net.Server;

    try {
      const socket = await connectToServer(server);
      socket.write(Buffer.from([0x05]));
      const closed = waitForSocketClose(socket);
      controller.abort();
      await closed;
      assert.equal(client.forwardCalls, 0);
    } finally {
      await closeServer(server);
    }
  },
);

await runCase(
  "fatal cancellation closes a Local forward and rejects its late SSH channel",
  async () => {
    const backend = new SSHBackend() as any;
    const client = new PendingForwardClient();
    const instance = createForwardSession(client);
    const controller = new AbortController();
    await backend.setupPortForwards(
      instance,
      createForwardConfig(PortForwardType.Local),
      controller.signal,
    );
    const server = instance.forwardServers[0] as net.Server;

    try {
      const socket = await connectToServer(server);
      await client.forwardRequested;
      const closed = waitForSocketClose(socket);
      controller.abort();
      await closed;

      const lateStream = new LateForwardStream();
      client.forwardCallback?.(undefined, lateStream);
      assert.equal(lateStream.destroyCalls, 1);
    } finally {
      await closeServer(server);
    }
  },
);

await runCase(
  "Dynamic SOCKS rechecks cancellation after an asynchronous forwardOut",
  async () => {
    const backend = new SSHBackend() as any;
    const client = new PendingForwardClient();
    const instance = createForwardSession(client);
    const controller = new AbortController();
    await backend.setupPortForwards(
      instance,
      createForwardConfig(PortForwardType.Dynamic),
      controller.signal,
    );
    const server = instance.forwardServers[0] as net.Server;

    try {
      const socket = await connectToServer(server);
      socket.write(
        Buffer.from([
          0x05, 0x01, 0x00, 0x05, 0x01, 0x00, 0x01, 127, 0, 0, 1, 0x00, 0x50,
        ]),
      );
      await client.forwardRequested;
      const closed = waitForSocketClose(socket);
      controller.abort();
      await closed;

      const lateStream = new LateForwardStream();
      client.forwardCallback?.(undefined, lateStream);
      assert.equal(lateStream.destroyCalls, 1);
    } finally {
      await closeServer(server);
    }
  },
);

await runCase(
  "a listening forward server retains a no-throw lifetime error handler",
  async () => {
    class FakeServer extends EventEmitter {
      listen(_port: number, _host: string, callback: () => void): void {
        callback();
      }

      close(): void {
        this.emit("close");
      }
    }

    const backend = new SSHBackend() as any;
    const server = new FakeServer();
    const controller = new AbortController();
    const originalConsoleError = console.error;
    const logged: unknown[][] = [];
    console.error = (...args: unknown[]) => logged.push(args);
    try {
      await backend.listenForwardServer(
        server,
        "127.0.0.1",
        0,
        controller.signal,
      );
      assert.doesNotThrow(() =>
        server.emit("error", new Error("simulated late listener error")),
      );
      assert.equal(logged.length, 1);
      server.close();
      assert.equal(server.listenerCount("error"), 0);
    } finally {
      console.error = originalConsoleError;
    }
  },
);
