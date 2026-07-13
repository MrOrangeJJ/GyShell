import React from "react";
import { RefreshCw } from "lucide-react";
import { useMobileI18n } from "../../i18n/provider";
import type { BuiltInToolSummary, McpServerSummary } from "../../types";

interface ToolsPanelProps {
  mcpTools: McpServerSummary[];
  builtInTools: BuiltInToolSummary[];
  connectionStatus: "connecting" | "connected" | "disconnected";
  onReload: () => Promise<void>;
  onSetMcpEnabled: (name: string, enabled: boolean) => Promise<void>;
  onSetBuiltInEnabled: (
    name: string,
    enabled: boolean,
    acknowledgedExperimentalToolNames?: string[],
  ) => Promise<void>;
}

export const ToolsPanel: React.FC<ToolsPanelProps> = ({
  mcpTools,
  builtInTools,
  connectionStatus,
  onReload,
  onSetMcpEnabled,
  onSetBuiltInEnabled,
}) => {
  const { t } = useMobileI18n();
  const [reloading, setReloading] = React.useState(false);
  const [pendingBuiltInToolName, setPendingBuiltInToolName] =
    React.useState<string | null>(null);
  const canMutate = connectionStatus === "connected";
  const enabledMcpCount = mcpTools.filter((item) => item.enabled).length;
  const enabledBuiltInCount = builtInTools.filter(
    (item) => item.enabled,
  ).length;

  const formatMcpStatus = React.useCallback(
    (status: McpServerSummary["status"]): string => {
      if (status === "connected") return t.tools.status.connected;
      if (status === "connecting") return t.tools.status.connecting;
      if (status === "error") return t.tools.status.error;
      return t.tools.status.disabled;
    },
    [t.tools.status],
  );

  const handleReload = React.useCallback(async () => {
    setReloading(true);
    try {
      await onReload();
    } finally {
      setReloading(false);
    }
  }, [onReload]);

  const handleBuiltInToggle = React.useCallback(
    async (tool: BuiltInToolSummary) => {
      const nextEnabled = !tool.enabled;
      if (
        nextEnabled &&
        tool.experimental === true &&
        !window.confirm(t.tools.experimentalEnableWarning(tool.name))
      ) {
        return;
      }
      setPendingBuiltInToolName(tool.name);
      try {
        await onSetBuiltInEnabled(
          tool.name,
          nextEnabled,
          nextEnabled && tool.experimental === true ? [tool.name] : [],
        );
      } finally {
        setPendingBuiltInToolName(null);
      }
    },
    [onSetBuiltInEnabled, t.tools],
  );

  return (
    <section className="panel-scroll tools-panel">
      <div className="panel-toolbar">
        <p className="panel-toolbar-meta">
          {t.tools.summary(
            enabledMcpCount,
            mcpTools.length,
            enabledBuiltInCount,
            builtInTools.length,
          )}
        </p>
      </div>

      <div className="skill-source-group">
        <header className="skill-source-head">
          <h3>{t.tools.mcpServers}</h3>
        </header>
        {mcpTools.length === 0 ? (
          <p className="panel-empty">{t.tools.mcpEmpty}</p>
        ) : (
          <div className="skill-list">
            {mcpTools.map((tool) => {
              const isEnabled = tool.enabled;
              return (
                <article key={tool.name} className="skill-item">
                  <div className="skill-item-body tools-item-body">
                    <h3>{tool.name}</h3>
                    <p>
                      {formatMcpStatus(tool.status)}
                      {typeof tool.toolCount === "number"
                        ? ` • ${t.tools.toolCount(tool.toolCount)}`
                        : ""}
                    </p>
                    {tool.error ? (
                      <p className="tool-error-text">{tool.error}</p>
                    ) : null}
                  </div>
                  <button
                    type="button"
                    className={`skill-toggle ${isEnabled ? "enabled" : ""}`}
                    disabled={!canMutate}
                    onClick={() => void onSetMcpEnabled(tool.name, !isEnabled)}
                  >
                    {isEnabled ? t.common.on : t.common.off}
                  </button>
                </article>
              );
            })}
          </div>
        )}
      </div>

      <div className="skill-source-group">
        <header className="skill-source-head">
          <h3>{t.tools.builtInTools}</h3>
        </header>
        {builtInTools.length === 0 ? (
          <p className="panel-empty">{t.tools.builtInEmpty}</p>
        ) : (
          <div className="skill-list">
            {builtInTools.map((tool) => {
              const isEnabled = tool.enabled;
              return (
                <article key={tool.name} className="skill-item">
                  <div className="skill-item-body tools-item-body">
                    <h3>
                      {tool.name}
                      {tool.experimental
                        ? ` • ${t.tools.experimentalLabel}`
                        : ""}
                    </h3>
                    <p>{tool.description || t.tools.noDescription}</p>
                  </div>
                  <button
                    type="button"
                    className={`skill-toggle ${isEnabled ? "enabled" : ""}`}
                    disabled={!canMutate || pendingBuiltInToolName !== null}
                    onClick={() =>
                      void handleBuiltInToggle(tool)
                    }
                  >
                    {isEnabled ? t.common.on : t.common.off}
                  </button>
                </article>
              );
            })}
          </div>
        )}
      </div>

      <div className="panel-action-dock">
        <button
          type="button"
          className="panel-icon-btn panel-action-btn"
          disabled={!canMutate || reloading}
          onClick={() => void handleReload()}
          aria-label={t.tools.reload}
          title={t.tools.reload}
        >
          <RefreshCw size={18} className={reloading ? "spin" : ""} />
        </button>
      </div>
    </section>
  );
};
