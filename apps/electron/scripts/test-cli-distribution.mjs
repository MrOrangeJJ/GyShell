#!/usr/bin/env node
/* eslint-disable no-console */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const require = createRequire(import.meta.url);
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDir, "../../..");

require.extensions[".ts"] = function registerTs(module, filename) {
  const source = fs.readFileSync(filename, "utf8");
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
      moduleResolution: ts.ModuleResolutionKind.Node10,
    },
    fileName: filename,
  });
  module._compile(outputText, filename);
};

function fromRoot(relativePath) {
  return path.join(projectRoot, relativePath);
}

function readText(relativePath) {
  return fs.readFileSync(fromRoot(relativePath), "utf8");
}

function temporaryDirectory(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeFile(filePath, content, mode) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf8");
  if (mode) fs.chmodSync(filePath, mode);
}

function testBuildAndPackageOwnership() {
  const rootPackage = JSON.parse(readText("package.json"));
  for (const scriptName of [
    "dist",
    "dist:mac",
    "dist:win",
    "dist:linux",
    "dist:linux-arm64",
  ]) {
    const script = rootPackage.scripts?.[scriptName] || "";
    assert.match(
      script,
      /build:cli/,
      `${scriptName} must build the command bundle`,
    );
    assert.match(
      script,
      /prepare:cli-runtime/,
      `${scriptName} must prepare the target SEA`,
    );
  }
  assert.match(
    rootPackage.scripts["dist:mac"],
    /--prepackaged dist\/mac-arm64\/GyShell\.app/,
    "mac DMG must consume the exact app bundle instead of nesting mac-arm64",
  );
  assert.match(
    rootPackage.scripts.dist,
    /ensure:dist-target-native/,
    "generic dist must prepare the architecture selected by electron-builder",
  );
  assert.doesNotMatch(
    rootPackage.scripts.dist,
    /ensure:electron-native/,
    "generic dist must not restore the host arch before a fixed-arch package",
  );

  const builder = readText("apps/electron/electron-builder.yml");
  for (const source of ["darwin-${arch}", "win32-${arch}", "linux-${arch}"]) {
    assert.ok(
      builder.includes(`apps/electron/cli-runtime/${source}`),
      `missing runtime source ${source}`,
    );
  }
  assert.match(builder, /include:\s*apps\/electron\/materials\/installer\.nsh/);
  assert.equal(
    (
      builder.match(
        /apps\/electron\/cli-launchers\/linux\/gyll=\/usr\/bin\/gyll/g,
      ) || []
    ).length,
    3,
    "deb, rpm, and pacman must each own /usr/bin/gyll",
  );
  assert.doesNotMatch(builder, /postinstall-linux|afterInstall:/);

  const afterPack = readText("apps/electron/scripts/after-pack.mjs");
  assert.match(afterPack, /validateCliRuntime/);
  assert.match(afterPack, /FuseV1Options\.RunAsNode/);
  assert.match(afterPack, /disableElectronRunAsNode/);
  const prepare = readText("apps/electron/scripts/prepare-cli-runtime.mjs");
  assert.match(prepare, /format:\s*["']node-sea["']/);
  assert.match(prepare, /useSnapshot:\s*false/);
  assert.match(prepare, /useCodeCache:\s*false/);
  assert.match(prepare, /execArgvExtension:\s*["']none["']/);
  assert.match(prepare, /ENABLED_NODE_SEA_SENTINEL/);
  assert.match(prepare, /sourceArchiveSha256/);
  assert.match(prepare, /sourceBinarySha256/);
  assert.match(prepare, /"win32-arm64"/);

  const validator = readText("apps/electron/scripts/validate-cli-runtime.mjs");
  assert.match(validator, /metadata\.appVersion/);
  assert.match(validator, /metadata\.bundleSha256/);
  assert.match(validator, /sha256File\(cliBundlePath\)/);

  const launcherPath = fromRoot("apps/electron/cli-launchers/linux/gyll");
  assert.notEqual(
    fs.statSync(launcherPath).mode & 0o111,
    0,
    "Linux launcher must be executable",
  );
}

function testWindowsPathIntegrationIsExactAndNonTruncating() {
  const installer = readText("apps/electron/materials/installer.nsh");
  const helper = readText("apps/electron/materials/gyshell-cli-path.ps1");
  assert.match(installer, /customInstall/);
  assert.match(installer, /customUnInstall/);
  assert.match(installer, /WM_SETTINGCHANGE/);
  assert.match(installer, /resources\\cli\\bin/);
  assert.doesNotMatch(installer, /\bAbort\b/);
  assert.doesNotMatch(`${installer}\n${helper}`, /\bsetx\b/i);
  assert.match(helper, /DoNotExpandEnvironmentNames/);
  assert.match(helper, /OrdinalIgnoreCase/);
  assert.match(helper, /RegistryValueKind/);
}

function testMacAuthorizationScriptParsesWithoutPrompting() {
  if (process.platform !== "darwin") return;
  const service = readText(
    "packages/electron/src/main/CliIntegrationService.ts",
  );
  const script = service.match(
    /const MAC_PRIVILEGED_LINK_SCRIPT = String\.raw`([\s\S]*?)`;/,
  )?.[1];
  assert.ok(
    script,
    "macOS authorization script must remain extractable for syntax validation",
  );
  const result = spawnSync(
    "/usr/bin/osascript",
    [
      "-e",
      script,
      "--",
      "invalid-operation",
      "/Applications/GyShell 2.app/Contents/Resources/cli/bin/gyll",
      "/usr/local/bin/gyll",
      "",
    ],
    { encoding: "utf8" },
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Invalid GyShell CLI integration operation/);
}

function testPosixLegacyMigrationIsOwnershipBounded() {
  const root = temporaryDirectory("gyshell-cli-cleanup-posix-");
  const homeDir = path.join(root, "home");
  const legacyBin = path.join(homeDir, ".gyll", "bin");
  const profilePath = path.join(homeDir, ".zshrc");
  const profileTarget = path.join(root, "dotfiles", "zshrc");
  const legacyLauncher =
    '#!/usr/bin/env bash\nGYLL_BIN="/Applications/GyShell.app/Contents/Resources/cli/bin/gyll"\nexec "$GYLL_BIN" "$@"\n';
  writeFile(path.join(legacyBin, "gyll"), legacyLauncher, 0o755);
  writeFile(path.join(legacyBin, "gyll-tui"), legacyLauncher, 0o755);
  writeFile(path.join(legacyBin, "other"), "#!/bin/sh\necho keep\n", 0o755);
  writeFile(
    profileTarget,
    'before\n# >>> Gyll CLI >>>\nexport PATH="$HOME/.gyll/bin:$PATH"\n# <<< Gyll CLI <<<\nafter\n',
  );
  fs.mkdirSync(path.dirname(profilePath), { recursive: true });
  fs.symlinkSync(profileTarget, profilePath);
  const protectedPath = path.join(root, "must-not-change");
  const oldPredictableTemporaryPath = `${profileTarget}.gyshell-cli-cleanup-${process.pid}`;
  writeFile(protectedPath, "protected\n");
  fs.symlinkSync(protectedPath, oldPredictableTemporaryPath);

  const { cleanupDeprecatedCliLaunchers } = require(
    fromRoot("packages/electron/src/main/DeprecatedCliCleanupService.ts"),
  );
  const result = cleanupDeprecatedCliLaunchers({
    homeDir,
    platform: "darwin",
    env: { PATH: "/usr/bin" },
    logger: { info() {}, warn() {} },
  });
  assert.equal(result.removedPaths.length, 2);
  assert.deepEqual(result.updatedProfiles, [profilePath]);
  assert.equal(fs.existsSync(path.join(legacyBin, "other")), true);
  assert.equal(fs.lstatSync(profilePath).isSymbolicLink(), true);
  assert.equal(fs.readFileSync(profilePath, "utf8"), "before\nafter\n");
  assert.equal(
    fs.readFileSync(protectedPath, "utf8"),
    "protected\n",
    "cleanup must never follow a pre-created temporary symlink",
  );
}

function testWindowsLegacyCleanupCannotTouchNewRuntime() {
  const root = temporaryDirectory("gyshell-cli-cleanup-win-");
  const homeDir = path.join(root, "home");
  const localAppData = path.join(root, "LocalAppData");
  const windowsApps = path.join(localAppData, "Microsoft", "WindowsApps");
  const fallbackBin = path.join(homeDir, ".gyll", "bin");
  const runtime = path.join(
    root,
    "GyShell",
    "resources",
    "cli",
    "bin",
    "gyll.exe",
  );
  const legacyCmd =
    '@echo off\r\nsetlocal\r\nset "GYLL_BIN=C:\\Program Files\\GyShell\\resources\\cli\\bin\\gyll.exe"\r\n"%GYLL_BIN%" %*\r\n';
  writeFile(path.join(windowsApps, "gyll.cmd"), legacyCmd);
  writeFile(path.join(fallbackBin, "gyll.cmd"), legacyCmd);
  writeFile(runtime, "new native runtime");

  const { cleanupDeprecatedCliLaunchers } = require(
    fromRoot("packages/electron/src/main/DeprecatedCliCleanupService.ts"),
  );
  const result = cleanupDeprecatedCliLaunchers({
    homeDir,
    platform: "win32",
    env: { LOCALAPPDATA: localAppData },
    logger: { info() {}, warn() {} },
  });
  assert.equal(result.removedPaths.length, 2);
  assert.deepEqual(result.updatedProfiles, []);
  assert.equal(fs.readFileSync(runtime, "utf8"), "new native runtime");
}

const cases = [
  ["build and package ownership", testBuildAndPackageOwnership],
  [
    "Windows exact PATH integration",
    testWindowsPathIntegrationIsExactAndNonTruncating,
  ],
  [
    "macOS authorization script syntax",
    testMacAuthorizationScriptParsesWithoutPrompting,
  ],
  ["POSIX legacy migration", testPosixLegacyMigrationIsOwnershipBounded],
  [
    "Windows legacy cleanup boundary",
    testWindowsLegacyCleanupCannotTouchNewRuntime,
  ],
];

for (const [name, test] of cases) {
  test();
  console.log(`PASS ${name}`);
}

console.log("All desktop CLI distribution tests passed.");
