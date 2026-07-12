#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import {
  formatNativeBinaryIdentity,
  inspectNativeBinary,
  matchesNativeBinaryTarget,
} from "./native-binary-utils.mjs";

const require = createRequire(import.meta.url);
const { inject } = require("postject");
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDir, "../../..");
const runtimeRoot = path.join(projectRoot, "apps", "electron", "cli-runtime");
const cliBundlePath = path.join(projectRoot, "apps", "cli", "dist", "gyll.cjs");
const rootPackage = JSON.parse(
  fs.readFileSync(path.join(projectRoot, "package.json"), "utf8"),
);
const cliPackage = JSON.parse(
  fs.readFileSync(
    path.join(projectRoot, "apps", "cli", "package.json"),
    "utf8",
  ),
);

// Node 22 remains compatible with GyShell's macOS 12 deployment target. Node
// 24 official binaries require macOS 13.5, even though Electron itself does not.
const NODE_VERSION = "v22.23.1";
const NODE_SEA_SENTINEL = "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2";
const ENABLED_NODE_SEA_SENTINEL = `${NODE_SEA_SENTINEL}:1`;

const TARGETS = {
  "darwin-arm64": {
    platform: "darwin",
    arch: "arm64",
    archive: `node-${NODE_VERSION}-darwin-arm64.tar.gz`,
    archiveSha256:
      "ef28d8fab2c0e4314522d4bb1b7173270aa3937e93b92cb7de79c112ac1fa953",
    binarySha256:
      "2e3f1286a7eb3736346ed1803e458a0ff909e2b2d5bc746144dcb76970e9b99d",
    binaryRelativePath: `node-${NODE_VERSION}-darwin-arm64/bin/node`,
    licenseRelativePath: `node-${NODE_VERSION}-darwin-arm64/LICENSE`,
    outputName: "gyll",
  },
  "darwin-x64": {
    platform: "darwin",
    arch: "x64",
    archive: `node-${NODE_VERSION}-darwin-x64.tar.gz`,
    archiveSha256:
      "b8da981b8a0b1241b70249204916da76c63573ddf5814dbd2d1e41069105cb81",
    binarySha256:
      "03afb3618a2685335209c93f8c34633f8316dbe6cc32196bc19daa1a73852e5b",
    binaryRelativePath: `node-${NODE_VERSION}-darwin-x64/bin/node`,
    licenseRelativePath: `node-${NODE_VERSION}-darwin-x64/LICENSE`,
    outputName: "gyll",
  },
  "linux-x64": {
    platform: "linux",
    arch: "x64",
    archive: `node-${NODE_VERSION}-linux-x64.tar.gz`,
    archiveSha256:
      "7a8cb04b4a1df4eaf432125324b81b29a088e73570a23259a8de1c65d07fc129",
    binarySha256:
      "93956de2e59480474a7b46571da1651180b1a050cdf32641ebec4ce6e478e068",
    binaryRelativePath: `node-${NODE_VERSION}-linux-x64/bin/node`,
    licenseRelativePath: `node-${NODE_VERSION}-linux-x64/LICENSE`,
    outputName: "gyll",
  },
  "linux-arm64": {
    platform: "linux",
    arch: "arm64",
    archive: `node-${NODE_VERSION}-linux-arm64.tar.gz`,
    archiveSha256:
      "543fa39e57d4c07855939459a323f4deb9a79dd1bb45e6e99458b0f2de10db8d",
    binarySha256:
      "d8fa08f79c8198c5a5ccc9faa5a69803052703fc9513f99e7200e0ab42e1d799",
    binaryRelativePath: `node-${NODE_VERSION}-linux-arm64/bin/node`,
    licenseRelativePath: `node-${NODE_VERSION}-linux-arm64/LICENSE`,
    outputName: "gyll",
  },
  "win32-x64": {
    platform: "win32",
    arch: "x64",
    archive: `node-${NODE_VERSION}-win-x64.zip`,
    archiveSha256:
      "7df0bc9375723f4a86b3aa1b7cc73342423d9677a8df4538aca31a049e309c29",
    binarySha256:
      "f8d162c0641dcee512132f3bcf8a68169c7ecb852efd8e1a46c9fec5a0f469ed",
    binaryRelativePath: `node-${NODE_VERSION}-win-x64/node.exe`,
    licenseRelativePath: `node-${NODE_VERSION}-win-x64/LICENSE`,
    outputName: "gyll.exe",
  },
};

// Host-only distributions are used to produce a platform-neutral SEA blob.
// They are deliberately excluded from TARGETS because GyShell does not ship a
// Windows ARM64 app yet; its supported Windows release remains x64.
const BLOB_BUILDER_HOSTS = {
  "win32-arm64": {
    platform: "win32",
    arch: "arm64",
    archive: `node-${NODE_VERSION}-win-arm64.zip`,
    archiveSha256:
      "b470fdfe3502c05151656e06d495e3f47544f2ee8b1d9c8705090f2dd5996bd0",
    binarySha256:
      "f55db97c9924b0b37b05e8cf1be4e04c72aec01dc1c22420b5c31ab9cd118b89",
    binaryRelativePath: `node-${NODE_VERSION}-win-arm64/node.exe`,
    licenseRelativePath: `node-${NODE_VERSION}-win-arm64/LICENSE`,
  },
};

function parseArguments(argv) {
  const allowedNames = new Set(["target", "platform", "arch"]);
  const values = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      throw new Error(`Unexpected argument: ${token}`);
    }
    const name = token.slice(2);
    if (!allowedNames.has(name)) {
      throw new Error(`Unknown option: ${token}`);
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`${token} requires a value`);
    }
    values.set(name, value);
    index += 1;
  }
  return values;
}

function resolveTarget(argv) {
  const values = parseArguments(argv);
  const explicitTarget = values.get("target");
  if (explicitTarget) return explicitTarget.replace(/^windows-/, "win32-");

  const platform = values.get("platform") || process.platform;
  // GyShell's macOS and Windows builders have fixed release architectures,
  // including when a generic dist is launched from a different host arch.
  const arch =
    values.get("arch") ||
    (platform === "darwin"
      ? "arm64"
      : platform === "win32"
        ? "x64"
        : process.arch);
  return `${platform.replace(/^windows$/, "win32")}-${arch}`;
}

function sha256File(filePath) {
  const hash = createHash("sha256");
  const file = fs.openSync(filePath, "r");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    let bytesRead;
    do {
      bytesRead = fs.readSync(file, buffer, 0, buffer.length, null);
      if (bytesRead > 0) hash.update(buffer.subarray(0, bytesRead));
    } while (bytesRead > 0);
  } finally {
    fs.closeSync(file);
  }
  return hash.digest("hex");
}

function runChecked(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: projectRoot,
    encoding: "utf8",
    stdio: options.stdio || "pipe",
    env: options.env || process.env,
    timeout: options.timeout,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const output = [result.stdout, result.stderr]
      .filter(Boolean)
      .join("\n")
      .trim();
    const outcome = result.signal
      ? `signal ${result.signal}`
      : `exit code ${result.status}`;
    throw new Error(
      `${command} failed with ${outcome}${output ? `:\n${output}` : ""}`,
    );
  }
  return result;
}

async function download(url, destination, redirectCount = 0) {
  if (redirectCount > 5)
    throw new Error(`Too many redirects while downloading ${url}`);
  await new Promise((resolve, reject) => {
    const request = https.get(url, (response) => {
      const status = response.statusCode || 0;
      if (status >= 300 && status < 400 && response.headers.location) {
        response.resume();
        const redirectUrl = new URL(response.headers.location, url).toString();
        download(redirectUrl, destination, redirectCount + 1).then(
          resolve,
          reject,
        );
        return;
      }
      if (status !== 200) {
        response.resume();
        reject(new Error(`Download failed (${status}) for ${url}`));
        return;
      }
      const output = fs.createWriteStream(destination, { flags: "wx" });
      pipeline(response, output).then(resolve, reject);
    });
    request.setTimeout(60_000, () => {
      request.destroy(new Error(`Download stalled for 60 seconds: ${url}`));
    });
    request.on("error", reject);
  });
}

async function ensureArchive(target, cacheRoot) {
  const archivePath = path.join(cacheRoot, "archives", target.archive);
  await fsp.mkdir(path.dirname(archivePath), { recursive: true });
  if (
    fs.existsSync(archivePath) &&
    sha256File(archivePath) === target.archiveSha256
  ) {
    return archivePath;
  }

  await fsp.rm(archivePath, { force: true });
  const partialPath = `${archivePath}.${process.pid}.partial`;
  await fsp.rm(partialPath, { force: true });
  console.log(`[prepare-cli-runtime] Downloading ${target.archive}`);
  try {
    await download(
      `https://nodejs.org/dist/${NODE_VERSION}/${target.archive}`,
      partialPath,
    );
    const actualHash = sha256File(partialPath);
    if (actualHash !== target.archiveSha256) {
      throw new Error(
        `Checksum mismatch for ${target.archive}: expected ${target.archiveSha256}, got ${actualHash}`,
      );
    }
    await fsp.rename(partialPath, archivePath);
  } finally {
    await fsp.rm(partialPath, { force: true });
  }
  return archivePath;
}

async function ensureExtractedNode(target, cacheRoot) {
  const archivePath = await ensureArchive(target, cacheRoot);
  const extractedRoot = path.join(
    cacheRoot,
    "extracted",
    target.archive.replace(/\.(?:tar\.gz|zip)$/u, ""),
  );
  const binaryPath = path.join(extractedRoot, target.binaryRelativePath);
  const licensePath = path.join(extractedRoot, target.licenseRelativePath);
  if (
    fs.existsSync(binaryPath) &&
    fs.existsSync(licensePath) &&
    sha256File(binaryPath) === target.binarySha256
  ) {
    return { binaryPath, licensePath };
  }

  await fsp.mkdir(path.dirname(extractedRoot), { recursive: true });
  const temporaryRoot = `${extractedRoot}.${process.pid}.partial`;
  await fsp.rm(temporaryRoot, { recursive: true, force: true });
  await fsp.mkdir(temporaryRoot, { recursive: true });
  try {
    runChecked("tar", ["-xf", archivePath, "-C", temporaryRoot]);
    const extractedBinary = path.join(temporaryRoot, target.binaryRelativePath);
    const extractedLicense = path.join(
      temporaryRoot,
      target.licenseRelativePath,
    );
    if (!fs.existsSync(extractedBinary) || !fs.existsSync(extractedLicense)) {
      throw new Error(`Node archive is incomplete: ${target.archive}`);
    }
    const extractedBinarySha256 = sha256File(extractedBinary);
    if (extractedBinarySha256 !== target.binarySha256) {
      throw new Error(
        `Node binary checksum mismatch for ${target.archive}: expected ${target.binarySha256}, got ${extractedBinarySha256}`,
      );
    }
    await fsp.rm(extractedRoot, { recursive: true, force: true });
    await fsp.rename(temporaryRoot, extractedRoot);
  } finally {
    await fsp.rm(temporaryRoot, { recursive: true, force: true });
  }
  return { binaryPath, licensePath };
}

function stripPeAuthenticodeSignature(filePath) {
  const buffer = fs.readFileSync(filePath);
  const peOffset = buffer.readUInt32LE(0x3c);
  const optionalHeader = peOffset + 24;
  const magic = buffer.readUInt16LE(optionalHeader);
  const dataDirectory =
    optionalHeader + (magic === 0x20b ? 112 : magic === 0x10b ? 96 : 0);
  if (dataDirectory === optionalHeader)
    throw new Error(`Unsupported PE optional header in ${filePath}`);
  const certificateEntry = dataDirectory + 4 * 8;
  const certificateOffset = buffer.readUInt32LE(certificateEntry);
  const certificateSize = buffer.readUInt32LE(certificateEntry + 4);
  buffer.writeUInt32LE(0, certificateEntry);
  buffer.writeUInt32LE(0, certificateEntry + 4);
  const outputLength =
    certificateOffset > 0 &&
    certificateOffset + certificateSize === buffer.length
      ? certificateOffset
      : buffer.length;
  fs.writeFileSync(filePath, buffer.subarray(0, outputLength));
}

async function resolveBlobBuilderNode(cacheRoot, targetKey, targetNodePath) {
  if (process.version === NODE_VERSION) return process.execPath;
  const hostKey = `${process.platform}-${process.arch}`;
  if (hostKey === targetKey) return targetNodePath;
  const hostTarget = TARGETS[hostKey] || BLOB_BUILDER_HOSTS[hostKey];
  if (!hostTarget) {
    throw new Error(
      `Node ${NODE_VERSION} is required to build the SEA blob on unsupported host ${hostKey}`,
    );
  }
  return (await ensureExtractedNode(hostTarget, cacheRoot)).binaryPath;
}

async function main() {
  const targetKey = resolveTarget(process.argv.slice(2));
  const target = TARGETS[targetKey];
  if (!target) {
    throw new Error(
      `Unsupported CLI runtime target: ${targetKey}. Supported: ${Object.keys(TARGETS).join(", ")}`,
    );
  }
  if (!fs.existsSync(cliBundlePath)) {
    throw new Error(
      `Missing CLI bundle: ${cliBundlePath}. Run npm run build:cli first.`,
    );
  }
  if (target.platform === "darwin" && process.platform !== "darwin") {
    throw new Error(
      "macOS SEA injection requires a macOS build host so the source signature can be removed safely",
    );
  }

  const cacheRoot =
    process.env.GYSHELL_CLI_NODE_CACHE ||
    path.join(projectRoot, "node_modules", ".cache", "gyshell-cli-node");
  const { binaryPath: targetNodePath, licensePath } = await ensureExtractedNode(
    target,
    cacheRoot,
  );
  const blobBuilderNode = await resolveBlobBuilderNode(
    cacheRoot,
    targetKey,
    targetNodePath,
  );
  const identity = inspectNativeBinary(targetNodePath);
  if (!matchesNativeBinaryTarget(identity, target.platform, target.arch)) {
    throw new Error(
      `Downloaded Node binary does not match ${targetKey}: ${formatNativeBinaryIdentity(identity)}`,
    );
  }

  const workRoot = await fsp.mkdtemp(
    path.join(os.tmpdir(), "gyshell-cli-sea-"),
  );
  const targetOutputRoot = path.join(runtimeRoot, targetKey);
  const stagedOutputRoot = path.join(
    runtimeRoot,
    `.${targetKey}.${process.pid}.partial`,
  );
  try {
    const blobPath = path.join(workRoot, "gyll.blob");
    const seaConfigPath = path.join(workRoot, "sea-config.json");
    await fsp.writeFile(
      seaConfigPath,
      `${JSON.stringify(
        {
          main: cliBundlePath,
          output: blobPath,
          disableExperimentalSEAWarning: true,
          useSnapshot: false,
          useCodeCache: false,
          execArgvExtension: "none",
        },
        null,
        2,
      )}\n`,
    );
    const cleanEnv = { ...process.env };
    delete cleanEnv.NODE_OPTIONS;
    runChecked(blobBuilderNode, ["--experimental-sea-config", seaConfigPath], {
      env: cleanEnv,
    });

    await fsp.rm(stagedOutputRoot, { recursive: true, force: true });
    await fsp.mkdir(path.join(stagedOutputRoot, "bin"), { recursive: true });
    await fsp.mkdir(path.join(stagedOutputRoot, "licenses"), {
      recursive: true,
    });
    const outputBinary = path.join(stagedOutputRoot, "bin", target.outputName);
    await fsp.copyFile(targetNodePath, outputBinary);
    await fsp.chmod(outputBinary, 0o755);

    if (target.platform === "darwin") {
      runChecked("codesign", ["--remove-signature", outputBinary]);
    } else if (target.platform === "win32") {
      stripPeAuthenticodeSignature(outputBinary);
    }

    await inject(outputBinary, "NODE_SEA_BLOB", await fsp.readFile(blobPath), {
      sentinelFuse: NODE_SEA_SENTINEL,
      machoSegmentName: "NODE_SEA",
    });
    await fsp.chmod(outputBinary, 0o755);
    if (target.platform === "darwin") {
      // macOS kills modified Mach-O executables until they are sealed again.
      // electron-builder replaces this ad-hoc signature during app signing.
      runChecked("codesign", ["--force", "--sign", "-", outputBinary]);
    }
    if (
      !fs
        .readFileSync(outputBinary)
        .includes(Buffer.from(ENABLED_NODE_SEA_SENTINEL))
    ) {
      throw new Error(
        `Generated gyll does not contain an enabled Node SEA sentinel: ${outputBinary}`,
      );
    }
    await fsp.copyFile(
      licensePath,
      path.join(stagedOutputRoot, "licenses", "node-LICENSE"),
    );

    const outputIdentity = inspectNativeBinary(outputBinary);
    if (
      !matchesNativeBinaryTarget(outputIdentity, target.platform, target.arch)
    ) {
      throw new Error(
        `Generated gyll binary does not match ${targetKey}: ${formatNativeBinaryIdentity(outputIdentity)}`,
      );
    }
    const metadata = {
      schemaVersion: 1,
      format: "node-sea",
      command: "gyll",
      platform: target.platform,
      arch: target.arch,
      nodeVersion: NODE_VERSION,
      appVersion: rootPackage.version,
      cliVersion: cliPackage.version,
      bundleSha256: sha256File(cliBundlePath),
      packagingInputSha256: sha256File(outputBinary),
      checksumStage: "after-sea-injection-before-platform-signing",
      sourceArchive: target.archive,
      sourceArchiveSha256: target.archiveSha256,
      sourceBinarySha256: target.binarySha256,
    };
    await fsp.writeFile(
      path.join(stagedOutputRoot, "metadata.json"),
      `${JSON.stringify(metadata, null, 2)}\n`,
    );

    if (process.platform === target.platform && process.arch === target.arch) {
      const result = runChecked(outputBinary, ["--help"], { timeout: 15_000 });
      if (!result.stdout.includes("GyShell command CLI")) {
        throw new Error(
          `Generated gyll --help output is invalid: ${result.stdout.slice(0, 200)}`,
        );
      }
    }

    await fsp.mkdir(runtimeRoot, { recursive: true });
    await fsp.rm(targetOutputRoot, { recursive: true, force: true });
    await fsp.rename(stagedOutputRoot, targetOutputRoot);
    console.log(
      `[prepare-cli-runtime] Prepared ${targetKey} at ${targetOutputRoot}`,
    );
  } finally {
    await fsp.rm(stagedOutputRoot, { recursive: true, force: true });
    await fsp.rm(workRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(
    `[prepare-cli-runtime] ${error instanceof Error ? error.stack || error.message : String(error)}`,
  );
  process.exitCode = 1;
});
