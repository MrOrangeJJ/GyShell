import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const MAC_CLI_TARGET = "/usr/local/bin/gyll";

export type CliIntegrationKind =
  | "unavailable"
  | "missing"
  | "installed"
  | "stale-owned"
  | "conflict";

export interface MacCliIntegrationState {
  kind: CliIntegrationKind;
  sourcePath: string;
  targetPath: string;
  currentLinkTarget?: string;
}

export interface MacCliOwnershipManifest {
  schemaVersion: 1;
  targetPath: string;
  linkTarget: string;
}

export interface MacCliPrivilegedAction {
  operation: "install" | "replace" | "remove";
  sourcePath: string;
  targetPath: string;
  expectedLinkTarget?: string;
}

export interface LinuxCliManifest {
  schemaVersion: 1;
  targetPath: string;
  installedSha256: string;
  installedSize?: number;
  installedMtimeMs?: number;
  appVersion?: string;
}

export interface LinuxCliIntegrationOptions {
  sourcePath: string;
  targetPath: string;
  manifestPath: string;
  sourceSha256?: string;
  appVersion?: string;
}

export interface LinuxCliIntegrationState extends LinuxCliIntegrationOptions {
  kind: CliIntegrationKind;
  resolvedSourceSha256?: string;
  currentSha256?: string;
  manifest?: LinuxCliManifest;
}

export function resolveBundledCliPath(
  resourcesPath: string,
  platform: NodeJS.Platform = process.platform,
): string {
  return path.join(
    resourcesPath,
    "cli",
    "bin",
    platform === "win32" ? "gyll.exe" : "gyll",
  );
}

export function prependPathEntry(
  env: NodeJS.ProcessEnv,
  entry: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  const pathKey =
    Object.keys(env).find((key) => key.toLowerCase() === "path") || "PATH";
  const delimiter = platform === "win32" ? ";" : ":";
  const current = env[pathKey] || "";
  const normalizedEntry = normalizeComparablePath(entry, platform);
  const alreadyPresent = current
    .split(delimiter)
    .some(
      (candidate) =>
        normalizeComparablePath(candidate, platform) === normalizedEntry,
    );
  if (alreadyPresent) return false;
  env[pathKey] = current ? `${entry}${delimiter}${current}` : entry;
  return true;
}

export function pathContainsDirectory(
  env: NodeJS.ProcessEnv,
  directory: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  const pathValue =
    Object.entries(env).find(([key]) => key.toLowerCase() === "path")?.[1] ||
    "";
  const delimiter = platform === "win32" ? ";" : ":";
  const normalizedDirectory = normalizeComparablePath(directory, platform);
  return pathValue
    .split(delimiter)
    .some(
      (candidate) =>
        normalizeComparablePath(candidate, platform) === normalizedDirectory,
    );
}

function normalizeComparablePath(
  value: string,
  platform: NodeJS.Platform,
): string {
  let normalized = value.trim().replace(/^"|"$/g, "");
  normalized = normalized.replace(/[\\/]+$/g, "");
  return platform === "win32" ? normalized.toLowerCase() : normalized;
}

export function isGyShellBundledMacCli(filePath: string): boolean {
  const resolvedPath = path.resolve(filePath);
  const bundleSuffix = path.join("Contents", "Resources", "cli", "bin", "gyll");
  if (!resolvedPath.endsWith(`${path.sep}${bundleSuffix}`)) return false;
  const bundlePath = resolvedPath.slice(
    0,
    -(bundleSuffix.length + path.sep.length),
  );
  if (!path.basename(bundlePath).endsWith(".app")) return false;
  try {
    const infoPlist = fs.readFileSync(
      path.join(bundlePath, "Contents", "Info.plist"),
      "utf8",
    );
    return /<key>\s*CFBundleIdentifier\s*<\/key>\s*<string>\s*com\.gyshell\.app\s*<\/string>/u.test(
      infoPlist,
    );
  } catch {
    return false;
  }
}

export function inspectMacCliIntegration(
  sourcePath: string,
  targetPath = MAC_CLI_TARGET,
  ownershipManifestPath?: string,
): MacCliIntegrationState {
  if (!isRegularFile(sourcePath)) {
    return { kind: "unavailable", sourcePath, targetPath };
  }

  let targetStat: fs.Stats;
  try {
    targetStat = fs.lstatSync(targetPath);
  } catch (error) {
    if (hasCode(error, "ENOENT")) {
      return { kind: "missing", sourcePath, targetPath };
    }
    throw error;
  }
  if (!targetStat.isSymbolicLink()) {
    return { kind: "conflict", sourcePath, targetPath };
  }

  const currentLinkTarget = fs.readlinkSync(targetPath);
  const resolvedTarget = path.resolve(
    path.dirname(targetPath),
    currentLinkTarget,
  );
  if (resolvedTarget === path.resolve(sourcePath)) {
    return {
      kind: "installed",
      sourcePath,
      targetPath,
      currentLinkTarget,
    };
  }
  const ownershipManifest = ownershipManifestPath
    ? readMacCliOwnershipManifest(ownershipManifestPath)
    : undefined;
  if (
    ownershipManifest?.targetPath === targetPath &&
    ownershipManifest.linkTarget === currentLinkTarget
  ) {
    return {
      kind: "stale-owned",
      sourcePath,
      targetPath,
      currentLinkTarget,
    };
  }
  if (isGyShellBundledMacCli(resolvedTarget)) {
    return {
      kind: "stale-owned",
      sourcePath,
      targetPath,
      currentLinkTarget,
    };
  }
  return {
    kind: "conflict",
    sourcePath,
    targetPath,
    currentLinkTarget,
  };
}

export async function installMacCliIntegration(
  sourcePath: string,
  targetPath: string,
  runPrivilegedAction: (action: MacCliPrivilegedAction) => Promise<void>,
  ownershipManifestPath?: string,
): Promise<MacCliIntegrationState> {
  const state = inspectMacCliIntegration(
    sourcePath,
    targetPath,
    ownershipManifestPath,
  );
  if (state.kind === "unavailable") {
    throw new Error(`Bundled gyll is missing: ${sourcePath}`);
  }
  if (state.kind === "conflict") {
    throw new Error(
      `Refusing to replace an unmanaged command at ${targetPath}. Move it aside and try again.`,
    );
  }
  if (state.kind === "installed") {
    if (ownershipManifestPath) {
      writeMacCliOwnershipManifest(ownershipManifestPath, {
        schemaVersion: 1,
        targetPath,
        linkTarget: state.currentLinkTarget ?? sourcePath,
      });
    }
    return state;
  }

  const action: MacCliPrivilegedAction = {
    operation: state.kind === "stale-owned" ? "replace" : "install",
    sourcePath,
    targetPath,
    expectedLinkTarget: state.currentLinkTarget,
  };
  try {
    applyMacCliActionDirect(action);
  } catch (error) {
    if (!isPermissionError(error)) throw error;
    await runPrivilegedAction(action);
  }

  const installed = inspectMacCliIntegration(
    sourcePath,
    targetPath,
    ownershipManifestPath,
  );
  if (installed.kind !== "installed") {
    throw new Error(`gyll integration did not resolve to ${sourcePath}.`);
  }
  if (ownershipManifestPath) {
    writeMacCliOwnershipManifest(ownershipManifestPath, {
      schemaVersion: 1,
      targetPath,
      linkTarget: installed.currentLinkTarget ?? sourcePath,
    });
  }
  return installed;
}

export async function removeMacCliIntegration(
  sourcePath: string,
  targetPath: string,
  runPrivilegedAction: (action: MacCliPrivilegedAction) => Promise<void>,
  ownershipManifestPath?: string,
): Promise<void> {
  const state = inspectMacCliIntegration(
    sourcePath,
    targetPath,
    ownershipManifestPath,
  );
  if (state.kind === "missing") {
    if (ownershipManifestPath) {
      fs.rmSync(ownershipManifestPath, { force: true });
    }
    return;
  }
  if (state.kind !== "installed" && state.kind !== "stale-owned") {
    throw new Error(
      `Refusing to remove an unmanaged command at ${targetPath}.`,
    );
  }
  const action: MacCliPrivilegedAction = {
    operation: "remove",
    sourcePath,
    targetPath,
    expectedLinkTarget: state.currentLinkTarget,
  };
  try {
    applyMacCliActionDirect(action);
  } catch (error) {
    if (!isPermissionError(error)) throw error;
    await runPrivilegedAction(action);
  }
  if (ownershipManifestPath) {
    fs.rmSync(ownershipManifestPath, { force: true });
  }
}

export function recordInstalledMacCliOwnership(
  sourcePath: string,
  targetPath: string,
  ownershipManifestPath: string,
): boolean {
  const state = inspectMacCliIntegration(
    sourcePath,
    targetPath,
    ownershipManifestPath,
  );
  if (state.kind !== "installed" || !state.currentLinkTarget) return false;
  const existing = readMacCliOwnershipManifest(ownershipManifestPath);
  if (
    existing?.targetPath === targetPath &&
    existing.linkTarget === state.currentLinkTarget
  ) {
    return true;
  }
  writeMacCliOwnershipManifest(ownershipManifestPath, {
    schemaVersion: 1,
    targetPath,
    linkTarget: state.currentLinkTarget,
  });
  return true;
}

function applyMacCliActionDirect(action: MacCliPrivilegedAction): void {
  if (action.operation === "install") {
    fs.mkdirSync(path.dirname(action.targetPath), { recursive: true });
    fs.symlinkSync(action.sourcePath, action.targetPath);
    return;
  }

  const currentLinkTarget = fs.readlinkSync(action.targetPath);
  if (currentLinkTarget !== action.expectedLinkTarget) {
    throw new Error(
      `The command at ${action.targetPath} changed while it was being managed.`,
    );
  }
  if (action.operation === "replace" && !isRegularFile(action.sourcePath)) {
    throw new Error(`Bundled gyll is missing: ${action.sourcePath}`);
  }
  if (action.operation === "replace") {
    const temporaryPath = path.join(
      path.dirname(action.targetPath),
      `.gyll.${process.pid}.${randomUUID()}.tmp`,
    );
    try {
      fs.symlinkSync(action.sourcePath, temporaryPath);
      if (fs.readlinkSync(action.targetPath) !== action.expectedLinkTarget) {
        throw new Error(
          `The command at ${action.targetPath} changed while it was being managed.`,
        );
      }
      fs.renameSync(temporaryPath, action.targetPath);
    } finally {
      fs.rmSync(temporaryPath, { force: true });
    }
    return;
  }
  fs.unlinkSync(action.targetPath);
}

export function resolveLinuxUserCliPaths(
  homeDir = os.homedir(),
  env: NodeJS.ProcessEnv = process.env,
): { targetPath: string; manifestPath: string } {
  const stateRoot =
    env.XDG_STATE_HOME?.trim() || path.join(homeDir, ".local", "state");
  return {
    targetPath: path.join(homeDir, ".local", "bin", "gyll"),
    manifestPath: path.join(stateRoot, "gyshell", "cli-install.json"),
  };
}

export function inspectLinuxCliIntegration(
  options: LinuxCliIntegrationOptions,
): LinuxCliIntegrationState {
  if (!isRegularFile(options.sourcePath)) {
    return { ...options, kind: "unavailable" };
  }
  const targetInspection = inspectPlainRegularFilePath(options.targetPath);
  if (targetInspection.kind !== "file") {
    return { ...options, kind: targetInspection.kind };
  }

  let resolvedSourceSha256: string;
  let currentSha256: string;
  try {
    resolvedSourceSha256 = validSha256(options.sourceSha256)
      ? options.sourceSha256.toLowerCase()
      : sha256File(options.sourcePath);
    currentSha256 = sha256File(options.targetPath);
  } catch {
    return { ...options, kind: "conflict" };
  }
  const manifest = readLinuxCliManifest(options.manifestPath);
  const isManifestOwned =
    manifest?.targetPath === options.targetPath &&
    manifest.installedSha256 === currentSha256;
  if (!isManifestOwned) {
    return {
      ...options,
      kind: "conflict",
      resolvedSourceSha256,
      currentSha256,
      manifest,
    };
  }
  if (
    currentSha256 === resolvedSourceSha256 &&
    isExecutableByCurrentUser(options.targetPath)
  ) {
    return {
      ...options,
      kind: "installed",
      resolvedSourceSha256,
      currentSha256,
      manifest,
    };
  }
  return {
    ...options,
    kind: "stale-owned",
    resolvedSourceSha256,
    currentSha256,
    manifest,
  };
}

/**
 * Startup/UI inspection avoids hashing the self-contained runtime on the
 * Electron main thread. A stat fingerprint is only a cache hint: install and
 * remove still call the full hash-verifying inspector before mutating files.
 */
export function inspectLinuxCliIntegrationFast(
  options: LinuxCliIntegrationOptions,
): LinuxCliIntegrationState {
  if (!isRegularFile(options.sourcePath)) {
    return { ...options, kind: "unavailable" };
  }
  const targetInspection = inspectPlainRegularFilePath(options.targetPath);
  if (targetInspection.kind !== "file") {
    return { ...options, kind: targetInspection.kind };
  }
  const manifest = readLinuxCliManifest(options.manifestPath);
  if (manifest?.targetPath !== options.targetPath) {
    return { ...options, kind: "conflict", manifest };
  }
  const hasMatchingFingerprint =
    Number.isSafeInteger(manifest.installedSize) &&
    (manifest.installedSize ?? -1) >= 0 &&
    Number.isFinite(manifest.installedMtimeMs) &&
    manifest.installedSize === targetInspection.stat.size &&
    manifest.installedMtimeMs === targetInspection.stat.mtimeMs;
  if (!validSha256(options.sourceSha256) || !hasMatchingFingerprint) {
    return inspectLinuxCliIntegration(options);
  }

  const resolvedSourceSha256 = options.sourceSha256.toLowerCase();
  const currentSha256 = manifest.installedSha256;
  return {
    ...options,
    kind:
      currentSha256 === resolvedSourceSha256 &&
      isExecutableByCurrentUser(options.targetPath)
        ? "installed"
        : "stale-owned",
    resolvedSourceSha256,
    currentSha256,
    manifest,
  };
}

export function isForwardAppVersionUpgrade(
  installedVersion: string | undefined,
  bundledVersion: string | undefined,
): boolean {
  const installed = parseSemver(installedVersion);
  const bundled = parseSemver(bundledVersion);
  if (!installed || !bundled) return false;
  return compareSemver(bundled, installed) > 0;
}

export function installLinuxUserCli(
  options: LinuxCliIntegrationOptions,
): LinuxCliIntegrationState {
  if (!isRegularFile(options.sourcePath)) {
    throw new Error(`Bundled gyll is missing: ${options.sourcePath}`);
  }
  const actualSourceSha256 = sha256File(options.sourcePath);
  if (
    validSha256(options.sourceSha256) &&
    options.sourceSha256.toLowerCase() !== actualSourceSha256
  ) {
    throw new Error(
      `Bundled gyll failed its integrity check: ${options.sourcePath}`,
    );
  }
  const verifiedOptions = {
    ...options,
    sourceSha256: actualSourceSha256,
  };
  let state = inspectLinuxCliIntegration(verifiedOptions);
  if (state.kind === "unavailable") {
    throw new Error(`Bundled gyll is missing: ${options.sourcePath}`);
  }
  if (state.kind === "conflict") {
    throw new Error(
      `Refusing to replace an unmanaged command at ${options.targetPath}. Move it aside and try again.`,
    );
  }
  const sourceSha256 = actualSourceSha256;

  fs.mkdirSync(path.dirname(options.targetPath), {
    recursive: true,
    mode: 0o755,
  });
  if (state.kind !== "installed") {
    const temporaryPath = path.join(
      path.dirname(options.targetPath),
      `.gyll.${process.pid}.${randomUUID()}.tmp`,
    );
    let rollbackPath: string | undefined;
    let publishedState:
      | { kind: "created"; stat: fs.Stats }
      | { kind: "replaced"; stat: fs.Stats }
      | undefined;
    try {
      fs.copyFileSync(
        options.sourcePath,
        temporaryPath,
        fs.constants.COPYFILE_EXCL,
      );
      fs.chmodSync(temporaryPath, 0o755);
      const temporaryFile = fs.openSync(temporaryPath, "r");
      try {
        fs.fsyncSync(temporaryFile);
      } finally {
        fs.closeSync(temporaryFile);
      }
      if (sha256File(temporaryPath) !== sourceSha256) {
        throw new Error(
          `Bundled gyll changed while it was being copied: ${options.sourcePath}`,
        );
      }

      if (state.kind === "stale-owned") {
        const freshState = inspectLinuxCliIntegration(verifiedOptions);
        if (
          freshState.kind !== "stale-owned" ||
          freshState.currentSha256 !== state.currentSha256
        ) {
          throw new Error(
            `The command at ${options.targetPath} changed while it was being updated.`,
          );
        }
        rollbackPath = path.join(
          path.dirname(options.targetPath),
          `.gyll.${process.pid}.${randomUUID()}.rollback`,
        );
        fs.linkSync(options.targetPath, rollbackPath);
        if (
          !sameFileIdentity(
            fs.lstatSync(options.targetPath),
            fs.lstatSync(rollbackPath),
          ) ||
          sha256File(rollbackPath) !== state.currentSha256
        ) {
          throw new Error(
            `The command at ${options.targetPath} changed while it was being backed up.`,
          );
        }
        fs.renameSync(temporaryPath, options.targetPath);
        publishedState = {
          kind: "replaced",
          stat: fs.lstatSync(options.targetPath),
        };
      } else {
        // The temporary file is complete before this atomic hard-link appears.
        // linkSync also refuses to overwrite a file created by a racing process.
        fs.linkSync(temporaryPath, options.targetPath);
        publishedState = {
          kind: "created",
          stat: fs.lstatSync(options.targetPath),
        };
      }

      try {
        writeLinuxCliManifest(
          options.manifestPath,
          buildLinuxCliManifest(options, sourceSha256),
        );
      } catch (error) {
        try {
          rollbackPublishedLinuxCli(
            options.targetPath,
            temporaryPath,
            rollbackPath,
            publishedState,
          );
        } catch (rollbackError) {
          const preservedBackup = rollbackPath;
          rollbackPath = undefined;
          throw new Error(
            `Unable to publish the gyll ownership manifest (${describeError(error)}), and rollback also failed (${describeError(rollbackError)})${preservedBackup ? `. The previous command was preserved at ${preservedBackup}.` : "."}`,
          );
        }
        throw error;
      }
    } finally {
      fs.rmSync(temporaryPath, { force: true });
      if (rollbackPath) fs.rmSync(rollbackPath, { force: true });
    }
  } else {
    writeLinuxCliManifest(
      options.manifestPath,
      buildLinuxCliManifest(options, sourceSha256),
    );
  }
  state = inspectLinuxCliIntegration({
    ...verifiedOptions,
    sourceSha256,
  });
  if (state.kind !== "installed") {
    throw new Error(`gyll was not installed at ${options.targetPath}.`);
  }
  return state;
}

export function removeLinuxUserCli(options: LinuxCliIntegrationOptions): void {
  const state = inspectLinuxCliIntegration(options);
  if (state.kind === "missing") {
    fs.rmSync(options.manifestPath, { force: true });
    return;
  }
  if (state.kind !== "installed" && state.kind !== "stale-owned") {
    throw new Error(
      `Refusing to remove an unmanaged command at ${options.targetPath}.`,
    );
  }
  const freshState = inspectLinuxCliIntegration(options);
  if (
    freshState.kind !== state.kind ||
    freshState.currentSha256 !== state.currentSha256
  ) {
    throw new Error(
      `The command at ${options.targetPath} changed while it was being removed.`,
    );
  }
  fs.unlinkSync(options.targetPath);
  fs.rmSync(options.manifestPath, { force: true });
}

function readLinuxCliManifest(filePath: string): LinuxCliManifest | undefined {
  try {
    const value = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (
      value?.schemaVersion === 1 &&
      typeof value.targetPath === "string" &&
      validSha256(value.installedSha256)
    ) {
      const installedSize =
        Number.isSafeInteger(value.installedSize) && value.installedSize >= 0
          ? value.installedSize
          : undefined;
      const installedMtimeMs = Number.isFinite(value.installedMtimeMs)
        ? value.installedMtimeMs
        : undefined;
      const appVersion =
        typeof value.appVersion === "string" && value.appVersion.length > 0
          ? value.appVersion
          : undefined;
      return {
        schemaVersion: 1,
        targetPath: value.targetPath,
        installedSha256: value.installedSha256.toLowerCase(),
        installedSize,
        installedMtimeMs,
        appVersion,
      };
    }
  } catch {
    // A malformed or absent manifest cannot establish ownership.
  }
  return undefined;
}

function readMacCliOwnershipManifest(
  filePath: string,
): MacCliOwnershipManifest | undefined {
  try {
    const value = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (
      value?.schemaVersion === 1 &&
      typeof value.targetPath === "string" &&
      typeof value.linkTarget === "string" &&
      value.linkTarget.length > 0
    ) {
      return {
        schemaVersion: 1,
        targetPath: value.targetPath,
        linkTarget: value.linkTarget,
      };
    }
  } catch {
    // Missing/malformed metadata cannot prove ownership of a dangling link.
  }
  return undefined;
}

function writeMacCliOwnershipManifest(
  filePath: string,
  manifest: MacCliOwnershipManifest,
): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporaryPath, `${JSON.stringify(manifest, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    fs.renameSync(temporaryPath, filePath);
  } finally {
    fs.rmSync(temporaryPath, { force: true });
  }
}

function buildLinuxCliManifest(
  options: LinuxCliIntegrationOptions,
  installedSha256: string,
): LinuxCliManifest {
  const targetInspection = inspectPlainRegularFilePath(options.targetPath);
  if (targetInspection.kind !== "file") {
    throw new Error(
      `Unable to record ownership for ${options.targetPath}: target is ${targetInspection.kind}.`,
    );
  }
  return {
    schemaVersion: 1,
    targetPath: options.targetPath,
    installedSha256,
    installedSize: targetInspection.stat.size,
    installedMtimeMs: targetInspection.stat.mtimeMs,
    appVersion:
      typeof options.appVersion === "string" && options.appVersion.length > 0
        ? options.appVersion
        : undefined,
  };
}

function writeLinuxCliManifest(
  filePath: string,
  manifest: LinuxCliManifest,
): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o755 });
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporaryPath, `${JSON.stringify(manifest, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o644,
      flag: "wx",
    });
    fs.renameSync(temporaryPath, filePath);
  } finally {
    fs.rmSync(temporaryPath, { force: true });
  }
}

function rollbackPublishedLinuxCli(
  targetPath: string,
  temporaryPath: string,
  rollbackPath: string | undefined,
  publishedState:
    | { kind: "created"; stat: fs.Stats }
    | { kind: "replaced"; stat: fs.Stats }
    | undefined,
): void {
  if (!publishedState) return;
  const currentStat = readPlainRegularFileStat(targetPath);
  if (!currentStat || !sameFileIdentity(currentStat, publishedState.stat)) {
    return;
  }
  if (publishedState.kind === "created") {
    const temporaryStat = readPlainRegularFileStat(temporaryPath);
    if (temporaryStat && sameFileIdentity(currentStat, temporaryStat)) {
      fs.unlinkSync(targetPath);
    }
    return;
  }
  if (rollbackPath) fs.renameSync(rollbackPath, targetPath);
}

function sameFileIdentity(left: fs.Stats, right: fs.Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sha256File(filePath: string): string {
  return createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function validSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f\d]{64}$/iu.test(value);
}

interface ParsedSemver {
  core: [number, number, number];
  prerelease: string[];
}

function parseSemver(value: string | undefined): ParsedSemver | undefined {
  if (!value) return undefined;
  const match = value.match(
    /^(?:v)?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/u,
  );
  if (!match) return undefined;
  return {
    core: [Number(match[1]), Number(match[2]), Number(match[3])],
    prerelease: match[4]?.split(".") ?? [],
  };
}

function compareSemver(left: ParsedSemver, right: ParsedSemver): number {
  for (let index = 0; index < left.core.length; index += 1) {
    if (left.core[index] !== right.core[index]) {
      return left.core[index] > right.core[index] ? 1 : -1;
    }
  }
  if (left.prerelease.length === 0 || right.prerelease.length === 0) {
    if (left.prerelease.length === right.prerelease.length) return 0;
    return left.prerelease.length === 0 ? 1 : -1;
  }
  const length = Math.max(left.prerelease.length, right.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const leftPart = left.prerelease[index];
    const rightPart = right.prerelease[index];
    if (leftPart === undefined || rightPart === undefined) {
      return leftPart === rightPart ? 0 : leftPart === undefined ? -1 : 1;
    }
    if (leftPart === rightPart) continue;
    const leftNumeric = /^\d+$/u.test(leftPart);
    const rightNumeric = /^\d+$/u.test(rightPart);
    if (leftNumeric && rightNumeric) {
      return Number(leftPart) > Number(rightPart) ? 1 : -1;
    }
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
    return leftPart > rightPart ? 1 : -1;
  }
  return 0;
}

function isRegularFile(filePath: string): boolean {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function isExecutableByCurrentUser(filePath: string): boolean {
  try {
    fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function readPlainRegularFileStat(filePath: string): fs.Stats | undefined {
  try {
    const stat = fs.lstatSync(filePath);
    return stat.isFile() && !stat.isSymbolicLink() ? stat : undefined;
  } catch (error) {
    if (hasCode(error, "ENOENT")) return undefined;
    throw error;
  }
}

function inspectPlainRegularFilePath(
  filePath: string,
):
  | { kind: "file"; stat: fs.Stats }
  | { kind: "missing" }
  | { kind: "conflict" } {
  try {
    const stat = fs.lstatSync(filePath);
    return stat.isFile() && !stat.isSymbolicLink()
      ? { kind: "file", stat }
      : { kind: "conflict" };
  } catch (error) {
    return hasCode(error, "ENOENT")
      ? { kind: "missing" }
      : { kind: "conflict" };
  }
}

function isPermissionError(error: unknown): boolean {
  return (
    hasCode(error, "EACCES") ||
    hasCode(error, "EPERM") ||
    hasCode(error, "EROFS")
  );
}

function hasCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === code
  );
}
