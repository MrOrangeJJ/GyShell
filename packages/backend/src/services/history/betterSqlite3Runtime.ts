import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

const NODE_RUNTIME_PACKAGE_NAME = "better-sqlite3";
const ELECTRON_RUNTIME_PACKAGE_NAME = "better-sqlite3-electron";

type BetterSqlite3Constructor = typeof import("better-sqlite3");
type BetterSqlite3OpenOptions = ConstructorParameters<BetterSqlite3Constructor>[1];
export type DatabaseHandle = InstanceType<typeof import("better-sqlite3")>;

let cachedConstructor: BetterSqlite3Constructor | null = null;
let cachedPackageName: string | null = null;

function resolveRuntimePackageName(): string {
  return process.versions.electron
    ? ELECTRON_RUNTIME_PACKAGE_NAME
    : NODE_RUNTIME_PACKAGE_NAME;
}

export function loadBetterSqlite3(): BetterSqlite3Constructor {
  const packageName = resolveRuntimePackageName();
  if (cachedConstructor && cachedPackageName === packageName) {
    return cachedConstructor;
  }
  cachedConstructor = require(packageName) as BetterSqlite3Constructor;
  cachedPackageName = packageName;
  return cachedConstructor;
}

function normalizePotentialAsarPath(filePath: string): string {
  return filePath
    .replace(`${path.sep}app.asar${path.sep}`, `${path.sep}app.asar.unpacked${path.sep}`)
    .replace(
      `${path.sep}node_modules.asar${path.sep}`,
      `${path.sep}node_modules.asar.unpacked${path.sep}`,
    );
}

function resolveNativeBindingCandidates(packageName: string): string[] {
  const candidates: string[] = [];

  if (process.versions.electron && process.resourcesPath) {
    candidates.push(
      path.join(
        process.resourcesPath,
        "native-modules",
        "better-sqlite3",
        "better_sqlite3.node",
      ),
    );
  }

  try {
    const packageJsonPath = require.resolve(`${packageName}/package.json`);
    const packageRoot = normalizePotentialAsarPath(path.dirname(packageJsonPath));
    candidates.push(path.join(packageRoot, "build", "Release", "better_sqlite3.node"));
  } catch {
    // Fall back to the package's default bindings lookup when explicit resolution is unavailable.
  }

  return Array.from(new Set(candidates));
}

function isNativeBindingLoadError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes(".node") ||
    /dlopen/i.test(message) ||
    /mach-o/i.test(message) ||
    /elf/i.test(message) ||
    /win32 application/i.test(message) ||
    /compiled against a different node\.js version/i.test(message) ||
    /module did not self-register/i.test(message) ||
    /cannot find module/i.test(message) ||
    /was compiled against a different Node\.js version/i.test(message)
  );
}

function formatNativeLoadFailure(candidatePath: string, error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error);
  return `${candidatePath}: ${detail}`;
}

export function openBetterSqlite3Database(
  filePath: string,
  options?: BetterSqlite3OpenOptions,
): DatabaseHandle {
  const BetterSqlite3 = loadBetterSqlite3();
  const packageName = resolveRuntimePackageName();
  const loadFailures: string[] = [];

  for (const candidatePath of resolveNativeBindingCandidates(packageName)) {
    if (!fs.existsSync(candidatePath)) {
      continue;
    }

    try {
      const addon = require(candidatePath);
      return new BetterSqlite3(filePath, {
        ...(options || {}),
        nativeBinding: addon,
      });
    } catch (error) {
      if (!isNativeBindingLoadError(error)) {
        throw error;
      }
      loadFailures.push(formatNativeLoadFailure(candidatePath, error));
    }
  }

  try {
    return new BetterSqlite3(filePath, options);
  } catch (error) {
    if (loadFailures.length === 0) {
      throw error;
    }

    const defaultFailure = error instanceof Error ? error.message : String(error);
    throw new Error(
      [
        "Failed to load the SQLite native runtime.",
        ...loadFailures.map((entry) => `Tried ${entry}`),
        `Default runtime lookup failed: ${defaultFailure}`,
      ].join("\n"),
    );
  }
}

/** Connection pragmas shared by every GyShell SQLite store. */
export function applyStandardSqlitePragmas(db: DatabaseHandle): void {
  db.pragma("foreign_keys = ON");
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("temp_store = MEMORY");
  db.pragma("cache_size = -32000");
}
