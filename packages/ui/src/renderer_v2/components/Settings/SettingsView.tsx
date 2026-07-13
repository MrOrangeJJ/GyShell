import React, { useMemo, useState } from "react";
import { createPortal } from "react-dom";
import {
  ArrowLeft,
  Cpu,
  Palette,
  Settings,
  Plus,
  Trash2,
  X,
  Key,
  Globe,
  Box,
  Tag,
  Shield,
  Loader2,
  Wrench,
  RefreshCw,
  BookOpenText,
  Pencil,
  Info,
  AlertTriangle,
  Database,
  GitBranch,
} from "lucide-react";
import { observer } from "mobx-react-lite";
import type { AppStore } from "../../stores/AppStore";
import type { ModelDefinition } from "../../lib/ipcTypes";
import { BUILTIN_THEMES } from "../../theme/themes";
import type { AppTheme } from "../../theme/themes";
import "./settings.scss";
import { ConfirmDialog } from "../Common/ConfirmDialog";
import { NumericInput } from "../Common/NumericInput";
import { InfoTooltip } from "../Common/InfoTooltip";
import { Select } from "../../platform/Select";
import { ShortcutRecorder } from "./ShortcutRecorder";
import { getDefaultCommandDraftShortcut } from "../../lib/commandDraftShortcut";
import { AgentSettingRailControls } from "./AgentSettingRailControls";

function ThemeTile(props: {
  active?: boolean;
  theme: AppTheme;
  onClick: () => void;
}) {
  const { background, foreground, colors } = props.theme.terminal;
  const previewColors = [foreground, colors[1], colors[2]];
  const displayName =
    props.theme.name.length > 13
      ? `${props.theme.name.slice(0, 13)}...`
      : props.theme.name;
  return (
    <button
      className={props.active ? "theme-tile is-active" : "theme-tile"}
      onClick={props.onClick}
      title={props.theme.name}
    >
      <div className="theme-preview" style={{ background }}>
        <div className="theme-preview-swatches">
          {previewColors.map((color, idx) => (
            <span
              key={`${props.theme.id}-swatch-${idx}`}
              style={{ background: color }}
            />
          ))}
        </div>
      </div>
      <div className="theme-tile-content">
        <span className="theme-tile-title">{displayName}</span>
      </div>
    </button>
  );
}

const RULES_PREVIEW_LIMIT = 28;
const TAG_WIDTH_CHAR_PX = 7;
const TAG_WIDTH_PADDING_PX = 10;
const TAG_WIDTH_BORDER_PX = 2;

function computeTagColumnWidth(labels: readonly string[]): string {
  const longestLabelLength = labels.reduce(
    (max, label) => Math.max(max, label.length),
    0,
  );
  const widthPx =
    longestLabelLength * TAG_WIDTH_CHAR_PX +
    TAG_WIDTH_PADDING_PX +
    TAG_WIDTH_BORDER_PX;
  return `${Math.ceil(widthPx)}px`;
}

function RuleChipList(props: {
  t: any;
  rules: string[];
  onDelete: (rule: string) => void;
}) {
  const { t, rules, onDelete } = props;
  const [expanded, setExpanded] = useState(false);
  const visible = expanded ? rules : rules.slice(0, RULES_PREVIEW_LIMIT);
  const remaining = Math.max(0, rules.length - visible.length);

  return (
    <div className="cp-rule-block">
      <div className="cp-chips" role="list">
        {visible.map((rule) => (
          <div
            key={rule}
            className="cp-chip"
            role="listitem"
            data-full={rule}
            aria-label={rule}
          >
            <span className="cp-chip-text">{rule}</span>
            <button
              className="cp-chip-delete"
              title={t.common.delete}
              onClick={() => onDelete(rule)}
            >
              <Trash2 size={12} />
            </button>
          </div>
        ))}
        {rules.length === 0 ? (
          <div className="tool-empty">{t.settings.noCommandPolicyRules}</div>
        ) : null}
      </div>
      {rules.length > RULES_PREVIEW_LIMIT ? (
        <button className="cp-expand" onClick={() => setExpanded(!expanded)}>
          {expanded
            ? t.common.showLess
            : `${t.common.showMore} (+${remaining})`}
        </button>
      ) : null}
    </div>
  );
}

const ModelEditor = observer(
  ({
    store,
    modelId,
    onClose,
  }: {
    store: AppStore;
    modelId?: string;
    onClose: () => void;
  }) => {
    const t = store.i18n.t;
    const existing = store.settings?.models.items.find((m) => m.id === modelId);
    
    const [draft, setDraft] = useState<ModelDefinition>(() => {
        if (existing) {
            return {
                ...existing,
                structuredOutputMode:
            existing.structuredOutputMode === "on" ||
            existing.structuredOutputMode === "off"
                    ? existing.structuredOutputMode
              : "auto",
          maxTokens:
            typeof existing.maxTokens === "number"
              ? existing.maxTokens
              : 200000,
        };
        }
        return {
            id: `model-${Date.now()}`,
        name: "",
        model: "",
        baseUrl: "",
        apiKey: "",
            maxTokens: 200000,
        structuredOutputMode: "auto",
            supportsStructuredOutput: false,
        supportsObjectToolChoice: false,
      };
    });
    const [isSaving, setIsSaving] = useState(false);

    const save = async () => {
      setIsSaving(true);
        try {
        await store.saveModel(draft);
        onClose();
        } finally {
        setIsSaving(false);
    }
    };

    return (
        <div className="model-editor-overlay">
            <div className="model-editor-card">
                <div className="editor-header">
                    <h3>{modelId ? t.settings.editModel : t.settings.addModel}</h3>
            <button
              className="icon-btn-sm"
              onClick={onClose}
              disabled={isSaving}
            >
              <X size={16} />
            </button>
                </div>
                <div className="editor-body">
                    {/* SSH-style compact rows: icon + input (no separate label) */}
                    <div className="editor-row">
                      <span className="editor-icon">
                        <Tag size={16} strokeWidth={2} />
                      </span>
                      <input
                        className="editor-input"
                        placeholder={t.common.name}
                        value={draft.name}
                        onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                        disabled={isSaving}
                      />
                    </div>
                    <div className="editor-row">
                      <span className="editor-icon">
                        <Box size={16} strokeWidth={2} />
                      </span>
                      <input
                        className="editor-input"
                        placeholder={t.settings.providerModel}
                        value={draft.model}
                        onChange={(e) => setDraft({ ...draft, model: e.target.value })}
                        disabled={isSaving}
                      />
                    </div>
                    <div className="editor-row">
                      <span className="editor-icon">
                        <Globe size={16} strokeWidth={2} />
                      </span>
                      <input
                        className="editor-input"
                        placeholder={`${t.settings.baseUrl} (${t.common.edit})`}
                value={draft.baseUrl || ""}
                onChange={(e) =>
                  setDraft({ ...draft, baseUrl: e.target.value })
                }
                        disabled={isSaving}
                      />
                    </div>
                    <div className="editor-row">
                      <span className="editor-icon">
                        <Key size={16} strokeWidth={2} />
                      </span>
                      <input
                        type="password"
                        className="editor-input"
                        placeholder={`${t.settings.apiKey} (${t.common.edit})`}
                value={draft.apiKey || ""}
                        onChange={(e) => setDraft({ ...draft, apiKey: e.target.value })}
                        disabled={isSaving}
                      />
                    </div>
                    <div className="editor-row">
                      <span className="editor-icon">
                        <Loader2 size={16} strokeWidth={2} />
                      </span>
                      <NumericInput
                        className="editor-input"
                        placeholder={t.settings.maxTokensPlaceholder}
                        value={draft.maxTokens}
                        onChange={(val) => setDraft({ ...draft, maxTokens: val })}
                        disabled={isSaving}
                        min={0}
                      />
                    </div>
                    <div className="editor-row editor-row-toggle">
                      <span className="editor-icon">
                        <Shield size={16} strokeWidth={2} />
                      </span>
              <span className="editor-toggle-label">
                {t.settings.supportStructuredOutput}
              </span>
              <div
                className="tri-switch"
                role="group"
                aria-label={t.settings.supportStructuredOutput}
              >
                {(["auto", "on", "off"] as const).map((mode) => {
                  const active =
                    (draft.structuredOutputMode || "auto") === mode;
                  const label =
                    mode === "auto" ? "Auto" : mode === "on" ? "On" : "Off";
                          return (
                            <button
                              key={mode}
                              type="button"
                      className={
                        active ? "tri-switch-btn is-active" : "tri-switch-btn"
                      }
                      onClick={() =>
                        setDraft({ ...draft, structuredOutputMode: mode })
                      }
                              disabled={isSaving}
                            >
                              {label}
                            </button>
                  );
                        })}
                      </div>
                    </div>
                </div>
                <div className="editor-footer">
            <button
              className="btn-secondary"
              onClick={onClose}
              disabled={isSaving}
            >
              {t.common.cancel}
            </button>
            <button
              className="btn-primary"
              onClick={save}
              disabled={!draft.name || !draft.model || isSaving}
            >
              {isSaving ? (
                <Loader2 size={16} className="spin" />
              ) : (
                t.common.save
              )}
                    </button>
                </div>
            </div>
        </div>
    );
  },
);

function AccessTokenRevealDialog(props: {
  open: boolean;
  title: string;
  token: string;
  hint: string;
  copyText: string;
  closeText: string;
  copyError: string;
  onCopy: () => void;
  onClose: () => void;
}): React.ReactElement | null {
  if (!props.open) return null;

  return createPortal(
    <div
      className="gy-confirm-overlay"
      role="dialog"
      aria-modal="true"
      onClick={props.onClose}
    >
      <div
        className="gy-confirm-card access-token-reveal-dialog"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="gy-confirm-header">
          <div className="gy-confirm-title">{props.title}</div>
          <button
            className="icon-btn-sm"
            onClick={props.onClose}
            title={props.closeText}
          >
            <X size={18} />
          </button>
        </div>

        <div className="gy-confirm-body access-token-reveal-body">
          <pre className="access-token-created-value">{props.token}</pre>
          <div className="gy-confirm-message access-token-reveal-hint">
            {props.hint}
          </div>
          {props.copyError ? (
            <div className="settings-error access-token-reveal-error">
              {props.copyError}
            </div>
          ) : null}
        </div>

        <div className="gy-confirm-footer">
          <button className="gy-btn gy-btn-secondary" onClick={props.onClose}>
            {props.closeText}
          </button>
          <button className="gy-btn gy-btn-primary" onClick={props.onCopy}>
            {props.copyText}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

export const SettingsView: React.FC<{ store: AppStore }> = observer(
  ({ store }) => {
    const t = store.i18n.t;
    const [editingModelId, setEditingModelId] = useState<string | null>(null);
    const [showModelEditor, setShowModelEditor] = useState(false);
  const modelMetaColumnVars = useMemo(
    () =>
      ({
          "--model-meta-col-status": computeTagColumnWidth([
            "Active",
            "Stateless",
            "NoActive",
          ]),
          "--model-meta-col-image": computeTagColumnWidth(["Image"]),
          "--model-meta-col-structured": computeTagColumnWidth(["Structured"]),
      }) as React.CSSProperties,
      [],
    );

    const [cpDraft, setCpDraft] = useState<{
      allowlist: string;
      denylist: string;
      asklist: string;
    }>({
      allowlist: "",
      denylist: "",
      asklist: "",
    });
    const [accessTokenName, setAccessTokenName] = useState("");
    const [accessTokenError, setAccessTokenError] = useState("");
    const [accessTokenBusy, setAccessTokenBusy] = useState(false);
    const [createdAccessToken, setCreatedAccessToken] = useState<string | null>(
      null,
    );
    const [accessTokenModalError, setAccessTokenModalError] = useState("");
    const [deleteAccessTokenConfirm, setDeleteAccessTokenConfirm] =
      useState<null | { id: string; name: string }>(null);
    const [experimentalToolEnableConfirm, setExperimentalToolEnableConfirm] =
      useState<null | { name: string }>(null);
    const [experimentalToolEnableBusy, setExperimentalToolEnableBusy] =
      useState(false);
    const [showMobileWebGatewayWarning, setShowMobileWebGatewayWarning] =
      useState(false);

    const cpLists = useMemo(
      () => store.commandPolicyLists,
      [store.commandPolicyLists],
    );
    const isMobileWebRunning = store.mobileWebStatus.running;
    const persistedWsGatewayAccess =
      store.settings?.gateway?.ws?.access ?? "localhost";
    const persistedWsGatewayCidrs = (
      store.settings?.gateway?.ws?.allowedCidrs || []
    ).join("\n");
    const [wsGatewayAccessDraft, setWsGatewayAccessDraft] = useState(
      persistedWsGatewayAccess,
    );
    const [wsGatewayCidrsDraft, setWsGatewayCidrsDraft] = useState(
      persistedWsGatewayCidrs,
    );
    const versionInfo = store.versionInfo;
    const builtInTools = useMemo(
      () => store.builtInTools.filter((tool) => tool.experimental !== true),
      [store.builtInTools],
    );
    const experimentalBuiltInTools = useMemo(
      () => store.builtInTools.filter((tool) => tool.experimental === true),
      [store.builtInTools],
    );
    const enableExperimentalTool = async () => {
      const tool = experimentalToolEnableConfirm;
      if (!tool || experimentalToolEnableBusy) return;
      setExperimentalToolEnableBusy(true);
      try {
        await store.setBuiltInToolEnabled(tool.name, true, [tool.name]);
        setExperimentalToolEnableConfirm(null);
      } catch (error) {
        console.error("Failed to enable experimental tool", error);
      } finally {
        setExperimentalToolEnableBusy(false);
      }
    };
  const formattedCheckedAt =
    versionInfo?.checkedAt && versionInfo.checkedAt > 0
      ? new Date(versionInfo.checkedAt).toLocaleString()
        : "-";

  const openModelEditor = (id?: string) => {
      setEditingModelId(id || null);
      setShowModelEditor(true);
    };

    const [deleteConfirm, setDeleteConfirm] = useState<null | {
      kind: "model" | "profile";
      id: string;
    }>(null);
    const [deleteSkillConfirm, setDeleteSkillConfirm] = useState<null | {
      fileName: string;
    }>(null);
    const [memoryDraft, setMemoryDraft] = useState("");
    const [memoryBusy, setMemoryBusy] = useState(false);

    React.useEffect(() => {
      if (store.settingsSection !== "memory") return;
      void store.loadMemory();
    }, [store, store.settingsSection]);

  React.useEffect(() => {
      setWsGatewayAccessDraft(persistedWsGatewayAccess);
    }, [persistedWsGatewayAccess]);

  React.useEffect(() => {
      setWsGatewayCidrsDraft(persistedWsGatewayCidrs);
    }, [persistedWsGatewayCidrs]);

    React.useEffect(() => {
      setMemoryDraft(store.memoryContent);
    }, [store.memoryContent]);

  const createAccessToken = async () => {
      const normalizedName = accessTokenName.trim();
    if (!normalizedName) {
        setAccessTokenError(t.settings.accessTokenNameRequired);
        return;
    }

      setAccessTokenBusy(true);
      setAccessTokenError("");
      setAccessTokenModalError("");
    try {
        const created = await store.createAccessToken(normalizedName);
        setCreatedAccessToken(created.token);
        setAccessTokenName("");
    } catch (error) {
        setAccessTokenError(
          error instanceof Error ? error.message : String(error),
        );
    } finally {
        setAccessTokenBusy(false);
  }
    };

  const copyCreatedAccessToken = async () => {
      if (!createdAccessToken) return;
    try {
        await navigator.clipboard.writeText(createdAccessToken);
        setAccessTokenModalError("");
    } catch {
        setAccessTokenModalError(t.settings.accessTokenCopyFailed);
  }
    };

  const closeCreatedAccessTokenDialog = () => {
      setCreatedAccessToken(null);
      setAccessTokenModalError("");
    };

  const saveMemory = async () => {
      setMemoryBusy(true);
    try {
        const snapshot = await store.saveMemoryContent(memoryDraft);
      if (snapshot) {
          setMemoryDraft(snapshot.content);
      }
    } finally {
        setMemoryBusy(false);
  }
    };

  const reloadMemory = async () => {
      setMemoryBusy(true);
    try {
        const snapshot = await store.loadMemory();
      if (snapshot) {
          setMemoryDraft(snapshot.content);
      }
    } finally {
        setMemoryBusy(false);
  }
    };

  const renderNavItem = (
    section: AppStore["settingsSection"],
    icon: React.ReactNode,
    label: string,
  ) => (
    <div
      className={
        store.settingsSection === section
          ? "settings-nav-item is-active"
          : "settings-nav-item"
      }
      onClick={() => store.setSettingsSection(section)}
      role="button"
      tabIndex={0}
    >
      <span className="icon">{icon}</span>
      <span>{label}</span>
    </div>
  );

  return (
    <div className="settings">
      <AccessTokenRevealDialog
        open={!!createdAccessToken}
        title={t.settings.accessTokenCreatedTitle}
          token={createdAccessToken || ""}
        hint={t.settings.accessTokenCreatedHint}
        copyText={t.settings.copyAccessToken}
        closeText={t.common.close}
        copyError={accessTokenModalError}
        onCopy={() => {
            void copyCreatedAccessToken();
        }}
        onClose={closeCreatedAccessTokenDialog}
      />
      <ConfirmDialog
        open={!!deleteConfirm}
        title={t.common.confirmDeleteTitle}
          message={
            deleteConfirm?.kind === "profile"
              ? t.common.confirmDeleteProfile
              : t.common.confirmDeleteModel
          }
        confirmText={t.common.delete}
        cancelText={t.common.cancel}
        danger
        onCancel={() => setDeleteConfirm(null)}
        onConfirm={() => {
            if (!deleteConfirm) return;
            if (deleteConfirm.kind === "model")
              void store.deleteModel(deleteConfirm.id);
            else void store.deleteProfile(deleteConfirm.id);
            setDeleteConfirm(null);
        }}
      />
      <ConfirmDialog
        open={!!deleteSkillConfirm}
        title={t.common.confirmDeleteTitle}
        message={t.common.confirmDeleteConfig}
        confirmText={t.common.delete}
        cancelText={t.common.cancel}
        danger
        onCancel={() => setDeleteSkillConfirm(null)}
        onConfirm={() => {
            if (!deleteSkillConfirm) return;
            void store.deleteSkill(deleteSkillConfirm.fileName);
            setDeleteSkillConfirm(null);
        }}
      />
      <ConfirmDialog
        open={!!deleteAccessTokenConfirm}
        title={t.common.confirmDeleteTitle}
          message={t.settings.confirmDeleteAccessToken(
            deleteAccessTokenConfirm?.name || "",
          )}
        confirmText={t.common.delete}
        cancelText={t.common.cancel}
        danger
        onCancel={() => setDeleteAccessTokenConfirm(null)}
        onConfirm={() => {
            if (!deleteAccessTokenConfirm) return;
            void store.deleteAccessToken(deleteAccessTokenConfirm.id);
            setDeleteAccessTokenConfirm(null);
        }}
      />
      <ConfirmDialog
        open={!!experimentalToolEnableConfirm}
        title={t.settings.experimentalToolEnableTitle}
        message={t.settings.experimentalToolEnableMessage(
          experimentalToolEnableConfirm?.name || "",
        )}
        confirmText={t.settings.experimentalToolEnableConfirm}
        cancelText={t.common.cancel}
        danger
        loading={experimentalToolEnableBusy}
        onCancel={() => setExperimentalToolEnableConfirm(null)}
        onConfirm={() => {
          void enableExperimentalTool();
        }}
      />
        <ConfirmDialog
          open={showMobileWebGatewayWarning}
          title={t.settings.mobileWebGatewayWarningTitle}
          message={t.settings.mobileWebGatewayWarning}
          confirmText={t.common.ok}
          cancelText={t.common.cancel}
          onConfirm={() => setShowMobileWebGatewayWarning(false)}
          onCancel={() => setShowMobileWebGatewayWarning(false)}
        />

      {showModelEditor && (
          <ModelEditor 
            store={store} 
            modelId={editingModelId || undefined} 
            onClose={() => setShowModelEditor(false)} 
          />
      )}
      
      <div className="settings-sidebar">
          <button
            className="settings-back-btn"
            onClick={() => store.closeOverlay()}
            title={t.common.back}
          >
          <ArrowLeft size={16} strokeWidth={2} />
        </button>
        
        <div className="settings-nav">
          {renderNavItem(
            "general",
            <Settings size={16} strokeWidth={2} />,
            t.settings.general,
          )}
          {renderNavItem(
            "theme",
            <Palette size={16} strokeWidth={2} />,
            t.settings.theme,
          )}
          {renderNavItem(
            "accessTokens",
            <Key size={16} strokeWidth={2} />,
            t.settings.accessTokens,
          )}
          {renderNavItem(
            "version",
            <Info size={16} strokeWidth={2} />,
            t.settings.version,
          )}
          <div className="settings-nav-agent-divider">
            <span>{t.settings.agentSetting}</span>
            <i />
          </div>
          <div className="settings-nav-agent-group">
            {renderNavItem(
              "security",
              <Shield size={16} strokeWidth={2} />,
              t.settings.security,
            )}
            {renderNavItem(
              "tools",
              <Wrench size={16} strokeWidth={2} />,
              t.settings.tools,
            )}
            {renderNavItem(
              "skills",
              <BookOpenText size={16} strokeWidth={2} />,
              t.settings.skills,
            )}
            {renderNavItem(
              "memory",
              <Database size={16} strokeWidth={2} />,
              t.settings.memory,
            )}
            {renderNavItem(
              "workflow",
              <GitBranch size={16} strokeWidth={2} />,
              t.settings.workflow,
            )}
            {renderNavItem(
              "models",
              <Cpu size={16} strokeWidth={2} />,
              t.settings.model,
            )}
            <AgentSettingRailControls store={store} />
          </div>
        </div>
      </div>
      <div className="settings-content">
        <div className="settings-section">
            {store.settingsSection === "general" ? (
            <>
              <div className="settings-section-header">
                <div className="settings-section-title">
                  {t.settings.general}
                </div>
              </div>
              <div className="settings-rows">
                <div className="settings-row">
                  <div className="settings-row-label-with-info">
                    <label>{t.settings.language}</label>
                    <InfoTooltip content={t.settings.tooltips.language} />
                  </div>
                  <Select
                    className="settings-native-select"
                    value={store.i18n.locale}
                    onChange={(v) => store.setLanguage(v as any)}
                    options={[
                        { value: "en", label: "English" },
                        { value: "zh-CN", label: "简体中文" },
                    ]}
                  />
                </div>
                <div className="settings-row">
                  <div className="settings-row-label-with-info">
                    <label>{t.settings.tabDisplayMode}</label>
                    <InfoTooltip content={t.settings.tooltips.tabDisplayMode} />
                  </div>
                  <Select
                    className="settings-native-select"
                    value={store.panelTabDisplayMode}
                    onChange={(value) =>
                      store.setPanelTabDisplayMode(
                        value as AppStore["panelTabDisplayMode"],
                      )
                    }
                    options={[
                      {
                        value: "auto",
                        label: t.settings.tabDisplayModes.auto,
                      },
                      {
                        value: "expanded",
                        label: t.settings.tabDisplayModes.expanded,
                      },
                      {
                        value: "select",
                        label: t.settings.tabDisplayModes.select,
                      },
                    ]}
                  />
                </div>
                <div className="settings-row">
                  <div className="settings-row-label-with-info">
                    <label>{t.settings.debugMode}</label>
                    <InfoTooltip content={t.settings.tooltips.debugMode} />
                  </div>
                  <label className="switch">
                    <input
                      type="checkbox"
                      checked={store.settings?.debugMode ?? false}
                      onChange={(e) => store.setDebugMode(e.target.checked)}
                    />
                    <span className="switch-slider" />
                  </label>
                </div>
                <div className="settings-row">
                  <div className="settings-row-label-with-info">
                    <label>{t.settings.chatDisplayMode}</label>
                    <InfoTooltip content={t.settings.tooltips.chatDisplayMode} />
                  </div>
                  <Select
                    className="settings-native-select"
                    value={store.chatDisplayMode}
                    onChange={(value) =>
                      store.setChatDisplayMode(value as 'classic' | 'seamless')
                    }
                    options={[
                      {
                        value: 'classic',
                        label: t.settings.chatDisplayModes.classic,
                      },
                      {
                        value: 'seamless',
                        label: t.settings.chatDisplayModes.seamless,
                      },
                    ]}
                  />
                </div>
                <div className="settings-row">
                  <div className="settings-row-label-with-info">
                    <label>{t.settings.preventSleepWhileRunning}</label>
                    <InfoTooltip
                      content={t.settings.tooltips.preventSleepWhileRunning}
                    />
                  </div>
                  <label className="switch">
                    <input
                      type="checkbox"
                      checked={store.preventSleepWhileRunning}
                      onChange={(e) =>
                        store.setPreventSleepWhileRunning(e.target.checked)
                      }
                    />
                    <span className="switch-slider" />
                  </label>
                </div>
              </div>

                <div
                  className="settings-section-header"
                  style={{ marginTop: 24 }}
                >
                <div className="settings-section-title">
                  {t.settings.terminal}
                </div>
              </div>
              <div className="settings-rows">
                <div className="settings-row">
                  <div className="settings-row-label-with-info">
                    <label>{t.settings.fontSize}</label>
                    <InfoTooltip content={t.settings.tooltips.fontSize} />
                  </div>
                  <NumericInput
                    className="settings-inline-input"
                    style={{ width: 80 }}
                    value={store.settings?.terminal?.fontSize || 14}
                      onChange={(val) =>
                        store.setTerminalSettings({ fontSize: val })
                      }
                    min={6}
                    max={100}
                  />
                </div>
                <div className="settings-row">
                  <div className="settings-row-label-with-info">
                    <label>{t.settings.lineHeight}</label>
                    <InfoTooltip content={t.settings.tooltips.lineHeight} />
                  </div>
                  <NumericInput
                    className="settings-inline-input"
                    style={{ width: 80 }}
                    value={store.settings?.terminal?.lineHeight || 1.2}
                      onChange={(val) =>
                        store.setTerminalSettings({ lineHeight: val })
                      }
                    allowFloat
                    min={1}
                    max={5}
                  />
                </div>
                <div className="settings-row">
                  <div className="settings-row-label-with-info">
                    <label>{t.settings.scrollback}</label>
                    <InfoTooltip content={t.settings.tooltips.scrollback} />
                  </div>
                  <NumericInput
                    className="settings-inline-input"
                    style={{ width: 80 }}
                    value={store.settings?.terminal?.scrollback || 5000}
                      onChange={(val) =>
                        store.setTerminalSettings({ scrollback: val })
                      }
                    min={0}
                    max={1000000}
                  />
                </div>
                <div className="settings-row">
                  <div className="settings-row-label-with-info">
                    <label>{t.settings.cursorStyle}</label>
                    <InfoTooltip content={t.settings.tooltips.cursorStyle} />
                  </div>
                  <Select
                    className="settings-native-select"
                      value={store.settings?.terminal?.cursorStyle || "block"}
                      onChange={(v) =>
                        store.setTerminalSettings({ cursorStyle: v as any })
                      }
                    options={[
                        {
                          value: "block",
                          label: t.settings.cursorStyles.block,
                        },
                        {
                          value: "underline",
                          label: t.settings.cursorStyles.underline,
                        },
                        { value: "bar", label: t.settings.cursorStyles.bar },
                    ]}
                  />
                </div>
                <div className="settings-row">
                  <div className="settings-row-label-with-info">
                    <label>{t.settings.cursorBlink}</label>
                    <InfoTooltip content={t.settings.tooltips.cursorBlink} />
                  </div>
                  <label className="switch">
                    <input
                      type="checkbox"
                      checked={store.settings?.terminal?.cursorBlink ?? true}
                        onChange={(e) =>
                          store.setTerminalSettings({
                            cursorBlink: e.target.checked,
                          })
                        }
                    />
                    <span className="switch-slider" />
                  </label>
                </div>
                <div className="settings-row">
                  <div className="settings-row-label-with-info">
                    <label>{t.settings.copyOnSelect}</label>
                    <InfoTooltip content={t.settings.tooltips.copyOnSelect} />
                  </div>
                  <label className="switch">
                    <input
                      type="checkbox"
                        checked={
                          store.settings?.terminal?.copyOnSelect ?? false
                        }
                        onChange={(e) =>
                          store.setTerminalSettings({
                            copyOnSelect: e.target.checked,
                          })
                        }
                    />
                    <span className="switch-slider" />
                  </label>
                </div>
                <div className="settings-row">
                  <div className="settings-row-label-with-info">
                    <label>{t.settings.rightClickToPaste}</label>
                      <InfoTooltip
                        content={t.settings.tooltips.rightClickToPaste}
                      />
                  </div>
                  <label className="switch">
                    <input
                      type="checkbox"
                        checked={
                          store.settings?.terminal?.rightClickToPaste ?? false
                        }
                        onChange={(e) =>
                          store.setTerminalSettings({
                            rightClickToPaste: e.target.checked,
                          })
                        }
                    />
                    <span className="switch-slider" />
                  </label>
                </div>
                <div className="settings-row">
                  <div className="settings-row-label-with-info">
                    <label>{t.settings.commandDraftShortcut}</label>
                    <InfoTooltip content={t.settings.tooltips.commandDraftShortcut} />
                  </div>
                  <ShortcutRecorder
                    value={
                      store.settings?.terminal?.commandDraftShortcut ??
                      getDefaultCommandDraftShortcut()
                    }
                    disabledLabel={t.settings.shortcutDisabled}
                    listeningLabel={t.settings.shortcutListening}
                    onChange={(value) =>
                      store.setTerminalSettings({
                        commandDraftShortcut: value,
                      })
                    }
                  />
                </div>
              </div>
            </>
          ) : null}

            {store.settingsSection === "theme" ? (
            <>
              <div className="settings-section-header">
                  <div className="settings-section-title">
                    {t.settings.theme}
                  </div>
                <div className="settings-actions">
                  <InfoTooltip content={t.settings.tooltips.themeCustom}>
                      <button
                        className="btn-secondary"
                        onClick={() => store.openCustomThemeFile()}
                      >
                      {t.settings.openCustomThemes}
                    </button>
                  </InfoTooltip>
                  <InfoTooltip content={t.settings.tooltips.themeReload}>
                    <button
                      className="btn-icon-reload"
                      onClick={() => store.reloadCustomThemes()}
                      title={t.settings.reloadCustomThemes}
                    >
                      <RefreshCw size={14} />
                    </button>
                  </InfoTooltip>
                </div>
              </div>
              <div className="theme-grid">
                <div className="theme-divider">
                  <span>{t.settings.themeSectionCustom}</span>
                  <i />
                </div>
                {store.customThemes.map((theme) => (
                  <ThemeTile
                    key={`custom-${theme.name}`}
                      theme={{
                        id: theme.name,
                        name: theme.name,
                        terminal: theme,
                      }}
                    active={store.settings?.themeId === theme.name}
                    onClick={() => store.setThemeId(theme.name)}
                  />
                ))}
                <div className="theme-divider">
                  <span>{t.settings.themeSectionBuiltIn}</span>
                  <i />
                </div>
                {BUILTIN_THEMES.map((theme) => (
                  <ThemeTile
                    key={`builtin-${theme.id}`}
                    theme={theme}
                    active={store.settings?.themeId === theme.id}
                    onClick={() => store.setThemeId(theme.id)}
                  />
                ))}
              </div>
            </>
          ) : null}

            {store.settingsSection === "models" ? (
            <>
              <div className="settings-section-header">
                  <div className="settings-section-title">
                    {t.settings.baseModels}
                    <InfoTooltip content={t.settings.tooltips.modelAdd} />
                  </div>
                  <button
                    className="icon-btn-sm"
                    title={t.common.add}
                    onClick={() => openModelEditor()}
                  >
                      <Plus size={16} strokeWidth={2} />
                  </button>
              </div>
              
              <div className="models-list" style={modelMetaColumnVars}>
                {store.settings?.models.items.map((item) => (
                    <div
                      key={item.id}
                      className="model-item"
                      onClick={() => openModelEditor(item.id)}
                    >
                    {/** Active: text probe passed. Stateless: text failed but /v1/models passed. */}
                    {(() => {
                        const isActive = Boolean(item.profile?.textOutputs);
                        const supportsImage = Boolean(
                          item.profile?.imageInputs,
                        );
                      const supportsStructured =
                        item.profile?.supportsStructuredOutput === true ||
                          item.supportsStructuredOutput === true;
                      const isStateless =
                        Boolean(item.profile?.ok) &&
                        item.profile?.textOutputs === false &&
                          !supportsImage;

                      return (
                        <>
                            <div className="model-icon">
                              <Box size={16} />
                            </div>
                          <div className="model-info">
                              <div className="model-name">{item.name}</div>
                              <div className="model-id">{item.model}</div>
                          </div>
                          <div className="model-meta">
                              {isActive ? (
                                  <span className="tag active">Active</span>
                              ) : isStateless ? (
                                  <span className="tag warning">Stateless</span>
                              ) : (
                                  <span className="tag inactive">NoActive</span>
                              )}
                              {supportsImage ? (
                                  <span className="tag image">Image</span>
                              ) : (
                                <span className="tag ghost" aria-hidden="true">
                                  Image
                                </span>
                              )}
                              {supportsStructured ? (
                                <span className="tag structured">
                                  Structured
                                </span>
                              ) : (
                                <span className="tag ghost" aria-hidden="true">
                                  Structured
                                </span>
                              )}
                          </div>
                        </>
                        );
                    })()}
                    <button 
                        className="model-delete-btn"
                        onClick={(e) => {
                          e.stopPropagation();
                          setDeleteConfirm({ kind: "model", id: item.id });
                        }}
                    >
                        <Trash2 size={14} />
                    </button>
                  </div>
                ))}
              </div>

                <div
                  className="settings-section-title"
                  style={{ marginTop: 32 }}
                >
                {t.settings.profiles}
                <InfoTooltip content={t.settings.tooltips.modelProfile} />
              </div>
              
              <div className="profiles-grid">
                {store.settings?.models.profiles.map((p) => {
                    const isActive =
                      store.settings?.models.activeProfileId === p.id;
                  return (
                      <div
                        key={p.id}
                        className={`profile-card ${isActive ? "active" : ""}`}
                      >
                      <div className="profile-header">
                        <div 
                            className={`radio-check ${isActive ? "checked" : ""}`}
                            onClick={() => store.setActiveProfile(p.id)}
                        />
                        <input
                          className="profile-name-input"
                          value={p.name}
                            onChange={(e) =>
                              store.saveProfile({ ...p, name: e.target.value })
                            }
                          placeholder={t.settings.profileName}
                        />
                        <button
                          className="icon-btn-sm danger"
                            onClick={() =>
                              setDeleteConfirm({ kind: "profile", id: p.id })
                            }
                            disabled={
                              store.settings?.models.profiles.length === 1
                            }
                        >
                          <Trash2 size={14} />
                        </button>
                      </div>

                      <div className="profile-body">
                        <div className="profile-field">
                          <label>{t.settings.globalModel}</label>
                          <Select
                            value={p.globalModelId}
                              onChange={(id) =>
                                store.saveProfile({ ...p, globalModelId: id })
                              }
                              options={
                                store.settings?.models.items.map((m) => ({
                                  value: m.id,
                                  label: m.name,
                                })) || []
                              }
                          />
                        </div>
                        <div className="profile-field">
                          <label>{t.settings.actionModel}</label>
                          <Select
                              value={p.actionModelId || ""}
                              onChange={(id) =>
                                store.saveProfile({
                                  ...p,
                                  actionModelId: id || undefined,
                                })
                              }
                            options={[
                                { value: "", label: "(None)" },
                                ...(store.settings?.models.items.map((m) => ({
                                  value: m.id,
                                  label: m.name,
                                })) || []),
                            ]}
                          />
                        </div>
                        <div className="profile-field">
                          <label>{t.settings.thinkingModel}</label>
                          <Select
                              value={p.thinkingModelId || ""}
                              onChange={(id) =>
                                store.saveProfile({
                                  ...p,
                                  thinkingModelId: id || undefined,
                                })
                              }
                            options={[
                                { value: "", label: "(None)" },
                                ...(store.settings?.models.items.map((m) => ({
                                  value: m.id,
                                  label: m.name,
                                })) || []),
                            ]}
                          />
                        </div>
                        <div className="profile-field">
                          <div className="profile-field-label-with-info">
                            <label>{t.settings.compactionModel}</label>
                            <InfoTooltip content={t.settings.tooltips.compactionModel} />
                          </div>
                          <Select
                              value={p.compactionModelId || ""}
                              onChange={(id) =>
                                store.saveProfile({
                                  ...p,
                                  compactionModelId: id || undefined,
                                })
                              }
                            options={[
                                { value: "", label: "(None)" },
                                ...(store.settings?.models.items.map((m) => ({
                                  value: m.id,
                                  label: m.name,
                                })) || []),
                            ]}
                          />
                        </div>
                      </div>
                    </div>
                    );
                })}
                <button 
                    className="add-profile-btn"
                    onClick={() => {
                      const id = `profile-${Date.now()}`;
                      const firstModel =
                        store.settings?.models.items[0]?.id || "";
                      store.saveProfile({
                        id,
                        name: "New Profile",
                        globalModelId: firstModel,
                      });
                      store.setActiveProfile(id);
                    }}
                >
                    <Plus size={16} />
                    <span>New Profile</span>
                </button>
              </div>
            </>
          ) : null}

            {store.settingsSection === "security" ? (
            <>
              <div className="settings-section-header">
                  <div className="settings-section-title">
                    {t.settings.security}
                  </div>
                <div className="settings-actions">
                    <button
                      className="btn-secondary"
                      onClick={() => store.openCommandPolicyFile()}
                    >
                    {t.settings.editCommandPolicyFile}
                  </button>
                  <button
                    className="btn-icon-reload"
                    onClick={() => store.loadCommandPolicyLists()}
                    title={t.common.refresh}
                  >
                    <RefreshCw size={14} />
                  </button>
                </div>
              </div>
              <div className="settings-rows">
                <div className="settings-row">
                  <div className="settings-row-label-with-info">
                    <label>{t.settings.commandPolicyMode}</label>
                    <InfoTooltip 
                      content={
                        <div className="mode-descriptions">
                            <p>
                              <strong>
                                {t.settings.commandPolicyModes.safe}
                              </strong>
                              : {t.settings.commandPolicyModeDesc.safe}
                            </p>
                            <p>
                              <strong>
                                {t.settings.commandPolicyModes.standard}
                              </strong>
                              : {t.settings.commandPolicyModeDesc.standard}
                            </p>
                            <p>
                              <strong>
                                {t.settings.commandPolicyModes.smart}
                              </strong>
                              : {t.settings.commandPolicyModeDesc.smart}
                            </p>
                        </div>
                      }
                    />
                  </div>
                  <div className="settings-radio-group">
                      {(["safe", "standard", "smart"] as const).map((mode) => (
                      <label key={mode} className="settings-radio-item">
                        <input
                          type="radio"
                          name="command-policy-mode"
                          value={mode}
                          checked={store.settings?.commandPolicyMode === mode}
                          onChange={() => store.setCommandPolicyMode(mode)}
                        />
                        <span>{t.settings.commandPolicyModes[mode]}</span>
                      </label>
                    ))}
                  </div>
                </div>
              </div>

              <div className="settings-divider settings-divider-spaced">
                <span>{t.settings.commandPolicyAllowlist}</span>
                <i />
              </div>
              <div className="settings-subsection-header">
                <InfoTooltip content={t.settings.commandPolicyRuleDesc} />
                <input
                  className="settings-inline-input"
                  placeholder={t.settings.commandPolicyAddRulePlaceholder}
                  value={cpDraft.allowlist}
                    onChange={(e) =>
                      setCpDraft({ ...cpDraft, allowlist: e.target.value })
                    }
                />
                <button
                  className="icon-btn-sm"
                  title={t.common.add}
                  onClick={() => {
                      void store.addCommandPolicyRule(
                        "allowlist",
                        cpDraft.allowlist,
                      );
                      setCpDraft({ ...cpDraft, allowlist: "" });
                  }}
                >
                  <Plus size={16} strokeWidth={2} />
                </button>
              </div>
              <RuleChipList
                t={t}
                rules={cpLists.allowlist}
                  onDelete={(rule) =>
                    void store.deleteCommandPolicyRule("allowlist", rule)
                  }
              />

              <div className="settings-divider settings-divider-spaced">
                <span>{t.settings.commandPolicyDenylist}</span>
                <i />
              </div>
              <div className="settings-subsection-header">
                <InfoTooltip content={t.settings.commandPolicyRuleDesc} />
                <input
                  className="settings-inline-input"
                  placeholder={t.settings.commandPolicyAddRulePlaceholder}
                  value={cpDraft.denylist}
                    onChange={(e) =>
                      setCpDraft({ ...cpDraft, denylist: e.target.value })
                    }
                />
                <button
                  className="icon-btn-sm"
                  title={t.common.add}
                  onClick={() => {
                      void store.addCommandPolicyRule(
                        "denylist",
                        cpDraft.denylist,
                      );
                      setCpDraft({ ...cpDraft, denylist: "" });
                  }}
                >
                  <Plus size={16} strokeWidth={2} />
                </button>
              </div>
              <RuleChipList
                t={t}
                rules={cpLists.denylist}
                  onDelete={(rule) =>
                    void store.deleteCommandPolicyRule("denylist", rule)
                  }
              />

              <div className="settings-divider settings-divider-spaced">
                <span>{t.settings.commandPolicyAsklist}</span>
                <i />
              </div>
              <div className="settings-subsection-header">
                <InfoTooltip content={t.settings.commandPolicyRuleDesc} />
                <input
                  className="settings-inline-input"
                  placeholder={t.settings.commandPolicyAddRulePlaceholder}
                  value={cpDraft.asklist}
                    onChange={(e) =>
                      setCpDraft({ ...cpDraft, asklist: e.target.value })
                    }
                />
                <button
                  className="icon-btn-sm"
                  title={t.common.add}
                  onClick={() => {
                      void store.addCommandPolicyRule(
                        "asklist",
                        cpDraft.asklist,
                      );
                      setCpDraft({ ...cpDraft, asklist: "" });
                  }}
                >
                  <Plus size={16} strokeWidth={2} />
                </button>
              </div>
              <RuleChipList
                t={t}
                rules={cpLists.asklist}
                  onDelete={(rule) =>
                    void store.deleteCommandPolicyRule("asklist", rule)
                  }
              />
            </>
          ) : null}

            {store.settingsSection === "tools" ? (
            <>
              <div className="settings-section-header">
                <div className="settings-section-title">
                  {t.settings.tools}
                  <InfoTooltip content={t.settings.tooltips.mcpConfig} />
                </div>
              </div>
              <div className="settings-subsection-header">
                <div className="settings-divider">
                  <span>{t.settings.mcpConfig}</span>
                  <i />
                </div>
                <div className="settings-actions">
                  <InfoTooltip content={t.settings.tooltips.mcpConfig}>
                      <button
                        className="btn-secondary"
                        onClick={() => store.openMcpConfig()}
                      >
                      {t.settings.editMcpConfig}
                    </button>
                  </InfoTooltip>
                  <button
                    className="btn-icon-reload"
                    onClick={() => store.reloadMcpTools()}
                    title={t.settings.reloadMcpTools}
                  >
                    <RefreshCw size={14} />
                  </button>
                </div>
              </div>
              <div className="tools-list">
                {store.mcpTools.map((tool) => {
                    const statusClass = !tool.enabled
                      ? "is-disabled"
                      : tool.status === "connected"
                        ? "is-ok"
                        : tool.status === "error"
                          ? "is-error"
                          : "is-pending";
                  return (
                    <div key={tool.name} className="tool-item">
                      <div className="tool-info">
                        <div className="tool-name">{tool.name}</div>
                        <div className="tool-meta">
                            {tool.toolCount !== undefined
                              ? `${tool.toolCount} ${t.settings.toolsCount}`
                              : t.settings.toolsUnknown}
                        </div>
                          {tool.error ? (
                            <div className="tool-error">{tool.error}</div>
                          ) : null}
                      </div>
                      <div className="tool-actions">
                        <span className={`status-dot ${statusClass}`} />
                        <label className="switch">
                          <input
                            type="checkbox"
                            checked={tool.enabled}
                              onChange={(e) =>
                                store.setMcpToolEnabled(
                                  tool.name,
                                  e.target.checked,
                                )
                              }
                          />
                          <span className="switch-slider" />
                        </label>
                      </div>
                    </div>
                    );
                })}
                  {store.mcpTools.length === 0 ? (
                    <div className="tool-empty">{t.settings.noMcpTools}</div>
                  ) : null}
              </div>

              <div className="settings-divider settings-divider-spaced">
                <span>{t.settings.builtInTools}</span>
                <i />
              </div>
              <div className="tools-list">
                {builtInTools.map((tool) => (
                  <div key={tool.name} className="tool-item">
                    <div className="tool-info">
                      <div className="tool-name">{tool.name}</div>
                        <div className="tool-meta">
                          {tool.description || ""}
                        </div>
                    </div>
                    <div className="tool-actions">
                        <span
                          className={`status-dot ${tool.enabled ? "is-ok" : "is-disabled"}`}
                        />
                      <label className="switch">
                        <input
                          type="checkbox"
                          checked={tool.enabled}
                            onChange={(e) =>
                              store.setBuiltInToolEnabled(
                                tool.name,
                                e.target.checked,
                              )
                            }
                        />
                        <span className="switch-slider" />
                      </label>
                    </div>
                  </div>
                ))}
                  {builtInTools.length === 0 ? (
                    <div className="tool-empty">
                      {t.settings.noBuiltInTools}
                    </div>
                  ) : null}
              </div>

              {experimentalBuiltInTools.length > 0 ? (
                <>
                  <div className="settings-divider settings-divider-spaced">
                    <span>{t.settings.experimentalTools}</span>
                    <i />
                  </div>
                  <div className="tools-list">
                    {experimentalBuiltInTools.map((tool) => (
                      <div key={tool.name} className="tool-item">
                        <div className="tool-info">
                          <div className="tool-name">{tool.name}</div>
                          <div className="tool-meta">
                            {tool.description || ""}
                          </div>
                        </div>
                        <div className="tool-actions">
                          <span
                            className={`status-dot ${tool.enabled ? "is-ok" : "is-disabled"}`}
                          />
                          <label className="switch">
                            <input
                              type="checkbox"
                              checked={tool.enabled}
                              disabled={experimentalToolEnableBusy}
                              onChange={(event) => {
                                if (event.target.checked) {
                                  setExperimentalToolEnableConfirm({
                                    name: tool.name,
                                  });
                                  return;
                                }
                                void store.setBuiltInToolEnabled(
                                  tool.name,
                                  false,
                                );
                              }}
                            />
                            <span className="switch-slider" />
                          </label>
                        </div>
                      </div>
                    ))}
                  </div>
                </>
              ) : null}
            </>
          ) : null}

            {store.settingsSection === "skills" ? (
            <>
              <div className="settings-section-header">
                <div className="settings-section-title">
                  {t.settings.skills}
                  <InfoTooltip content={t.settings.tooltips.skills} />
                </div>
                <div className="settings-actions">
                  <InfoTooltip content={t.settings.tooltips.skills}>
                      <button
                        className="btn-secondary"
                        onClick={() => store.openSkillsFolder()}
                      >
                      {t.settings.openSkillsFolder}
                    </button>
                  </InfoTooltip>
                    <button
                      className="icon-btn-sm"
                      title={t.settings.addSkill}
                      onClick={() => store.createSkill()}
                    >
                    <Plus size={16} strokeWidth={2} />
                  </button>
                  <button
                    className="btn-icon-reload"
                    onClick={() => store.reloadSkills()}
                    title={t.settings.reloadSkills}
                  >
                    <RefreshCw size={14} />
                  </button>
                </div>
              </div>

              {(() => {
                  const skillsByDir: Record<string, typeof store.skills> = {};
                store.skills.forEach((s) => {
                    const dir = s.scanRoot; // Group by the scan root directory
                    if (!skillsByDir[dir]) skillsByDir[dir] = [];
                    skillsByDir[dir].push(s);
                  });

                const sortedDirs = Object.keys(skillsByDir).sort((a, b) => {
                    const isACustom =
                      a.includes("GyShell") ||
                      (a.endsWith("skills") &&
                        !a.includes(".agents"));
                    const isBCustom =
                      b.includes("GyShell") ||
                      (b.endsWith("skills") &&
                        !b.includes(".agents"));
                    if (isACustom && !isBCustom) return -1;
                    if (!isACustom && isBCustom) return 1;
                    return a.localeCompare(b);
                  });

                return sortedDirs.map((dir) => {
                    const dirSkills = skillsByDir[dir];
                    const isCustom =
                      dir.includes("GyShell") ||
                      (dir.endsWith("skills") &&
                        !dir.includes(".agents"));
                    const sectionTitle = isCustom
                      ? t.settings.skillSections.custom
                      : dir;
                  
                    const allEnabled = dirSkills.every(
                      (s) => store.settings?.tools?.skills?.[s.name] !== false,
                    );
                    const someEnabled = dirSkills.some(
                      (s) => store.settings?.tools?.skills?.[s.name] !== false,
                    );

                  return (
                    <React.Fragment key={dir}>
                      <div className="settings-divider settings-divider-spaced">
                        <span>{sectionTitle}</span>
                        <i />
                        {!isCustom && (
                          <div className="section-global-toggle">
                            <label className="switch switch-sm">
                              <input
                                type="checkbox"
                                checked={allEnabled}
                                  ref={(el) => {
                                    if (el)
                                      el.indeterminate =
                                        someEnabled && !allEnabled;
                                  }}
                                onChange={async (e) => {
                                    const enabled = e.target.checked;
                                  // Update all skills in this directory
                                  for (const s of dirSkills) {
                                      await store.setSkillEnabled(
                                        s.name,
                                        enabled,
                                      );
                                  }
                                }}
                              />
                              <span className="switch-slider" />
                            </label>
                          </div>
                        )}
                      </div>
                      <div className="tools-list">
                        {dirSkills.map((s) => {
                            const isEnabled =
                              store.settings?.tools?.skills?.[s.name] !== false;
                          return (
                            <div key={s.filePath} className="tool-item">
                              <div className="tool-info">
                                <div className="tool-name">
                                  {s.name}
                                    {s.isNested && (
                                      <span className="skill-type-tag">
                                        Nested
                                      </span>
                                    )}
                                  </div>
                                  <div className="tool-meta">
                                    {s.description}
                                </div>
                              </div>
                              <div className="tool-actions">
                                  <span
                                    className={`status-dot ${isEnabled ? "is-ok" : "is-disabled"}`}
                                  />
                                <label className="switch">
                                  <input
                                    type="checkbox"
                                    checked={isEnabled}
                                      onChange={(e) =>
                                        store.setSkillEnabled(
                                          s.name,
                                          e.target.checked,
                                        )
                                      }
                                  />
                                  <span className="switch-slider" />
                                </label>
                                {isCustom && (
                                  <>
                                      <button
                                        className="icon-btn-sm"
                                        title={t.common.edit}
                                        onClick={() =>
                                          store.editSkill(s.fileName)
                                        }
                                      >
                                      <Pencil size={14} />
                                    </button>
                                    <button
                                      className="icon-btn-sm danger"
                                      title={t.common.delete}
                                        onClick={() =>
                                          setDeleteSkillConfirm({
                                            fileName: s.fileName,
                                          })
                                        }
                                    >
                                      <Trash2 size={14} />
                                    </button>
                                  </>
                                )}
                              </div>
                            </div>
                            );
                        })}
                      </div>
                    </React.Fragment>
                    );
                  });
              })()}
                {store.skills.length === 0 ? (
                  <div className="tool-empty">{t.settings.noSkills}</div>
                ) : null}
            </>
          ) : null}

            {store.settingsSection === "memory" ? (
            <>
              <div className="settings-section-header">
                <div className="settings-section-title">
                  {t.settings.memory}
                  <InfoTooltip content={t.settings.tooltips.memory} />
                </div>
                <div className="settings-actions">
                  <button
                    className="btn-icon-reload"
                    onClick={() => void reloadMemory()}
                    title={t.settings.reloadMemory}
                    disabled={memoryBusy}
                  >
                      <RefreshCw
                        size={14}
                        className={memoryBusy ? "spin" : ""}
                      />
                  </button>
                    <button
                      className="btn-secondary"
                      onClick={() => store.openMemoryFile()}
                    >
                    {t.settings.openMemoryFile}
                  </button>
                    <button
                      className="btn-secondary"
                      onClick={() => void saveMemory()}
                      disabled={memoryBusy}
                    >
                    {t.settings.saveMemory}
                  </button>
                </div>
              </div>

              <div className="settings-rows">
                <div className="settings-row">
                  <div className="settings-row-label-with-info">
                    <label>{t.settings.memoryEnabled}</label>
                    <InfoTooltip content={t.settings.tooltips.memory} />
                  </div>
                  <label className="switch">
                    <input
                      type="checkbox"
                      checked={store.settings?.memory?.enabled !== false}
                        onChange={(e) =>
                          store.setMemoryEnabled(e.target.checked)
                        }
                    />
                    <span className="switch-slider" />
                  </label>
                </div>
              </div>

              <div className="settings-memory-panel">
                <div className="settings-memory-meta">
                  <div className="settings-row-label-with-info">
                    <label>{t.settings.memoryFilePath}</label>
                  </div>
                    <input
                      className="settings-inline-input"
                      value={store.memoryFilePath || "-"}
                      readOnly
                    />

                  <div className="settings-row-label-with-info settings-memory-content-label">
                    <label>{t.settings.memoryContent}</label>
                  </div>
                </div>
                <textarea
                  className="settings-memory-editor"
                  value={memoryDraft}
                  onChange={(event) => setMemoryDraft(event.target.value)}
                  spellCheck={false}
                  disabled={memoryBusy}
                />
              </div>
            </>
          ) : null}

            {store.settingsSection === "workflow" ? (
              <>
                <div className="settings-section-header">
                  <div className="settings-section-title">
                    {t.settings.workflow}
                  </div>
                </div>
                <div className="settings-rows">
                  <div className="settings-row">
                    <div className="settings-row-label-with-info">
                      <label>{t.settings.recursionLimit}</label>
                      <InfoTooltip
                        content={t.settings.tooltips.recursionLimit}
                      />
                    </div>
                    <div className="settings-slider-container">
                      <input
                        type="range"
                        className="settings-slider"
                        min="100"
                        max="1010"
                        step="10"
                        value={
                          store.settings?.recursionLimit === 2147483647
                            ? 1010
                            : store.settings?.recursionLimit || 200
                        }
                        onChange={(e) => {
                          const val = parseInt(e.target.value);
                          store.setRecursionLimit(
                            val === 1010 ? 2147483647 : val,
                          );
                        }}
                      />
                      <span className="settings-slider-value">
                        {store.settings?.recursionLimit === 2147483647
                          ? "INF"
                          : store.settings?.recursionLimit || 200}
                      </span>
                    </div>
                  </div>
                </div>

                <div
                  className="settings-section-header"
                  style={{ marginTop: 24 }}
                >
                  <div className="settings-section-title">
                    {t.settings.experimentalFeatures}
                  </div>
                </div>
                <div className="settings-rows">
                  <div className="settings-row">
                    <div className="settings-row-label-with-info">
                      <label>{t.settings.runtimeThinkingCorrection}</label>
                      <InfoTooltip
                        content={t.settings.tooltips.runtimeThinkingCorrection}
                      />
                    </div>
                    <label className="switch">
                      <input
                        type="checkbox"
                        checked={
                          store.settings?.experimental
                            ?.runtimeThinkingCorrectionEnabled !== false
                        }
                        onChange={(e) =>
                          store.setRuntimeThinkingCorrectionEnabled(
                            e.target.checked,
                          )
                        }
                      />
                      <span className="switch-slider" />
                    </label>
                  </div>
                  <div className="settings-row">
                    <div className="settings-row-label-with-info">
                      <label>{t.settings.taskFinishGuard}</label>
                      <InfoTooltip
                        content={t.settings.tooltips.taskFinishGuard}
                      />
                    </div>
                    <label className="switch">
                      <input
                        type="checkbox"
                        checked={
                          store.settings?.experimental
                            ?.taskFinishGuardEnabled !== false
                        }
                        onChange={(e) =>
                          store.setTaskFinishGuardEnabled(e.target.checked)
                        }
                      />
                      <span className="switch-slider" />
                    </label>
                  </div>
                  <div className="settings-row">
                    <div className="settings-row-label-with-info">
                      <label>{t.settings.firstTurnThinkingModel}</label>
                      <InfoTooltip
                        content={t.settings.tooltips.firstTurnThinkingModel}
                      />
                    </div>
                    <label className="switch">
                      <input
                        type="checkbox"
                        checked={
                          store.settings?.experimental
                            ?.firstTurnThinkingModelEnabled === true
                        }
                        onChange={(e) =>
                          store.setFirstTurnThinkingModelEnabled(
                            e.target.checked,
                          )
                        }
                      />
                      <span className="switch-slider" />
                    </label>
                  </div>
                  <div className="settings-row">
                    <div className="settings-row-label-with-info">
                      <label>{t.settings.execCommandActionModel}</label>
                      <InfoTooltip
                        content={t.settings.tooltips.execCommandActionModel}
                      />
                    </div>
                    <label className="switch">
                      <input
                        type="checkbox"
                        checked={
                          store.settings?.experimental
                            ?.execCommandActionModelEnabled !== false
                        }
                        onChange={(e) =>
                          store.setExecCommandActionModelEnabled(
                            e.target.checked,
                          )
                        }
                      />
                      <span className="switch-slider" />
                    </label>
                  </div>
                  <div className="settings-row">
                    <div className="settings-row-label-with-info">
                      <label>{t.settings.writeStdinActionModel}</label>
                      <InfoTooltip
                        content={t.settings.tooltips.writeStdinActionModel}
                      />
                    </div>
                    <label className="switch">
                      <input
                        type="checkbox"
                        checked={
                          store.settings?.experimental
                            ?.writeStdinActionModelEnabled !== false
                        }
                        onChange={(e) =>
                          store.setWriteStdinActionModelEnabled(
                            e.target.checked,
                          )
                        }
                      />
                      <span className="switch-slider" />
                    </label>
                  </div>
                </div>
              </>
            ) : null}

            {store.settingsSection === "accessTokens" ? (
            <>
              <div className="settings-section-header">
                <div className="settings-section-title">
                  {t.settings.accessTokens}
                  <InfoTooltip content={t.settings.tooltips.accessTokens} />
                </div>
                <div className="settings-actions">
                    <button
                      className="btn-icon-reload"
                      onClick={() => store.loadAccessTokens()}
                      title={t.common.refresh}
                    >
                    <RefreshCw size={14} />
                  </button>
                </div>
              </div>

              <div className="settings-rows">
                <div className="settings-row">
                  <div className="settings-row-label-with-info">
                    <label>{t.settings.wsGatewayAccess}</label>
                      <InfoTooltip
                        content={t.settings.tooltips.wsGatewayAccess}
                      />
                  </div>
                  <Select
                    className="settings-native-select"
                      value={wsGatewayAccessDraft}
                      onChange={async (value) => {
                        const nextAccess = value as NonNullable<
                          typeof store.settings
                        >["gateway"]["ws"]["access"];
                        setWsGatewayAccessDraft(nextAccess);
                        if (nextAccess === "custom") {
                          if (persistedWsGatewayCidrs.trim().length > 0) {
                            await store.setWsGatewayAccess("custom");
                          }
                          return;
                        }
                        await store.setWsGatewayAccess(nextAccess);
                      }}
                    options={[
                        {
                          value: "localhost",
                          label: t.settings.wsGatewayAccessModes.localhost,
                        },
                        {
                          value: "lan",
                          label: t.settings.wsGatewayAccessModes.lan,
                        },
                        {
                          value: "custom",
                          label: t.settings.wsGatewayAccessModes.custom,
                        },
                        {
                          value: "internet",
                          label: t.settings.wsGatewayAccessModes.internet,
                        },
                        {
                          value: "disabled",
                          label: t.settings.wsGatewayAccessModes.disabled,
                        },
                    ]}
                  />
                </div>
                <div className="settings-row">
                  <div className="settings-row-label-with-info">
                    <label>{t.settings.wsGatewayPort}</label>
                      <InfoTooltip
                        content={t.settings.tooltips.wsGatewayPort}
                      />
                  </div>
                  <NumericInput
                    className="settings-inline-input"
                    style={{ width: 110 }}
                    value={store.settings?.gateway?.ws?.port || 17888}
                    onChange={(value) => store.setWsGatewayPort(value)}
                    min={1}
                    max={65535}
                  />
                </div>
                  {wsGatewayAccessDraft === "custom" && (
                    <div
                      className="settings-row"
                      style={{
                        flexDirection: "column",
                        alignItems: "flex-start",
                        height: "auto",
                        padding: "10px 12px",
                        gap: 8,
                      }}
                    >
                      <div className="settings-row-label-with-info">
                        <label>{t.settings.wsGatewayCidrs}</label>
                        <InfoTooltip
                          content={t.settings.tooltips.wsGatewayCidrs}
                        />
                      </div>
                      <textarea
                        placeholder={"192.168.1.0/24\n10.0.0.0/8"}
                        value={wsGatewayCidrsDraft}
                        onChange={(e) => setWsGatewayCidrsDraft(e.target.value)}
                        onBlur={async () => {
                          if (persistedWsGatewayAccess === "custom") {
                            const applied =
                              await store.setWsGatewayCidrs(
                                wsGatewayCidrsDraft,
                              );
                            if (!applied) {
                              setWsGatewayCidrsDraft(persistedWsGatewayCidrs);
                            }
                            return;
                          }
                          const applied =
                            await store.setWsGatewayCustomCidrs(
                              wsGatewayCidrsDraft,
                            );
                          if (!applied) {
                            setWsGatewayAccessDraft(persistedWsGatewayAccess);
                            setWsGatewayCidrsDraft(persistedWsGatewayCidrs);
                          }
                        }}
                        rows={4}
                        style={{
                          width: "100%",
                          fontFamily: "monospace",
                          fontSize: "0.85em",
                          padding: "6px 8px",
                          boxSizing: "border-box",
                          resize: "vertical",
                          background:
                            "color-mix(in srgb, var(--fg) 5%, transparent)",
                          color: "var(--fg)",
                          border: "1px solid var(--border)",
                          borderRadius: 2,
                        }}
                      />
                    </div>
                  )}
                </div>

                {/* Mobile Web Server Section */}
                <div className="settings-divider settings-divider-spaced">
                  <span>{t.settings.mobileWebServer}</span>
                  <i />
                </div>
                <div className="settings-rows">
                  <div className="settings-row">
                    <div className="settings-row-label-with-info">
                      <label>{t.settings.mobileWebServer}</label>
                      <InfoTooltip
                        content={t.settings.tooltips.mobileWebServer}
                      />
                    </div>
                    <label className="switch">
                      <input
                        type="checkbox"
                        checked={isMobileWebRunning}
                        onChange={async (e) => {
                          const access = store.settings?.gateway?.ws?.access;
                          if (
                            e.target.checked &&
                            (access === "disabled" || access === "localhost")
                          ) {
                            setShowMobileWebGatewayWarning(true);
                            return;
                          }
                          if (e.target.checked) {
                            await store.startMobileWeb();
                          } else {
                            await store.stopMobileWeb();
                          }
                        }}
                      />
                      <span className="switch-slider" />
                    </label>
              </div>

                  <div className="settings-row">
                    <div className="settings-row-label-with-info">
                      <label>{t.settings.mobileWebPort}</label>
                    </div>
                    <div
                      style={{ display: "flex", alignItems: "center", gap: 8 }}
                    >
                      <label
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: 4,
                          cursor: isMobileWebRunning
                            ? "not-allowed"
                            : "pointer",
                          opacity: isMobileWebRunning ? 0.6 : 1,
                        }}
                      >
                        <input
                          type="radio"
                          name="mobileWebPortMode"
                          checked={
                            store.settings?.gateway?.mobileWeb?.port == null
                          }
                          disabled={isMobileWebRunning}
                          onChange={() => store.setMobileWebPort(null)}
                        />
                        {t.settings.mobileWebPortAuto}
                      </label>
                      <label
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: 4,
                          cursor: isMobileWebRunning
                            ? "not-allowed"
                            : "pointer",
                          opacity: isMobileWebRunning ? 0.6 : 1,
                        }}
                      >
                        <input
                          type="radio"
                          name="mobileWebPortMode"
                          checked={
                            store.settings?.gateway?.mobileWeb?.port != null
                          }
                          disabled={isMobileWebRunning}
                          onChange={() => store.setMobileWebPort(17889)}
                        />
                        {t.settings.mobileWebPortManual}
                      </label>
                      {store.settings?.gateway?.mobileWeb?.port != null && (
                        <NumericInput
                          className="settings-inline-input"
                          style={{ width: 90 }}
                          value={
                            (store.settings?.gateway?.mobileWeb as any).port
                          }
                          disabled={isMobileWebRunning}
                          onChange={(v) =>
                            store.setMobileWebPort(Math.floor(v))
                          }
                          min={1}
                          max={65535}
                        />
                      )}
                    </div>
                  </div>

                  {isMobileWebRunning &&
                    store.mobileWebStatus.urls &&
                    store.mobileWebStatus.urls.length > 0 && (
                      <div
                        className="settings-row"
                        style={{
                          flexDirection: "column",
                          alignItems: "flex-start",
                          height: "auto",
                          padding: "10px 12px",
                          gap: 8,
                        }}
                      >
                        <div className="settings-row-label-with-info">
                          <label>{t.settings.mobileWebAccessLinks}</label>
                        </div>
                        <div
                          style={{
                            display: "flex",
                            flexDirection: "column",
                            gap: 6,
                          }}
                        >
                          {store.mobileWebStatus.urls.map((url) => (
                            <div
                              key={url}
                              style={{
                                display: "flex",
                                alignItems: "center",
                                gap: 8,
                              }}
                            >
                              <code
                                style={{
                                  flex: 1,
                                  fontSize: "0.85em",
                                  wordBreak: "break-all",
                                }}
                              >
                                {url}
                              </code>
                              <button
                                className="btn-secondary"
                                style={{ flexShrink: 0 }}
                                onClick={() =>
                                  navigator.clipboard.writeText(url)
                                }
                              >
                                {t.settings.mobileWebCopyLink}
                              </button>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                </div>

              <div className="settings-subsection-header">
                <input
                  className="settings-inline-input"
                  placeholder={t.settings.accessTokenNamePlaceholder}
                  value={accessTokenName}
                  onChange={(event) => setAccessTokenName(event.target.value)}
                  disabled={accessTokenBusy}
                />
                  <button
                    className="btn-secondary"
                    onClick={createAccessToken}
                    disabled={accessTokenBusy}
                  >
                    {accessTokenBusy ? (
                      <Loader2 size={14} className="spin" />
                    ) : (
                      t.common.create
                    )}
                </button>
              </div>

                {accessTokenError ? (
                  <div className="settings-error">{accessTokenError}</div>
                ) : null}

              <div className="settings-divider settings-divider-spaced">
                <span>{t.settings.accessTokenIssuedList}</span>
                <i />
              </div>
              <div className="tools-list">
                {store.accessTokens.map((tokenInfo) => (
                    <div
                      key={tokenInfo.id}
                      className="tool-item access-token-item"
                    >
                    <div className="tool-info">
                      <div className="tool-name">{tokenInfo.name}</div>
                        <div className="tool-meta">
                          {new Date(tokenInfo.createdAt).toLocaleString()}
                        </div>
                    </div>
                    <div className="tool-actions">
                      <button
                        className="icon-btn-sm danger"
                        title={t.common.delete}
                          onClick={() =>
                            setDeleteAccessTokenConfirm({
                              id: tokenInfo.id,
                              name: tokenInfo.name,
                            })
                          }
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  </div>
                ))}
                  {store.accessTokens.length === 0 ? (
                    <div className="tool-empty">
                      {t.settings.noAccessTokens}
                    </div>
                  ) : null}
              </div>
            </>
          ) : null}

            {store.settingsSection === "version" ? (
            <>
              <div className="settings-section-header">
                  <div className="settings-section-title">
                    {t.settings.version}
                  </div>
                <div className="settings-actions">
                  <button
                    className="btn-secondary"
                    onClick={() => store.checkVersion()}
                    disabled={store.versionCheckInProgress}
                  >
                      {store.versionCheckInProgress
                        ? `${t.settings.checkingVersion}...`
                        : t.settings.checkVersion}
                  </button>
                </div>
              </div>

              <div className="version-grid">
                <div className="version-item">
                    <span className="version-label">
                      {t.settings.currentVersion}
                    </span>
                    <span className="version-value">
                      {versionInfo?.currentVersion || "-"}
                    </span>
                </div>
                <div className="version-item">
                    <span className="version-label">
                      {t.settings.latestVersion}
                    </span>
                    <span className="version-value">
                      {versionInfo?.latestVersion || "-"}
                    </span>
                </div>
                <div className="version-item">
                    <span className="version-label">
                      {t.settings.versionStatus}
                    </span>
                    <span
                      className={`version-status version-status-${versionInfo?.status || "up-to-date"}`}
                    >
                      {versionInfo?.status === "update-available"
                      ? t.settings.updateAvailable
                        : versionInfo?.status === "error"
                      ? t.settings.versionCheckFailed
                      : t.settings.upToDate}
                  </span>
                </div>
                <div className="version-item">
                    <span className="version-label">
                      {t.settings.lastCheckedAt}
                    </span>
                  <span className="version-value">{formattedCheckedAt}</span>
                </div>
                <div className="version-item">
                    <span className="version-label">
                      {t.settings.versionSource}
                    </span>
                    <span className="version-value">
                      {versionInfo?.sourceUrl || "-"}
                    </span>
                </div>
                <div className="version-item">
                    <span className="version-label">
                      {t.settings.downloadPage}
                    </span>
                  {versionInfo?.downloadUrl ? (
                    <button
                      className="version-link"
                      onClick={() => store.openVersionDownload()}
                      title={versionInfo.downloadUrl}
                    >
                      {versionInfo.downloadUrl}
                    </button>
                  ) : (
                    <span className="version-value">-</span>
                  )}
                </div>
              </div>

                {versionInfo?.status === "error" && versionInfo.warning ? (
                <div className="version-warning">
                  <AlertTriangle size={13} />
                    <span>
                      {t.settings.versionNetworkWarning(versionInfo.warning)}
                    </span>
                </div>
              ) : null}

              <div className="settings-card version-note-card">
                  <div className="version-note-title">
                    {t.settings.versionCheckNoteTitle}
                  </div>
                  <div className="version-note-content">
                    {t.settings.versionCheckNote}
                  </div>
              </div>
            </>
          ) : null}
        </div>
      </div>
    </div>
    );
  },
);
