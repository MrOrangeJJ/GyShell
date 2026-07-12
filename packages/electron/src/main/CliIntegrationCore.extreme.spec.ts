import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  inspectLinuxCliIntegration,
  inspectLinuxCliIntegrationFast,
  inspectMacCliIntegration,
  installLinuxUserCli,
  installMacCliIntegration,
  isForwardAppVersionUpgrade,
  pathContainsDirectory,
  prependPathEntry,
  removeLinuxUserCli,
  removeMacCliIntegration,
  resolveLinuxUserCliPaths,
} from "./CliIntegrationCore";
import {
  buildPackagedCliPathShellSnippet,
  PACKAGED_CLI_DIRECTORY_ENV,
} from "../../../backend/src/services/terminal/packagedCliEnvironment";

function temporaryDirectory(name: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `${name}-`));
}

function macBundlePathForCli(cliPath: string): string {
  let bundlePath = cliPath;
  for (let depth = 0; depth < 5; depth += 1) {
    bundlePath = path.dirname(bundlePath);
  }
  return bundlePath;
}

function writeMacBundleInfo(cliPath: string, bundleId: string): void {
  const bundlePath = macBundlePathForCli(cliPath);
  const infoPath = path.join(bundlePath, "Contents", "Info.plist");
  fs.mkdirSync(path.dirname(infoPath), { recursive: true });
  fs.writeFileSync(
    infoPath,
    `<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict><key>CFBundleIdentifier</key><string>${bundleId}</string></dict></plist>\n`,
  );
}

function withInjectedRenameFailure(
  destinationPath: string,
  action: () => void,
): void {
  const originalRenameSync = fs.renameSync;
  Object.defineProperty(fs, "renameSync", {
    configurable: true,
    value: (oldPath: fs.PathLike, newPath: fs.PathLike) => {
      if (path.resolve(String(newPath)) === path.resolve(destinationPath)) {
        throw Object.assign(new Error("injected rename failure"), {
          code: "EIO",
        });
      }
      return originalRenameSync(oldPath, newPath);
    },
  });
  try {
    action();
  } finally {
    Object.defineProperty(fs, "renameSync", {
      configurable: true,
      value: originalRenameSync,
    });
  }
}

const cases: Array<[string, () => void | Promise<void>]> = [
  [
    "PATH insertion is idempotent and platform aware",
    () => {
      const posixEnv = { PATH: "/usr/bin:/bin" };
      assert.equal(prependPathEntry(posixEnv, "/app/cli", "darwin"), true);
      assert.equal(prependPathEntry(posixEnv, "/app/cli", "darwin"), false);
      assert.equal(posixEnv.PATH, "/app/cli:/usr/bin:/bin");
      assert.equal(pathContainsDirectory(posixEnv, "/app/cli", "darwin"), true);

      const windowsEnv = { Path: "C:\\Windows\\System32" };
      assert.equal(
        prependPathEntry(
          windowsEnv,
          "C:\\Program Files\\GyShell\\cli",
          "win32",
        ),
        true,
      );
      assert.equal(
        prependPathEntry(
          windowsEnv,
          "c:\\program files\\gyshell\\cli\\",
          "win32",
        ),
        false,
      );
    },
  ],
  [
    "packaged CLI remains first after POSIX profiles replace PATH",
    () => {
      if (process.platform === "win32") return;
      const cliDirectory =
        "/Applications/GyShell 2.app/Contents/Resources/cli/bin";
      const result = spawnSync(
        "/bin/sh",
        [
          "-c",
          `PATH=/usr/local/bin:/usr/bin\n${buildPackagedCliPathShellSnippet()}\nprintf '%s' "$PATH"`,
        ],
        {
          encoding: "utf8",
          env: {
            PATH: process.env.PATH,
            [PACKAGED_CLI_DIRECTORY_ENV]: cliDirectory,
          },
        },
      );
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout, `${cliDirectory}:/usr/local/bin:/usr/bin`);
    },
  ],
  [
    "macOS integration replaces only GyShell-owned links",
    async () => {
      const root = temporaryDirectory("gyshell-cli-mac");
      const source = path.join(
        root,
        "GyShell 2.app",
        "Contents",
        "Resources",
        "cli",
        "bin",
        "gyll",
      );
      const oldSource = path.join(
        root,
        "Old",
        "GyShell old.app",
        "Contents",
        "Resources",
        "cli",
        "bin",
        "gyll",
      );
      const target = path.join(root, "bin", "gyll");
      const ownershipManifestPath = path.join(root, "state", "mac-cli.json");
      fs.mkdirSync(path.dirname(source), { recursive: true });
      fs.mkdirSync(path.dirname(oldSource), { recursive: true });
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(source, "new");
      fs.writeFileSync(oldSource, "old");
      fs.chmodSync(source, 0o755);
      fs.chmodSync(oldSource, 0o755);
      writeMacBundleInfo(source, "com.gyshell.app");
      writeMacBundleInfo(oldSource, "com.gyshell.app");
      fs.symlinkSync(oldSource, target);

      assert.equal(
        inspectMacCliIntegration(source, target, ownershipManifestPath).kind,
        "stale-owned",
      );
      await installMacCliIntegration(
        source,
        target,
        async () => {
          assert.fail("writable test paths must not require authorization");
        },
        ownershipManifestPath,
      );
      assert.equal(path.resolve(fs.readlinkSync(target)), path.resolve(source));

      const movedBundlePath = path.join(root, "Moved GyShell.app");
      fs.renameSync(macBundlePathForCli(source), movedBundlePath);
      const movedSource = path.join(
        movedBundlePath,
        "Contents",
        "Resources",
        "cli",
        "bin",
        "gyll",
      );
      assert.equal(
        inspectMacCliIntegration(movedSource, target, ownershipManifestPath)
          .kind,
        "stale-owned",
      );
      await installMacCliIntegration(
        movedSource,
        target,
        async () => {
          assert.fail("writable test paths must not require authorization");
        },
        ownershipManifestPath,
      );
      assert.equal(fs.readlinkSync(target), movedSource);

      const relocatedBundlePath = path.join(root, "Relocated GyShell.app");
      fs.renameSync(movedBundlePath, relocatedBundlePath);
      const relocatedSource = path.join(
        relocatedBundlePath,
        "Contents",
        "Resources",
        "cli",
        "bin",
        "gyll",
      );
      await removeMacCliIntegration(
        relocatedSource,
        target,
        async () => {
          assert.fail("writable test paths must not require authorization");
        },
        ownershipManifestPath,
      );
      assert.equal(fs.existsSync(target), false);
      assert.equal(fs.existsSync(ownershipManifestPath), false);

      const foreignSource = path.join(
        root,
        "Foreign.app",
        "Contents",
        "Resources",
        "cli",
        "bin",
        "gyll",
      );
      fs.mkdirSync(path.dirname(foreignSource), { recursive: true });
      fs.writeFileSync(foreignSource, "foreign app");
      fs.chmodSync(foreignSource, 0o755);
      writeMacBundleInfo(foreignSource, "com.example.foreign");
      fs.symlinkSync(foreignSource, target);
      assert.equal(
        inspectMacCliIntegration(relocatedSource, target, ownershipManifestPath)
          .kind,
        "conflict",
      );
      await assert.rejects(
        removeMacCliIntegration(
          relocatedSource,
          target,
          async () => undefined,
          ownershipManifestPath,
        ),
        /unmanaged command/,
      );
      assert.equal(fs.readlinkSync(target), foreignSource);
      fs.unlinkSync(target);

      fs.writeFileSync(target, "foreign");
      await assert.rejects(
        installMacCliIntegration(
          relocatedSource,
          target,
          async () => undefined,
          ownershipManifestPath,
        ),
        /unmanaged command/,
      );
      assert.equal(fs.readFileSync(target, "utf8"), "foreign");
    },
  ],
  [
    "Linux fast inspection uses manifest fingerprints without binary reads",
    () => {
      const root = temporaryDirectory("gyshell-cli-linux-fast");
      const sourcePath = path.join(root, "app", "gyll");
      const targetPath = path.join(root, "home", ".local", "bin", "gyll");
      const manifestPath = path.join(root, "state", "cli.json");
      fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
      fs.writeFileSync(sourcePath, "runtime-payload");
      const options = {
        sourcePath,
        targetPath,
        manifestPath,
        appVersion: "1.6.0",
      };
      const installed = installLinuxUserCli(options);
      const verifiedOptions = {
        ...options,
        sourceSha256: installed.resolvedSourceSha256,
      };
      const descriptor = Object.getOwnPropertyDescriptor(fs, "readFileSync");
      assert.ok(descriptor);
      let binaryReads = 0;
      Object.defineProperty(fs, "readFileSync", {
        ...descriptor,
        value: (filePath: fs.PathOrFileDescriptor, ...args: unknown[]) => {
          if (
            typeof filePath === "string" &&
            [sourcePath, targetPath].some(
              (candidate) => path.resolve(filePath) === path.resolve(candidate),
            )
          ) {
            binaryReads += 1;
          }
          return Reflect.apply(descriptor.value, fs, [filePath, ...args]);
        },
      });
      try {
        assert.equal(
          inspectLinuxCliIntegrationFast(verifiedOptions).kind,
          "installed",
        );
        assert.equal(
          inspectLinuxCliIntegrationFast(verifiedOptions).kind,
          "installed",
        );
      } finally {
        Object.defineProperty(fs, "readFileSync", descriptor);
      }
      assert.equal(binaryReads, 0);
      assert.equal(
        JSON.parse(fs.readFileSync(manifestPath, "utf8")).appVersion,
        "1.6.0",
      );
    },
  ],
  [
    "Linux inaccessible targets never lose their ownership manifest",
    () => {
      if (process.platform === "win32") return;
      const root = temporaryDirectory("gyshell-cli-linux-permissions");
      const sourcePath = path.join(root, "app", "gyll");
      const targetPath = path.join(root, "home", ".local", "bin", "gyll");
      const manifestPath = path.join(root, "state", "cli.json");
      fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
      fs.writeFileSync(sourcePath, "owned-runtime");
      const options = { sourcePath, targetPath, manifestPath };
      installLinuxUserCli(options);
      const targetDirectory = path.dirname(targetPath);
      fs.chmodSync(targetDirectory, 0o000);
      try {
        assert.equal(inspectLinuxCliIntegration(options).kind, "conflict");
        assert.equal(inspectLinuxCliIntegrationFast(options).kind, "conflict");
        assert.throws(() => removeLinuxUserCli(options), /unmanaged command/);
        assert.equal(fs.existsSync(manifestPath), true);
      } finally {
        fs.chmodSync(targetDirectory, 0o755);
      }
      assert.equal(inspectLinuxCliIntegration(options).kind, "installed");
    },
  ],
  [
    "Linux automatic updates only move app versions forward",
    () => {
      assert.equal(isForwardAppVersionUpgrade("1.6.0", "1.7.0"), true);
      assert.equal(isForwardAppVersionUpgrade("1.7.0", "1.6.0"), false);
      assert.equal(isForwardAppVersionUpgrade("1.6.0", "1.6.0"), false);
      assert.equal(
        isForwardAppVersionUpgrade("1.7.0-beta.1", "1.7.0-beta.2"),
        true,
      );
      assert.equal(isForwardAppVersionUpgrade("1.7.0-beta.2", "1.7.0"), true);
      assert.equal(isForwardAppVersionUpgrade(undefined, "1.7.0"), false);
    },
  ],
  [
    "Linux refuses an identical executable without an ownership manifest",
    () => {
      const root = temporaryDirectory("gyshell-cli-linux-unmanaged");
      const sourcePath = path.join(root, "app", "gyll");
      const targetPath = path.join(root, "home", ".local", "bin", "gyll");
      const manifestPath = path.join(root, "state", "cli.json");
      fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
      fs.mkdirSync(path.dirname(targetPath), { recursive: true });
      fs.writeFileSync(sourcePath, "identical-content");
      fs.copyFileSync(sourcePath, targetPath);
      fs.chmodSync(targetPath, 0o755);
      const options = { sourcePath, targetPath, manifestPath };

      assert.equal(inspectLinuxCliIntegration(options).kind, "conflict");
      assert.throws(() => installLinuxUserCli(options), /unmanaged command/);
      assert.throws(() => removeLinuxUserCli(options), /unmanaged command/);
      assert.equal(fs.readFileSync(targetPath, "utf8"), "identical-content");
    },
  ],
  [
    "Linux update failures preserve the working owned command",
    () => {
      const root = temporaryDirectory("gyshell-cli-linux-atomic");
      const sourcePath = path.join(root, "app", "gyll");
      const targetPath = path.join(root, "home", ".local", "bin", "gyll");
      const manifestPath = path.join(root, "state", "cli.json");
      fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
      fs.writeFileSync(sourcePath, "version-one");
      const options = { sourcePath, targetPath, manifestPath };
      installLinuxUserCli(options);

      fs.writeFileSync(sourcePath, "version-two");
      assert.throws(
        () =>
          withInjectedRenameFailure(targetPath, () => {
            installLinuxUserCli(options);
          }),
        /injected rename failure/,
      );
      assert.equal(fs.readFileSync(targetPath, "utf8"), "version-one");
      assert.equal(inspectLinuxCliIntegration(options).kind, "stale-owned");

      installLinuxUserCli(options);
      fs.writeFileSync(sourcePath, "version-three");
      assert.throws(
        () =>
          withInjectedRenameFailure(manifestPath, () => {
            installLinuxUserCli(options);
          }),
        /injected rename failure/,
      );
      assert.equal(fs.readFileSync(targetPath, "utf8"), "version-two");
      assert.equal(inspectLinuxCliIntegration(options).kind, "stale-owned");
    },
  ],
  [
    "Linux copy updates only a manifest-owned executable",
    () => {
      const root = temporaryDirectory("gyshell-cli-linux");
      const source = path.join(root, "app", "gyll");
      const home = path.join(root, "home");
      const paths = resolveLinuxUserCliPaths(home, {
        XDG_STATE_HOME: path.join(root, "state"),
      });
      fs.mkdirSync(path.dirname(source), { recursive: true });
      fs.writeFileSync(source, "version-one");
      const options = { sourcePath: source, ...paths };

      assert.equal(inspectLinuxCliIntegration(options).kind, "missing");
      installLinuxUserCli(options);
      assert.equal(inspectLinuxCliIntegration(options).kind, "installed");
      assert.equal(fs.readFileSync(paths.targetPath, "utf8"), "version-one");
      assert.notEqual(fs.statSync(paths.targetPath).mode & 0o111, 0);

      fs.chmodSync(paths.targetPath, 0o644);
      assert.equal(inspectLinuxCliIntegration(options).kind, "stale-owned");
      installLinuxUserCli(options);
      assert.notEqual(fs.statSync(paths.targetPath).mode & 0o111, 0);

      fs.chmodSync(paths.targetPath, 0o401);
      assert.equal(inspectLinuxCliIntegration(options).kind, "stale-owned");
      installLinuxUserCli(options);
      fs.accessSync(paths.targetPath, fs.constants.X_OK);

      fs.writeFileSync(source, "version-two");
      assert.equal(inspectLinuxCliIntegration(options).kind, "stale-owned");
      installLinuxUserCli(options);
      assert.equal(fs.readFileSync(paths.targetPath, "utf8"), "version-two");

      fs.writeFileSync(paths.targetPath, "user replacement");
      assert.equal(inspectLinuxCliIntegration(options).kind, "conflict");
      assert.throws(() => installLinuxUserCli(options), /unmanaged command/);
      assert.throws(() => removeLinuxUserCli(options), /unmanaged command/);
      assert.equal(
        fs.readFileSync(paths.targetPath, "utf8"),
        "user replacement",
      );
    },
  ],
  [
    "Linux install rejects a mismatched bundled checksum",
    () => {
      const root = temporaryDirectory("gyshell-cli-linux-integrity");
      const sourcePath = path.join(root, "app", "gyll");
      const targetPath = path.join(root, "home", ".local", "bin", "gyll");
      const manifestPath = path.join(root, "state", "cli.json");
      fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
      fs.writeFileSync(sourcePath, "tampered");
      assert.throws(
        () =>
          installLinuxUserCli({
            sourcePath,
            targetPath,
            manifestPath,
            sourceSha256: "0".repeat(64),
          }),
        /integrity check/,
      );
      assert.equal(fs.existsSync(targetPath), false);
    },
  ],
];

for (const [name, test] of cases) {
  await test();
  console.log(`PASS ${name}`);
}

console.log("All CLI integration core tests passed.");
