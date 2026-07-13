import React from "react";
import { Check, Loader2, Plus, RefreshCw, Trash2 } from "lucide-react";
import { useMobileI18n } from "../../i18n/provider";
import type {
  AgentSettingApplyOutcome,
  AgentSettingStateSummary,
} from "../../types";

interface AgentProfilesPanelProps {
  state: AgentSettingStateSummary | null;
  loading: boolean;
  error: string;
  saving: boolean;
  onReload: () => void;
  onSaveCurrent: () => Promise<boolean>;
  onApply: (
    profileId: string,
    acknowledgedExperimentalToolNames?: string[],
  ) => Promise<AgentSettingApplyOutcome>;
  onOverwrite: (profileId: string) => Promise<boolean>;
  onDelete: (profileId: string) => Promise<boolean>;
}

export const AgentProfilesPanel: React.FC<AgentProfilesPanelProps> = ({
  state,
  loading,
  error,
  saving,
  onReload,
  onSaveCurrent,
  onApply,
  onOverwrite,
  onDelete,
}) => {
  const { t } = useMobileI18n();
  const [confirmSave, setConfirmSave] = React.useState(false);
  const [confirmOverwriteId, setConfirmOverwriteId] = React.useState<string | null>(
    null,
  );
  const [confirmDeleteId, setConfirmDeleteId] = React.useState<string | null>(null);
  const [busyId, setBusyId] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!loading && state === null) {
      onReload();
    }
  }, [loading, state, onReload]);

  const profiles = state?.profiles || [];
  const activeProfileId = state?.activeProfileId || null;

  const handleSave = React.useCallback(async () => {
    setConfirmSave(false);
    setBusyId("__save__");
    try {
      await onSaveCurrent();
    } finally {
      setBusyId(null);
    }
  }, [onSaveCurrent]);

  const handleApply = React.useCallback(
    async (profileId: string) => {
      setBusyId(profileId);
      try {
        let outcome = await onApply(profileId);
        while (
          !outcome.applied &&
          outcome.experimentalToolNames.length > 0
        ) {
          const accepted = window.confirm(
            t.tools.experimentalEnableWarning(
              outcome.experimentalToolNames.join(", "),
            ),
          );
          if (!accepted) return;
          outcome = await onApply(
            profileId,
            outcome.experimentalToolNames,
          );
        }
      } finally {
        setBusyId(null);
      }
    },
    [onApply, t.tools],
  );

  const handleOverwrite = React.useCallback(
    async (profileId: string) => {
      setConfirmOverwriteId(null);
      setBusyId(profileId);
      try {
        await onOverwrite(profileId);
      } finally {
        setBusyId(null);
      }
    },
    [onOverwrite],
  );

  const handleDelete = React.useCallback(
    async (profileId: string) => {
      setConfirmDeleteId(null);
      setBusyId(profileId);
      try {
        await onDelete(profileId);
      } finally {
        setBusyId(null);
      }
    },
    [onDelete],
  );

  const renderProfile = (profile: (typeof profiles)[number]) => {
    const isActive = profile.id === activeProfileId;
    const slot = profile.slotNumber;
    const busy = busyId === profile.id;
    const policyLabel = profile.commandPolicyMode
      ? profile.commandPolicyMode.charAt(0).toUpperCase() +
        profile.commandPolicyMode.slice(1)
      : t.settings.agentProfileUnknownPolicy;
    return (
      <article
        key={profile.id}
        className={`agent-profile-row ${isActive ? "active" : ""}`}
      >
        <button
          type="button"
          className="agent-profile-main"
          onClick={() => {
            if (isActive || saving || busyId !== null) return;
            void handleApply(profile.id);
          }}
          disabled={saving || busyId !== null || isActive}
          aria-pressed={isActive}
        >
          <div className="agent-profile-radio">
            {isActive ? <Check size={12} /> : null}
          </div>
          <div className="agent-profile-info">
            <div className="agent-profile-name">
              {t.settings.agentProfileSlot(slot)}
            </div>
            <div className="agent-profile-meta">
              {profile.modelName ? (
                <span>
                  {t.settings.agentProfileModel}: {profile.modelName}
                </span>
              ) : null}
              <span>
                {t.settings.agentProfilePolicy}: {policyLabel}
              </span>
            </div>
          </div>
        </button>
        <div className="agent-profile-actions">
          <button
            type="button"
            className="agent-profile-action"
            onClick={() => setConfirmOverwriteId(profile.id)}
            disabled={saving || busyId !== null}
            title={t.common.overwrite}
          >
            {busy && busyId === profile.id ? (
              <Loader2 size={14} className="spin" />
            ) : (
              <RefreshCw size={14} />
            )}
          </button>
          <button
            type="button"
            className="agent-profile-action danger"
            onClick={() => setConfirmDeleteId(profile.id)}
            disabled={saving || busyId !== null}
            title={t.common.delete}
          >
            <Trash2 size={14} />
          </button>
        </div>
      </article>
    );
  };

  return (
    <section className="settings-item-flat">
      <header className="settings-head-flat">
        <h3>{t.settings.agentProfilesSection}</h3>
      </header>
      <p className="settings-hint-flat">{t.settings.agentProfilesHint}</p>

      {error ? (
        <p className="settings-error-flat">{error}</p>
      ) : null}

      {loading && profiles.length === 0 ? (
        <p className="settings-hint-flat">
          <Loader2 size={12} className="spin" /> {t.common.refresh}
        </p>
      ) : null}

      {!loading && profiles.length === 0 && !error ? (
        <p className="settings-hint-flat">{t.settings.agentProfilesEmpty}</p>
      ) : null}

      {profiles.length > 0 ? (
        <div className="agent-profile-list">{profiles.map(renderProfile)}</div>
      ) : null}

      <div className="settings-actions-flat">
        <button
          type="button"
          className="accent-btn-flat"
          onClick={() => setConfirmSave(true)}
          disabled={saving || busyId !== null}
        >
          {saving || busyId === "__save__" ? (
            <>
              <Loader2 size={14} className="spin" />
              {t.settings.agentProfileSaveCurrent}
            </>
          ) : (
            <>
              <Plus size={14} />
              {t.settings.agentProfileSaveCurrent}
            </>
          )}
        </button>
      </div>

      {confirmSave ? (
        <ConfirmDialog
          title={t.settings.agentProfileSaveCurrent}
          message={t.settings.agentProfileSaveCurrentConfirm}
          confirmLabel={t.common.save}
          cancelLabel={t.common.cancel}
          pending={saving}
          onCancel={() => setConfirmSave(false)}
          onConfirm={() => void handleSave()}
        />
      ) : null}

      {confirmOverwriteId
        ? (() => {
            const profile = profiles.find(
              (item) => item.id === confirmOverwriteId,
            );
            if (!profile) return null;
            return (
              <ConfirmDialog
                title={t.common.overwrite}
                message={t.settings.agentProfileOverwriteConfirm}
                confirmLabel={t.common.overwrite}
                cancelLabel={t.common.cancel}
                pending={busyId === confirmOverwriteId}
                onCancel={() => setConfirmOverwriteId(null)}
                onConfirm={() => void handleOverwrite(confirmOverwriteId)}
              />
            );
          })()
        : null}

      {confirmDeleteId
        ? (() => {
            const profile = profiles.find(
              (item) => item.id === confirmDeleteId,
            );
            if (!profile) return null;
            return (
              <ConfirmDialog
                title={t.common.delete}
                message={t.settings.agentProfileDeleteConfirm(
                  profile.slotNumber,
                )}
                confirmLabel={t.common.delete}
                cancelLabel={t.common.cancel}
                pending={busyId === confirmDeleteId}
                onCancel={() => setConfirmDeleteId(null)}
                onConfirm={() => void handleDelete(confirmDeleteId)}
              />
            );
          })()
        : null}
    </section>
  );
};

interface ConfirmDialogProps {
  title: string;
  message: string;
  confirmLabel: string;
  cancelLabel: string;
  pending: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}

const ConfirmDialog: React.FC<ConfirmDialogProps> = ({
  title,
  message,
  confirmLabel,
  cancelLabel,
  pending,
  onCancel,
  onConfirm,
}) => {
  return (
    <div className="confirm-overlay" role="presentation">
      <div
        className="confirm-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="agent-profile-confirm-title"
      >
        <h3 id="agent-profile-confirm-title">{title}</h3>
        <p>{message}</p>
        <div className="confirm-dialog-actions">
          <button
            type="button"
            className="accent-btn-flat"
            onClick={onCancel}
            disabled={pending}
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            className="accent-btn-flat primary"
            onClick={onConfirm}
            disabled={pending}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
};
