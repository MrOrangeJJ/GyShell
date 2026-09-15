import React from "react";
import { observer } from "mobx-react-lite";
import { AppStore } from "./stores/AppStore";
import { TopBar } from "./components/TopBar/TopBar";
import { SettingsView } from "./components/Settings/SettingsView";
import { ConnectionsView } from "./components/Connections/ConnectionsView";
import { ConfirmDialog } from "./components/Common/ConfirmDialog";
import { LayoutWorkspace } from "./components/Layout/LayoutWorkspace";
import { shouldShowHistoryMigrationOverlay } from "./lib/historyMigrationOverlay";
import "./styles/app.scss";

const store = new AppStore();

export const App: React.FC = observer(() => {
  React.useEffect(() => {
    store.bootstrap();
  }, []);

  React.useEffect(() => {
    let flushed = false;
    const flushLayoutBeforeUnload = () => {
      if (flushed || !store.isBootstrapped || !store.layout.isReady) {
        return;
      }
      flushed = true;
      store.layout.flushPendingSaveSync();
    };

    window.addEventListener("beforeunload", flushLayoutBeforeUnload);
    window.addEventListener("pagehide", flushLayoutBeforeUnload);
    return () => {
      window.removeEventListener("beforeunload", flushLayoutBeforeUnload);
      window.removeEventListener("pagehide", flushLayoutBeforeUnload);
    };
  }, []);

  React.useEffect(() => {
    const canHandleNativeFileDrop = (target: EventTarget | null): boolean => {
      const element = target as HTMLElement | null;
      if (!element || typeof element.closest !== "function") {
        return false;
      }
      return Boolean(
        element.closest(".xterm-host, .filesystem-list, .rich-input-editor"),
      );
    };

    const isNativeFileDrag = (event: DragEvent): boolean => {
      const types = Array.from(event.dataTransfer?.types || []);
      return types.includes("Files");
    };

    const handleDragOver = (event: DragEvent) => {
      if (!isNativeFileDrag(event)) return;
      if (canHandleNativeFileDrop(event.target)) return;
      event.preventDefault();
      if (event.dataTransfer) {
        event.dataTransfer.dropEffect = "none";
      }
    };

    const handleDrop = (event: DragEvent) => {
      if (!isNativeFileDrag(event)) return;
      if (canHandleNativeFileDrop(event.target)) return;
      event.preventDefault();
    };

    window.addEventListener("dragover", handleDragOver, true);
    window.addEventListener("drop", handleDrop, true);
    return () => {
      window.removeEventListener("dragover", handleDragOver, true);
      window.removeEventListener("drop", handleDrop, true);
    };
  }, []);

  const platform = (window as any)?.gyshell?.system?.platform;
  const t = store.i18n.t;
  const versionInfo = store.versionInfo;
  const historyMigrationState = store.historyMigrationState;
  const showHistoryMigrationOverlay =
    shouldShowHistoryMigrationOverlay(historyMigrationState);
  const migrationPercent = Math.max(
    0,
    Math.min(100, historyMigrationState?.percent ?? 0),
  );
  const hasVersionDifference =
    !!versionInfo &&
    versionInfo.status !== "error" &&
    typeof versionInfo.latestVersion === "string" &&
    versionInfo.latestVersion.length > 0 &&
    versionInfo.latestVersion !== versionInfo.currentVersion;
  const platformClass =
    platform === "win32"
      ? "platform-windows"
      : platform === "darwin"
        ? "platform-darwin"
        : platform === "linux"
          ? "platform-linux"
          : navigator.userAgent.toLowerCase().includes("windows")
            ? "platform-windows"
            : "platform-darwin";

  return (
    <div className={`gyshell ${platformClass}`}>
      <ConfirmDialog
        open={store.showVersionUpdateDialog && hasVersionDifference}
        title={t.settings.versionUpdateTitle}
        message={`${
          versionInfo?.status === "update-available"
            ? t.settings.versionUpdateMessage(
                versionInfo?.currentVersion || "-",
                versionInfo?.latestVersion || "-",
              )
            : t.settings.versionDifferentMessage(
                versionInfo?.currentVersion || "-",
                versionInfo?.latestVersion || "-",
              )
        }\n\n${t.settings.versionCheckNote}`}
        confirmText={t.settings.goToDownload}
        cancelText={t.common.close}
        onCancel={() => store.closeVersionUpdateDialog()}
        onConfirm={() => {
          void store.openVersionDownload();
          store.closeVersionUpdateDialog();
        }}
      />

      <ConfirmDialog
        open={store.showMacOSFullDiskAccessPrompt}
        title={t.settings.macOSFullDiskAccessTitle}
        message={t.settings.macOSFullDiskAccessMessage}
        confirmText={t.settings.openFullDiskAccessSettings}
        cancelText={t.settings.skipFullDiskAccess}
        onCancel={() => store.closeMacOSFullDiskAccessPrompt()}
        onConfirm={() => {
          void store.openMacOSFullDiskAccessSettings();
        }}
      />

      <TopBar store={store} />

      <div className="gyshell-body">
        <div className="gyshell-main">
          <LayoutWorkspace store={store} />
        </div>

        {/* Settings is an overlay so we don't unmount terminals (xterm state stays alive) */}
        <div
          className={`gyshell-overlay settings-overlay${store.view === "settings" ? " is-open" : ""}`}
        >
          <SettingsView store={store} />
        </div>

        <div
          className={`gyshell-overlay connections-overlay${store.view === "connections" ? " is-open" : ""}`}
        >
          <ConnectionsView store={store} />
        </div>

        {showHistoryMigrationOverlay ? (
          <div className="gyshell-startup-overlay">
            <div className="gyshell-startup-modal">
              <p className="gyshell-startup-kicker">System Notice</p>
              <h2>
                {historyMigrationState?.title || "Preparing history storage"}
              </h2>
              <p>
                {historyMigrationState?.message ||
                  "Checking stored conversations."}
              </p>
              <div
                className="gyshell-startup-progress-track"
                aria-hidden="true"
              >
                <div
                  className="gyshell-startup-progress-fill"
                  style={{ width: `${migrationPercent}%` }}
                />
              </div>
              <div className="gyshell-startup-progress-meta">
                <span>{migrationPercent}%</span>
                <span>
                  {historyMigrationState?.completedUnits || 0}/
                  {historyMigrationState?.totalUnits || 0}
                </span>
              </div>
              {historyMigrationState?.error ? (
                <pre className="gyshell-startup-error">
                  {historyMigrationState.error}
                </pre>
              ) : null}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
});
