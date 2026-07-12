import { createRequire } from "node:module";
import path from "node:path";
import prunePackagedRuntime from "./prune-packaged-runtime.mjs";
import validateBetterSqlite3Runtime from "./validate-better-sqlite3-runtime.mjs";
import validateCliRuntime from "./validate-cli-runtime.mjs";
import validateWindowsNodePtyRuntime from "./validate-windows-node-pty-runtime.mjs";

const require = createRequire(import.meta.url);
const applySandboxFix = require("electron-builder-sandbox-fix");
const { flipFuses, FuseVersion, FuseV1Options } = require("@electron/fuses");

export default async function afterPack(context) {
  await prunePackagedRuntime(context);
  await validateBetterSqlite3Runtime(context);
  await validateCliRuntime(context);
  await validateWindowsNodePtyRuntime(context);
  await disableElectronRunAsNode(context);

  if (context?.electronPlatformName === "linux") {
    // The sandbox compatibility hook replaces the Electron binary with a
    // shell wrapper, so fuses must be flipped before that hook runs.
    await applySandboxFix(context);
  }
}

async function disableElectronRunAsNode(context) {
  const platform = context?.electronPlatformName;
  const productFilename =
    context?.packager?.appInfo?.productFilename || "GyShell";
  let executablePath;
  if (platform === "darwin") {
    executablePath = path.join(
      context.appOutDir,
      `${productFilename}.app`,
      "Contents",
      "MacOS",
      productFilename,
    );
  } else if (platform === "win32") {
    executablePath = path.join(context.appOutDir, `${productFilename}.exe`);
  } else if (platform === "linux") {
    executablePath = path.join(
      context.appOutDir,
      context?.packager?.executableName || "gyshell",
    );
  } else {
    throw new Error(`Unsupported Electron fuse platform: ${platform}`);
  }

  await flipFuses(executablePath, {
    version: FuseVersion.V1,
    [FuseV1Options.RunAsNode]: false,
  });
}
