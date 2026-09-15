import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

const ARCH_BY_BUILDER_VALUE = {
  1: "x64",
  3: "arm64",
};

const BETTER_SQLITE3_MODULE_NAMES = [
  "better-sqlite3",
  "better-sqlite3-electron",
];

const BETTER_SQLITE3_PRUNE_PATHS = [
  "README.md",
  "binding.gyp",
  "bin",
  "deps",
  "src",
  "build/deps",
  "build/Makefile",
  "build/better_sqlite3.target.mk",
  "build/binding.Makefile",
  "build/config.gypi",
  "build/gyp-mac-tool",
  "build/test_extension.target.mk",
  "build/Release/test_extension.node",
];

const NODE_PTY_COMMON_PRUNE_PATHS = [
  "binding.gyp",
  "bin",
  "deps",
  "scripts",
  "src",
  "typings",
];

const NODE_PTY_KEEP_RELEASE_FILES = new Set(["pty.node", "spawn-helper"]);

function resolveResourcesRoot(context) {
  if (context?.electronPlatformName === "darwin") {
    const configuredProductName = context?.packager?.appInfo?.productFilename;
    const preferredAppBundlePath = configuredProductName
      ? path.join(context.appOutDir, `${configuredProductName}.app`)
      : null;
    const appBundlePath =
      preferredAppBundlePath && fsSync.existsSync(preferredAppBundlePath)
        ? preferredAppBundlePath
        : fsSync
            .readdirSync(context.appOutDir)
            .find((entry) => entry.endsWith(".app"));
    if (!appBundlePath) {
      throw new Error(
        `Unable to locate macOS app bundle in ${context.appOutDir}`,
      );
    }
    const resolvedAppBundlePath = appBundlePath.startsWith(context.appOutDir)
      ? appBundlePath
      : path.join(context.appOutDir, appBundlePath);
    return path.join(resolvedAppBundlePath, "Contents", "Resources");
  }
  return path.join(context.appOutDir, "resources");
}

async function pathExists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function removeIfPresent(targetPath) {
  await fs.rm(targetPath, { recursive: true, force: true });
}

async function removeFilesMatching(rootPath, predicate) {
  if (!(await pathExists(rootPath))) {
    return;
  }

  const entries = await fs.readdir(rootPath, { withFileTypes: true });
  await Promise.all(
    entries.map(async (entry) => {
      const entryPath = path.join(rootPath, entry.name);
      if (entry.isDirectory()) {
        await removeFilesMatching(entryPath, predicate);
        return;
      }
      if (predicate(entryPath, entry.name)) {
        await removeIfPresent(entryPath);
      }
    }),
  );
}

async function pruneBetterSqlite3Module(nodeModulesRoot, moduleName) {
  const moduleRoot = path.join(nodeModulesRoot, moduleName);
  if (!(await pathExists(moduleRoot))) {
    return;
  }

  await Promise.all(
    BETTER_SQLITE3_PRUNE_PATHS.map((relativePath) =>
      removeIfPresent(path.join(moduleRoot, relativePath)),
    ),
  );
}

async function pruneNodePtyBuildOutput(moduleRoot, platform) {
  const buildRoot = path.join(moduleRoot, "build");
  if (!(await pathExists(buildRoot))) {
    return;
  }

  if (platform !== "darwin") {
    await removeIfPresent(buildRoot);
    return;
  }

  const buildEntries = await fs.readdir(buildRoot, { withFileTypes: true });
  await Promise.all(
    buildEntries
      .filter((entry) => entry.name !== "Release")
      .map((entry) => removeIfPresent(path.join(buildRoot, entry.name))),
  );

  const releaseRoot = path.join(buildRoot, "Release");
  if (!(await pathExists(releaseRoot))) {
    return;
  }

  const releaseEntries = await fs.readdir(releaseRoot, { withFileTypes: true });
  await Promise.all(
    releaseEntries
      .filter((entry) => !NODE_PTY_KEEP_RELEASE_FILES.has(entry.name))
      .map((entry) => removeIfPresent(path.join(releaseRoot, entry.name))),
  );
}

async function pruneNodePtyModule(nodeModulesRoot, platform, arch) {
  const moduleRoot = path.join(nodeModulesRoot, "node-pty");
  if (!(await pathExists(moduleRoot))) {
    return;
  }

  await Promise.all(
    NODE_PTY_COMMON_PRUNE_PATHS.map((relativePath) =>
      removeIfPresent(path.join(moduleRoot, relativePath)),
    ),
  );
  await removeFilesMatching(
    path.join(moduleRoot, "lib"),
    (_filePath, fileName) => {
      return fileName.endsWith(".map") || /\.test\.js$/.test(fileName);
    },
  );
  await pruneNodePtyBuildOutput(moduleRoot, platform);

  // node-pty starts this helper through posix_spawn. electron-builder can copy
  // it into app.asar.unpacked with a data-file mode (0644), which makes every
  // local PTY fail with EACCES on macOS. Restore the executable bit after
  // pruning so the packaged runtime behaves like the npm module.
  const executablePaths = [
    path.join(moduleRoot, "prebuilds", `${platform}-${arch}`, "spawn-helper"),
    path.join(moduleRoot, "build", "Release", "spawn-helper"),
  ];
  await Promise.all(
    executablePaths.map(async (filePath) => {
      if (await pathExists(filePath)) {
        const mode = (await fs.stat(filePath)).mode;
        await fs.chmod(filePath, mode | 0o111);
      }
    }),
  );

  const prebuildsRoot = path.join(moduleRoot, "prebuilds");
  if (!(await pathExists(prebuildsRoot))) {
    return;
  }

  const targetPrebuild = `${platform}-${arch}`;
  const prebuildEntries = await fs.readdir(prebuildsRoot, {
    withFileTypes: true,
  });
  await Promise.all(
    prebuildEntries
      .filter((entry) => entry.isDirectory() && entry.name !== targetPrebuild)
      .map((entry) => removeIfPresent(path.join(prebuildsRoot, entry.name))),
  );
}

async function pruneTreeSitterBashModule(nodeModulesRoot) {
  const moduleRoot = path.join(nodeModulesRoot, "tree-sitter-bash");
  if (!(await pathExists(moduleRoot))) {
    return;
  }

  const entries = await fs.readdir(moduleRoot, { withFileTypes: true });
  await Promise.all(
    entries
      .filter((entry) => entry.name !== "tree-sitter-bash.wasm")
      .map((entry) => removeIfPresent(path.join(moduleRoot, entry.name))),
  );
}

export default async function prunePackagedRuntime(context) {
  const platform = context?.electronPlatformName;
  if (!platform) {
    throw new Error("Missing electron platform name in afterPack context");
  }

  const arch = ARCH_BY_BUILDER_VALUE[context.arch];
  if (!arch) {
    throw new Error(
      `Unsupported pack architecture for unpacked runtime pruning: ${context.arch}`,
    );
  }

  const resourcesRoot = resolveResourcesRoot(context);
  const nodeModulesRoot = path.join(
    resourcesRoot,
    "app.asar.unpacked",
    "node_modules",
  );
  if (!(await pathExists(nodeModulesRoot))) {
    return;
  }

  await Promise.all(
    BETTER_SQLITE3_MODULE_NAMES.map((moduleName) =>
      pruneBetterSqlite3Module(nodeModulesRoot, moduleName),
    ),
  );
  await pruneNodePtyModule(nodeModulesRoot, platform, arch);
  await pruneTreeSitterBashModule(nodeModulesRoot);
}
