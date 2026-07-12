import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  formatNativeBinaryIdentity,
  inspectNativeBinary,
  matchesNativeBinaryTarget,
} from "./native-binary-utils.mjs";

const ARCH_BY_BUILDER_VALUE = {
  1: "x64",
  3: "arm64",
};
const ENABLED_NODE_SEA_SENTINEL = Buffer.from(
  "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2:1",
);
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDir, "../../..");
const cliBundlePath = path.join(projectRoot, "apps", "cli", "dist", "gyll.cjs");
const cliPackagePath = path.join(projectRoot, "apps", "cli", "package.json");

function resolveResourcesRoot(context) {
  if (context.electronPlatformName !== "darwin") {
    return path.join(context.appOutDir, "resources");
  }
  const productName = context?.packager?.appInfo?.productFilename || "GyShell";
  return path.join(
    context.appOutDir,
    `${productName}.app`,
    "Contents",
    "Resources",
  );
}

function sha256File(filePath) {
  const hash = createHash("sha256");
  hash.update(fs.readFileSync(filePath));
  return hash.digest("hex");
}

function readPeSubsystem(filePath) {
  const buffer = fs.readFileSync(filePath);
  const peOffset = buffer.readUInt32LE(0x3c);
  const optionalHeader = peOffset + 24;
  return buffer.readUInt16LE(optionalHeader + 68);
}

export default async function validateCliRuntime(context) {
  const targetPlatform = context?.electronPlatformName;
  const targetArch = ARCH_BY_BUILDER_VALUE[context?.arch];
  if (!targetPlatform || !targetArch) {
    throw new Error(
      `Unsupported CLI packaging context: ${targetPlatform || "missing-platform"}/${context?.arch}`,
    );
  }

  const resourcesRoot = resolveResourcesRoot(context);
  const executablePath = path.join(
    resourcesRoot,
    "cli",
    "bin",
    targetPlatform === "win32" ? "gyll.exe" : "gyll",
  );
  const metadataPath = path.join(resourcesRoot, "cli", "metadata.json");
  const licensePath = path.join(
    resourcesRoot,
    "cli",
    "licenses",
    "node-LICENSE",
  );
  for (const requiredPath of [executablePath, metadataPath, licensePath]) {
    if (!fs.existsSync(requiredPath))
      throw new Error(`Missing packaged CLI runtime file: ${requiredPath}`);
  }

  const identity = inspectNativeBinary(executablePath);
  if (!matchesNativeBinaryTarget(identity, targetPlatform, targetArch)) {
    throw new Error(
      `Packaged gyll does not match ${targetPlatform}-${targetArch}: ${formatNativeBinaryIdentity(identity)}`,
    );
  }
  if (
    targetPlatform !== "win32" &&
    (fs.statSync(executablePath).mode & 0o111) === 0
  ) {
    throw new Error(`Packaged gyll is not executable: ${executablePath}`);
  }
  if (targetPlatform === "win32" && readPeSubsystem(executablePath) !== 3) {
    throw new Error(
      `Packaged gyll.exe is not a Windows console application: ${executablePath}`,
    );
  }
  if (!fs.readFileSync(executablePath).includes(ENABLED_NODE_SEA_SENTINEL)) {
    throw new Error(
      `Packaged gyll does not contain an enabled Node SEA payload: ${executablePath}`,
    );
  }

  const metadata = JSON.parse(fs.readFileSync(metadataPath, "utf8"));
  const expectedAppVersion = context?.packager?.appInfo?.version;
  if (!expectedAppVersion) {
    throw new Error(
      "Packaging context does not expose the GyShell app version",
    );
  }
  if (!fs.existsSync(cliBundlePath)) {
    throw new Error(`Missing built CLI bundle: ${cliBundlePath}`);
  }
  const expectedCliVersion = JSON.parse(
    fs.readFileSync(cliPackagePath, "utf8"),
  ).version;
  if (
    metadata.schemaVersion !== 1 ||
    metadata.format !== "node-sea" ||
    metadata.command !== "gyll" ||
    metadata.platform !== targetPlatform ||
    metadata.arch !== targetArch ||
    metadata.appVersion !== expectedAppVersion ||
    metadata.cliVersion !== expectedCliVersion ||
    metadata.bundleSha256 !== sha256File(cliBundlePath)
  ) {
    throw new Error(
      `Packaged CLI metadata does not match ${targetPlatform}-${targetArch}: ${metadataPath}`,
    );
  }
  if (
    metadata.checksumStage !== "after-sea-injection-before-platform-signing"
  ) {
    throw new Error(
      `Packaged CLI metadata has an unknown checksum stage: ${metadata.checksumStage}`,
    );
  }
  // afterPack runs before Authenticode/Mach-O signing, so every platform must
  // still match the exact SEA payload prepared for this package.
  const packagingInputSha256 = sha256File(executablePath);
  if (metadata.packagingInputSha256 !== packagingInputSha256) {
    throw new Error(
      `Packaged CLI checksum mismatch: expected ${metadata.packagingInputSha256}, got ${packagingInputSha256}`,
    );
  }

  if (process.platform === targetPlatform && process.arch === targetArch) {
    const result = spawnSync(executablePath, ["--help"], {
      encoding: "utf8",
      timeout: 15_000,
      env: { ...process.env, NODE_OPTIONS: "" },
    });
    if (
      result.error ||
      result.status !== 0 ||
      !result.stdout.includes("GyShell command CLI")
    ) {
      throw new Error(
        `Packaged gyll smoke test failed: ${result.error?.message || result.stderr || result.stdout}`,
      );
    }
  }
}
