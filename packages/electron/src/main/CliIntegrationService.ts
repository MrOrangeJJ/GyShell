import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
  app,
  dialog,
  Menu,
  type BrowserWindow,
  type MenuItemConstructorOptions,
} from "electron";
import {
  inspectLinuxCliIntegrationFast,
  inspectMacCliIntegration,
  installLinuxUserCli,
  installMacCliIntegration,
  isForwardAppVersionUpgrade,
  MAC_CLI_TARGET,
  pathContainsDirectory,
  prependPathEntry,
  recordInstalledMacCliOwnership,
  removeLinuxUserCli,
  removeMacCliIntegration,
  resolveBundledCliPath,
  resolveLinuxUserCliPaths,
  type CliIntegrationKind,
  type LinuxCliIntegrationOptions,
  type LinuxCliIntegrationState,
  type LinuxCliManifest,
  type MacCliPrivilegedAction,
} from "./CliIntegrationCore";
import { PACKAGED_CLI_DIRECTORY_ENV } from "../../../backend/src/services/terminal/packagedCliEnvironment";

const execFileAsync = promisify(execFile);
const CLI_PROMPT_STATE_FILE = "cli-integration-prompt-v1.json";
const MAC_CLI_OWNERSHIP_FILE = "cli-integration-macos-v1.json";

const MAC_PRIVILEGED_LINK_SCRIPT = String.raw`
on run argv
  if (count of argv) is not 4 then error "Invalid GyShell CLI integration arguments."
  set operationName to item 1 of argv
  set sourcePath to item 2 of argv
  set targetPath to item 3 of argv
  set expectedLink to item 4 of argv
  if targetPath is not "/usr/local/bin/gyll" then error "Invalid GyShell CLI target."
  if sourcePath does not end with "/Contents/Resources/cli/bin/gyll" then error "Invalid GyShell CLI source."
  set quotedSource to quoted form of sourcePath
  set quotedTarget to quoted form of targetPath
  set quotedExpected to quoted form of expectedLink
  set validateSource to "source=" & quotedSource & "; d1=$(/usr/bin/dirname \"$source\"); d2=$(/usr/bin/dirname \"$d1\"); d3=$(/usr/bin/dirname \"$d2\"); d4=$(/usr/bin/dirname \"$d3\"); bundle=$(/usr/bin/dirname \"$d4\"); case \"$bundle\" in *.app) ;; *) exit 77;; esac; bundle_id=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' \"$bundle/Contents/Info.plist\") || exit 77; [ \"$bundle_id\" = 'com.gyshell.app' ] || exit 78; "
  if operationName is "install" then
    set shellCommand to validateSource & "/bin/mkdir -p /usr/local/bin && if [ -e " & quotedTarget & " ] || [ -L " & quotedTarget & " ]; then exit 73; fi; if [ ! -x " & quotedSource & " ]; then exit 74; fi; /bin/ln -s " & quotedSource & " " & quotedTarget
  else if operationName is "replace" then
    set shellCommand to validateSource & "actual=$(/usr/bin/readlink " & quotedTarget & ") || exit 75; [ \"$actual\" = " & quotedExpected & " ] || exit 76; [ -x " & quotedSource & " ] || exit 74; temporary=$(/usr/bin/mktemp " & quotedTarget & ".gyshell.XXXXXX) || exit 79; cleanup() { /bin/rm -f \"$temporary\"; }; trap cleanup EXIT HUP INT TERM; /bin/rm \"$temporary\" && /bin/ln -s " & quotedSource & " \"$temporary\" || exit 79; actual=$(/usr/bin/readlink " & quotedTarget & ") || exit 75; [ \"$actual\" = " & quotedExpected & " ] || exit 76; /bin/mv -f \"$temporary\" " & quotedTarget
  else if operationName is "remove" then
    set shellCommand to "actual=$(/usr/bin/readlink " & quotedTarget & ") || exit 75; [ \"$actual\" = " & quotedExpected & " ] || exit 76; /bin/rm " & quotedTarget
  else
    error "Invalid GyShell CLI integration operation."
  end if
  do shell script shellCommand with administrator privileges
end run
`;

export function configurePackagedCliEnvironment(): void {
  if (!app.isPackaged) return;
  const cliPath = resolveBundledCliPath(process.resourcesPath);
  delete process.env[PACKAGED_CLI_DIRECTORY_ENV];
  if (!isRegularFile(cliPath)) {
    console.warn(`[CLI] Bundled runtime is missing: ${cliPath}`);
    return;
  }
  const cliDirectory = path.dirname(cliPath);
  process.env[PACKAGED_CLI_DIRECTORY_ENV] = cliDirectory;
  prependPathEntry(process.env, cliDirectory);
}

export async function initializePackagedCliIntegration(
  primaryWindow: BrowserWindow,
): Promise<void> {
  if (!app.isPackaged) return;
  if (process.platform === "darwin") {
    const controller = createMacController();
    try {
      controller.recordInstalledOwnership?.();
    } catch (error) {
      console.warn("[CLI] Unable to record macOS CLI ownership:", error);
    }
    installCliApplicationMenu(primaryWindow, controller);
    scheduleFirstRunPrompt(primaryWindow, controller);
    return;
  }
  if (process.platform === "linux" && !isPackageManagedLinuxInstall()) {
    const controller = createLinuxController();
    const state = controller.getState();
    const isPermissionRepair =
      state.kind === "stale-owned" &&
      state.currentSha256 === state.resolvedSourceSha256;
    const isForwardUpgrade =
      state.kind === "stale-owned" &&
      isForwardAppVersionUpgrade(state.manifest?.appVersion, state.appVersion);
    if (isPermissionRepair || isForwardUpgrade) {
      try {
        await controller.install();
      } catch (error) {
        console.warn("[CLI] Unable to update the owned user CLI copy:", error);
      }
    }
    installCliApplicationMenu(primaryWindow, controller);
    scheduleFirstRunPrompt(primaryWindow, controller);
  }
}

interface CliIntegrationController {
  getState(): {
    kind: CliIntegrationKind;
    targetPath: string;
    currentSha256?: string;
    resolvedSourceSha256?: string;
    appVersion?: string;
    manifest?: LinuxCliManifest;
  };
  install(): Promise<void> | void;
  remove(): Promise<void> | void;
  successMessage(): string;
  recordInstalledOwnership?(): void;
}

function createMacController(): CliIntegrationController {
  const sourcePath = resolveBundledCliPath(process.resourcesPath, "darwin");
  const ownershipManifestPath = path.join(
    app.getPath("userData"),
    MAC_CLI_OWNERSHIP_FILE,
  );
  return {
    getState: () =>
      inspectMacCliIntegration(
        sourcePath,
        MAC_CLI_TARGET,
        ownershipManifestPath,
      ),
    install: async () => {
      if (!app.isInApplicationsFolder()) {
        throw new Error(
          "Move GyShell.app to an Applications folder before installing the command. A link into a DMG or translocated app would break after ejecting it.",
        );
      }
      await installMacCliIntegration(
        sourcePath,
        MAC_CLI_TARGET,
        runPrivilegedMacCliAction,
        ownershipManifestPath,
      );
    },
    remove: () =>
      removeMacCliIntegration(
        sourcePath,
        MAC_CLI_TARGET,
        runPrivilegedMacCliAction,
        ownershipManifestPath,
      ),
    recordInstalledOwnership: () => {
      recordInstalledMacCliOwnership(
        sourcePath,
        MAC_CLI_TARGET,
        ownershipManifestPath,
      );
    },
    successMessage: () =>
      `Installed ${MAC_CLI_TARGET} as a link to the CLI inside GyShell.app. Existing and future shells can run gyll.`,
  };
}

function createLinuxController(): CliIntegrationController {
  const sourcePath = resolveBundledCliPath(process.resourcesPath, "linux");
  const { targetPath, manifestPath } = resolveLinuxUserCliPaths(
    os.homedir(),
    process.env,
  );
  const bundledMetadata = readBundledCliMetadata();
  const options: LinuxCliIntegrationOptions = {
    sourcePath,
    targetPath,
    manifestPath,
    sourceSha256: bundledMetadata.sha256,
    appVersion: bundledMetadata.appVersion,
  };
  let cachedState: LinuxCliIntegrationState | undefined;
  const getState = () => {
    cachedState ??= inspectLinuxCliIntegrationFast(options);
    return cachedState;
  };
  return {
    getState,
    install: () => {
      try {
        installLinuxUserCli(options);
      } finally {
        cachedState = undefined;
      }
    },
    remove: () => {
      try {
        removeLinuxUserCli(options);
      } finally {
        cachedState = undefined;
      }
    },
    successMessage: () => {
      const binDir = path.dirname(targetPath);
      const pathNote = pathContainsDirectory(process.env, binDir, "linux")
        ? "Restart already-running agents so they inherit the command."
        : `If gyll is not found after signing in again, add ${binDir} to PATH. GyShell does not edit shell profiles.`;
      return `Installed ${targetPath}. ${pathNote}`;
    },
  };
}

function installCliApplicationMenu(
  primaryWindow: BrowserWindow,
  controller: CliIntegrationController,
): void {
  const rebuild = () => {
    const state = controller.getState();
    const cliMenuItem: MenuItemConstructorOptions = {
      label:
        state.kind === "installed"
          ? "Uninstall 'gyll' Command…"
          : state.kind === "stale-owned"
            ? "Repair 'gyll' Command…"
            : "Install 'gyll' Command…",
      click: () => {
        void handleCliMenuAction(primaryWindow, controller).finally(rebuild);
      },
    };
    const template: MenuItemConstructorOptions[] =
      process.platform === "darwin"
        ? [
            {
              role: "appMenu",
              submenu: [
                { role: "about" },
                { type: "separator" },
                cliMenuItem,
                { type: "separator" },
                { role: "services" },
                { type: "separator" },
                { role: "hide" },
                { role: "hideOthers" },
                { role: "unhide" },
                { type: "separator" },
                { role: "quit" },
              ],
            },
            { role: "fileMenu" },
            { role: "editMenu" },
            { role: "viewMenu" },
            { role: "windowMenu" },
            { role: "help" },
          ]
        : [
            { role: "fileMenu" },
            { role: "editMenu" },
            { role: "viewMenu" },
            { role: "windowMenu" },
            { label: "Help", submenu: [cliMenuItem] },
          ];
    Menu.setApplicationMenu(Menu.buildFromTemplate(template));
  };
  rebuild();
}

async function handleCliMenuAction(
  primaryWindow: BrowserWindow,
  controller: CliIntegrationController,
): Promise<void> {
  const state = controller.getState();
  try {
    if (state.kind === "installed") {
      const confirmation = await dialog.showMessageBox(primaryWindow, {
        type: "question",
        message: "Uninstall the 'gyll' command?",
        detail: `Only the managed command at ${state.targetPath} will be removed. GyShell.app and its bundled CLI remain installed.`,
        buttons: ["Cancel", "Uninstall"],
        defaultId: 0,
        cancelId: 0,
      });
      if (confirmation.response !== 1) return;
      await controller.remove();
      await dialog.showMessageBox(primaryWindow, {
        type: "info",
        message: "The 'gyll' command was uninstalled.",
        detail: state.targetPath,
      });
      return;
    }
    await handleCliInstallAction(primaryWindow, controller);
  } catch (error) {
    await dialog.showMessageBox(primaryWindow, {
      type: "error",
      message: "Unable to manage the 'gyll' command.",
      detail: error instanceof Error ? error.message : String(error),
    });
  }
}

async function handleCliInstallAction(
  primaryWindow: BrowserWindow,
  controller: CliIntegrationController,
): Promise<void> {
  try {
    await controller.install();
    await dialog.showMessageBox(primaryWindow, {
      type: "info",
      message: "The 'gyll' command is ready.",
      detail: controller.successMessage(),
    });
  } catch (error) {
    await dialog.showMessageBox(primaryWindow, {
      type: "error",
      message: "Unable to install the 'gyll' command.",
      detail: error instanceof Error ? error.message : String(error),
    });
  }
}

function scheduleFirstRunPrompt(
  primaryWindow: BrowserWindow,
  controller: CliIntegrationController,
): void {
  const state = controller.getState();
  if (state.kind !== "missing" && state.kind !== "stale-owned") return;
  if (process.platform === "darwin" && !app.isInApplicationsFolder()) return;
  const promptStatePath = path.join(
    app.getPath("userData"),
    CLI_PROMPT_STATE_FILE,
  );
  if (fs.existsSync(promptStatePath)) return;

  primaryWindow.webContents.once("did-finish-load", () => {
    setTimeout(() => {
      void (async () => {
        writePromptState(promptStatePath);
        const response = await dialog.showMessageBox(primaryWindow, {
          type: "question",
          message: "Make the 'gyll' command available to agents?",
          detail:
            "GyShell includes a command-only CLI. Installing the command makes it directly callable from terminals and agent processes without requiring Node.js.",
          buttons: ["Install Command", "Not Now"],
          defaultId: 0,
          cancelId: 1,
        });
        if (response.response !== 0) return;
        await handleCliInstallAction(primaryWindow, controller);
      })().catch((error) => {
        console.warn("[CLI] First-run integration prompt failed:", error);
      });
    }, 500);
  });
}

async function runPrivilegedMacCliAction(
  action: MacCliPrivilegedAction,
): Promise<void> {
  try {
    await execFileAsync(
      "/usr/bin/osascript",
      [
        "-e",
        MAC_PRIVILEGED_LINK_SCRIPT,
        "--",
        action.operation,
        action.sourcePath,
        action.targetPath,
        action.expectedLinkTarget || "",
      ],
      { timeout: 120_000 },
    );
  } catch (error) {
    const stderr =
      typeof error === "object" &&
      error !== null &&
      "stderr" in error &&
      typeof (error as { stderr?: unknown }).stderr === "string"
        ? (error as { stderr: string }).stderr.trim()
        : "";
    throw new Error(
      stderr.includes("User canceled")
        ? "Administrator authorization was canceled."
        : stderr || "macOS could not update /usr/local/bin/gyll.",
    );
  }
}

function isPackageManagedLinuxInstall(): boolean {
  const resourcesPath = path.resolve(process.resourcesPath);
  return (
    resourcesPath.startsWith(`${path.sep}opt${path.sep}GyShell${path.sep}`) &&
    fs.existsSync("/usr/bin/gyll")
  );
}

function readBundledCliMetadata(): {
  sha256?: string;
  appVersion?: string;
} {
  try {
    const metadata = JSON.parse(
      fs.readFileSync(
        path.join(process.resourcesPath, "cli", "metadata.json"),
        "utf8",
      ),
    );
    return {
      sha256:
        typeof metadata.packagingInputSha256 === "string"
          ? metadata.packagingInputSha256
          : undefined,
      appVersion:
        typeof metadata.appVersion === "string"
          ? metadata.appVersion
          : undefined,
    };
  } catch {
    return {};
  }
}

function writePromptState(filePath: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  try {
    fs.writeFileSync(
      filePath,
      `${JSON.stringify({ schemaVersion: 1, shown: true })}\n`,
      { encoding: "utf8", flag: "wx" },
    );
  } catch (error) {
    if (
      typeof error !== "object" ||
      error === null ||
      !("code" in error) ||
      (error as { code?: unknown }).code !== "EEXIST"
    ) {
      throw error;
    }
  }
}

function isRegularFile(filePath: string): boolean {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}
