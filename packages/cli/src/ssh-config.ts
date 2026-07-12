import { CliUsageError } from "./errors";

interface ConnectionCollection {
  ssh: Array<Record<string, unknown>>;
  proxies: Array<Record<string, unknown>>;
  tunnels: Array<Record<string, unknown>>;
}

function asRecords(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (item): item is Record<string, unknown> =>
      !!item && typeof item === "object" && !Array.isArray(item),
  );
}

export function readConnections(settings: unknown): ConnectionCollection {
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) {
    return { ssh: [], proxies: [], tunnels: [] };
  }
  const raw = (settings as Record<string, unknown>).connections;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ssh: [], proxies: [], tunnels: [] };
  }
  const connections = raw as Record<string, unknown>;
  return {
    ssh: asRecords(connections.ssh),
    proxies: asRecords(connections.proxies),
    tunnels: asRecords(connections.tunnels),
  };
}

function stringValue(
  record: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

function numberValue(
  record: Record<string, unknown>,
  key: string,
  fallback: number,
): number {
  const value = Number(record[key]);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

export function buildSavedSshConfig(
  settings: unknown,
  connectionId: string,
  cols: number,
  rows: number,
): Record<string, unknown> {
  const connections = readConnections(settings);
  const entry = connections.ssh.find(
    (item) => stringValue(item, "id") === connectionId,
  );
  if (!entry)
    throw new CliUsageError(`Saved SSH connection not found: ${connectionId}`);
  return buildSshConfig(entry, connections, cols, rows, new Set());
}

function buildSshConfig(
  entry: Record<string, unknown>,
  connections: ConnectionCollection,
  cols: number,
  rows: number,
  visited: Set<Record<string, unknown>>,
): Record<string, unknown> {
  if (visited.has(entry))
    throw new CliUsageError(
      "Saved SSH jump-host configuration contains a cycle.",
    );
  visited.add(entry);
  const host = stringValue(entry, "host");
  const username = stringValue(entry, "username");
  if (!host || !username)
    throw new CliUsageError(
      "Saved SSH connection is missing host or username.",
    );
  const proxyId = stringValue(entry, "proxyId");
  const tunnelIds = Array.isArray(entry.tunnelIds)
    ? entry.tunnelIds.filter(
        (value): value is string => typeof value === "string",
      )
    : [];
  const jumpHost =
    entry.jumpHost &&
    typeof entry.jumpHost === "object" &&
    !Array.isArray(entry.jumpHost)
      ? buildSshConfig(
          entry.jumpHost as Record<string, unknown>,
          connections,
          cols,
          rows,
          new Set(visited),
        )
      : undefined;
  return {
    type: "ssh",
    title: stringValue(entry, "name") || `${username}@${host}`,
    cols,
    rows,
    host,
    port: numberValue(entry, "port", 22),
    username,
    authMethod: stringValue(entry, "authMethod") || "password",
    password: stringValue(entry, "password"),
    privateKey: stringValue(entry, "privateKey"),
    privateKeyPath: stringValue(entry, "privateKeyPath"),
    passphrase: stringValue(entry, "passphrase"),
    proxy: proxyId
      ? connections.proxies.find((item) => stringValue(item, "id") === proxyId)
      : undefined,
    tunnels:
      tunnelIds.length > 0
        ? connections.tunnels.filter((item) => {
            const id = stringValue(item, "id");
            return id ? tunnelIds.includes(id) : false;
          })
        : undefined,
    jumpHost,
  };
}
