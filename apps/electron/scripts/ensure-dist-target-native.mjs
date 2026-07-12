#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDir, "../../..");

function resolveDistTarget() {
  if (process.platform === "darwin") {
    return { platform: "darwin", arch: "arm64" };
  }
  if (process.platform === "win32") {
    return { platform: "win32", arch: "x64" };
  }
  if (
    process.platform === "linux" &&
    (process.arch === "x64" || process.arch === "arm64")
  ) {
    return { platform: "linux", arch: process.arch };
  }
  throw new Error(
    `Unsupported host for generic Electron distribution: ${process.platform}/${process.arch}`,
  );
}

const target = resolveDistTarget();
const result = spawnSync(
  process.execPath,
  [
    path.join(scriptDir, "ensure-better-sqlite3-target-prebuilt.mjs"),
    "--platform",
    target.platform,
    "--arch",
    target.arch,
  ],
  {
    cwd: projectRoot,
    stdio: "inherit",
    env: process.env,
  },
);
if (result.error) throw result.error;
if (result.status !== 0) {
  throw new Error(
    `Native runtime preparation failed for ${target.platform}-${target.arch} with exit code ${result.status}`,
  );
}
console.log(
  `[ensure-dist-target-native] Ready for ${target.platform}-${target.arch}`,
);
