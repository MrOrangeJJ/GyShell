import { promises as fs } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import path from "node:path";

export interface MacOSFullDiskAccessState {
  supported: boolean;
  granted: boolean;
  shouldPrompt: boolean;
  promptedVersion: string | null;
}

export interface MacOSPermissionPromptStore {
  getSettings(): {
    macosFullDiskAccessPromptedVersion?: string;
    macosFullDiskAccessCheckedInstallation?: string;
  };
  setSettings(settings: {
    macosFullDiskAccessPromptedVersion?: string;
    macosFullDiskAccessCheckedInstallation: string;
  }): void;
}

/**
 * macOS does not expose a public Full Disk Access status API. This probe uses
 * protected, read-only locations as a best-effort signal. The result is only
 * used to decide whether to show the onboarding guidance; TCC remains the
 * authority and may still prompt for a specific path later.
 */
export class MacOSPermissionService {
  private readonly protectedProbePaths: string[];

  constructor(
    private readonly store: MacOSPermissionPromptStore,
    private readonly platform: NodeJS.Platform = process.platform,
    private readonly version: string,
    protectedProbePaths: string[] = [
      path.join(homedir(), "Library", "Mail"),
      path.join(homedir(), "Library", "Safari"),
    ],
    private readonly installationIdentityPaths: string[] = [process.execPath],
  ) {
    this.protectedProbePaths = protectedProbePaths;
  }

  async getFullDiskAccessState(): Promise<MacOSFullDiskAccessState> {
    if (this.platform !== "darwin") {
      return {
        supported: false,
        granted: true,
        shouldPrompt: false,
        promptedVersion: null,
      };
    }

    const granted = await this.probeAccess();
    const installationIdentity = await this.getInstallationIdentity();
    const settings = this.store.getSettings();
    const promptedVersion = this.readPromptedVersion(settings);
    const checkedInstallation = settings.macosFullDiskAccessCheckedInstallation;
    // A replace update can invalidate TCC's grant without changing the app
    // version. The installed executable and app bundle identity distinguish
    // that update from a second launch of the same installation.
    const shouldPrompt =
      !granted && checkedInstallation !== installationIdentity;
    this.store.setSettings({
      ...(shouldPrompt
        ? { macosFullDiskAccessPromptedVersion: this.version }
        : {}),
      macosFullDiskAccessCheckedInstallation: installationIdentity,
    });
    return {
      supported: true,
      granted,
      shouldPrompt,
      promptedVersion,
    };
  }

  private async getInstallationIdentity(): Promise<string> {
    const identity = createHash("sha256").update(this.version);
    for (const filePath of this.installationIdentityPaths) {
      try {
        const stat = await fs.stat(filePath, { bigint: true });
        identity.update(
          `${filePath}\0${stat.dev}\0${stat.ino}\0${stat.size}\0${stat.birthtimeNs}\0${stat.mtimeNs}\0`,
        );
      } catch {
        identity.update(`${filePath}\0missing\0`);
      }
    }
    return identity.digest("hex");
  }

  private readPromptedVersion(settings: {
    macosFullDiskAccessPromptedVersion?: string;
  }): string | null {
    const value = settings.macosFullDiskAccessPromptedVersion;
    return typeof value === "string" && value.trim().length > 0
      ? value.trim()
      : null;
  }

  private async probeAccess(): Promise<boolean> {
    let sawExistingPath = false;
    for (const probePath of this.protectedProbePaths) {
      try {
        await fs.readdir(probePath);
        sawExistingPath = true;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException)?.code;
        if (code === "ENOENT" || code === "ENOTDIR") continue;
        if (code === "EACCES" || code === "EPERM") return false;
        return false;
      }
    }
    return sawExistingPath;
  }
}
