import React from "react";
import clsx from "clsx";
import { observer } from "mobx-react-lite";
import { AlertTriangle, Plus, X } from "lucide-react";
import type { AppStore } from "../../stores/AppStore";
import { ConfirmDialog } from "../Common/ConfirmDialog";
import { resolveFloatingMenuPlacement } from "../../lib/menuPlacement";

interface AgentSettingRailControlsProps {
  store: AppStore;
}

const MAX_AGENT_SETTING_PROFILES = 5;

interface ProfileMenuState {
  profileId: string;
  x: number;
  y: number;
}

type PendingAgentSettingAction =
  | { type: "save" }
  | { type: "apply"; profileId: string; experimentalToolNames: string[] }
  | { type: "overwrite"; profileId: string }
  | { type: "delete"; profileId: string };

export const AgentSettingRailControls: React.FC<AgentSettingRailControlsProps> =
  observer(({ store }) => {
    const t = store.i18n.t;
    const menuRef = React.useRef<HTMLDivElement | null>(null);
    const [profileMenu, setProfileMenu] =
      React.useState<ProfileMenuState | null>(null);
    const [profileMenuStyle, setProfileMenuStyle] = React.useState<
      React.CSSProperties | undefined
    >(undefined);
    const [pendingAction, setPendingAction] =
      React.useState<PendingAgentSettingAction | null>(null);
    const [busy, setBusy] = React.useState(false);
    const profiles = store.agentSettingState.profiles;
    const canSave = profiles.length < MAX_AGENT_SETTING_PROFILES;
    const warnings = store.agentSettingWarnings;

    const recomputeMenuStyle = React.useCallback(() => {
      const menu = menuRef.current;
      if (!profileMenu || !menu) return;
      const measured = menu.getBoundingClientRect();
      const placement = resolveFloatingMenuPlacement({
        anchorRect: {
          left: profileMenu.x,
          top: profileMenu.y,
          width: 0,
          height: 0,
        },
        menuWidth: Math.ceil(measured.width),
        menuHeight: Math.ceil(measured.height),
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
        margin: 8,
        gap: 2,
        preferredMaxHeight: 160,
      });
      setProfileMenuStyle({
        left: placement.left,
        top: placement.top,
        maxHeight: placement.maxHeight,
        maxWidth: placement.maxWidth,
      });
    }, [profileMenu]);

    React.useEffect(() => {
      if (!profileMenu) return;
      const handlePointerDown = (event: MouseEvent) => {
        const target = event.target as Node | null;
        if (target && menuRef.current?.contains(target)) return;
        setProfileMenu(null);
      };
      const handleKeyDown = (event: KeyboardEvent) => {
        if (event.key === "Escape") {
          setProfileMenu(null);
        }
      };
      window.addEventListener("mousedown", handlePointerDown);
      window.addEventListener("keydown", handleKeyDown);
      window.addEventListener("resize", recomputeMenuStyle);
      window.addEventListener("scroll", recomputeMenuStyle, true);
      return () => {
        window.removeEventListener("mousedown", handlePointerDown);
        window.removeEventListener("keydown", handleKeyDown);
        window.removeEventListener("resize", recomputeMenuStyle);
        window.removeEventListener("scroll", recomputeMenuStyle, true);
      };
    }, [profileMenu, recomputeMenuStyle]);

    React.useEffect(() => {
      if (!profileMenu) {
        setProfileMenuStyle(undefined);
      }
    }, [profileMenu]);

    React.useLayoutEffect(() => {
      if (!profileMenu) return;
      recomputeMenuStyle();
    }, [profileMenu, recomputeMenuStyle]);

    const runBusyAction = React.useCallback(
      async (action: () => Promise<unknown>) => {
        if (busy) return;
        setBusy(true);
        try {
          await action();
        } finally {
          setBusy(false);
        }
      },
      [busy],
    );

    const pendingActionProfile =
      pendingAction && pendingAction.type !== "save"
        ? profiles.find((profile) => profile.id === pendingAction.profileId) ||
          null
        : null;

    React.useEffect(() => {
      if (
        pendingAction &&
        pendingAction.type !== "save" &&
        !pendingActionProfile
      ) {
        setPendingAction(null);
      }
    }, [pendingAction, pendingActionProfile]);

    const pendingDialog = (() => {
      if (!pendingAction) return null;
      if (pendingAction.type === "save") {
        return {
          title: t.settings.saveCurrentAgentSettingTitle,
          message: t.settings.saveCurrentAgentSettingMessage,
          confirmText: t.common.save,
          danger: false,
          onConfirm: () => {
            void runBusyAction(async () => {
              await store.saveCurrentAgentSetting();
              setPendingAction(null);
            });
          },
        };
      }
      if (!pendingActionProfile) return null;
      if (pendingAction.type === "apply") {
        return {
          title: t.settings.experimentalToolEnableTitle,
          message: t.settings.experimentalToolEnableMessage(
            pendingAction.experimentalToolNames.join(", "),
          ),
          confirmText: t.settings.experimentalToolEnableConfirm,
          danger: true,
          onConfirm: () => {
            void runBusyAction(async () => {
              const result = await store.applyAgentSetting(
                pendingActionProfile.id,
                pendingAction.experimentalToolNames,
              );
              if (
                "kind" in result &&
                result.kind === "experimental_tool_confirmation_required"
              ) {
                setPendingAction({
                  type: "apply",
                  profileId: pendingActionProfile.id,
                  experimentalToolNames: result.experimentalToolNames,
                });
                return;
              }
              setPendingAction(null);
            });
          },
        };
      }
      if (pendingAction.type === "overwrite") {
        return {
          title: t.settings.overwriteAgentSettingTitle,
          message: t.settings.overwriteAgentSettingMessage(
            pendingActionProfile.slotNumber,
          ),
          confirmText: t.settings.overwriteAgentSettingConfirm,
          danger: true,
          onConfirm: () => {
            void runBusyAction(async () => {
              await store.overwriteAgentSetting(pendingActionProfile.id);
              setPendingAction(null);
            });
          },
        };
      }
      return {
        title: t.settings.deleteAgentSettingTitle,
        message: t.settings.deleteAgentSettingMessage(
          pendingActionProfile.slotNumber,
        ),
        confirmText: t.common.delete,
        danger: true,
        onConfirm: () => {
          void runBusyAction(async () => {
            await store.deleteAgentSetting(pendingActionProfile.id);
            setPendingAction(null);
          });
        },
      };
    })();

    return (
      <div className="settings-agent-slot-rail">
        <div className="settings-agent-slot-row">
          {profiles.map((profile) => (
            <button
              key={profile.id}
              className={clsx("settings-agent-slot-btn", {
                "is-active":
                  store.agentSettingState.activeProfileId === profile.id,
              })}
              type="button"
              title={t.settings.agentSettingSlot(profile.slotNumber)}
              aria-label={t.settings.agentSettingSlot(profile.slotNumber)}
              disabled={busy}
              onClick={() => {
                void runBusyAction(async () => {
                  const result = await store.applyAgentSetting(profile.id);
                  if (
                    "kind" in result &&
                    result.kind === "experimental_tool_confirmation_required"
                  ) {
                    setPendingAction({
                      type: "apply",
                      profileId: profile.id,
                      experimentalToolNames: result.experimentalToolNames,
                    });
                  }
                });
              }}
              onContextMenu={(event) => {
                event.preventDefault();
                if (busy) return;
                setProfileMenu({
                  profileId: profile.id,
                  x: event.clientX,
                  y: event.clientY,
                });
              }}
            >
              <span className="settings-agent-slot-number">
                {profile.slotNumber}
              </span>
            </button>
          ))}

          {canSave ? (
            <button
              className="settings-agent-slot-btn is-save"
              type="button"
              title={t.settings.saveCurrentAgentSettingDescription}
              aria-label={t.settings.saveCurrentAgentSettingDescription}
              disabled={busy}
              onClick={() => setPendingAction({ type: "save" })}
            >
              <Plus size={15} strokeWidth={2.4} />
            </button>
          ) : null}
        </div>

        {warnings.length > 0 ? (
          <div className="settings-agent-warning" role="status">
            <AlertTriangle size={14} strokeWidth={2.2} />
            <div className="settings-agent-warning-content">
              <strong>{t.settings.agentSettingPartialApplyWarning}</strong>
              {warnings.map((warning, index) => (
                <span key={`${warning}-${index}`}>{warning}</span>
              ))}
            </div>
            <button
              className="settings-agent-warning-close"
              type="button"
              title={t.common.close}
              aria-label={t.common.close}
              onClick={() => store.clearAgentSettingWarnings()}
            >
              <X size={13} strokeWidth={2.2} />
            </button>
          </div>
        ) : null}

        {profileMenu ? (
          <div
            ref={menuRef}
            className="gyshell-layout-menu settings-agent-slot-menu"
            style={
              profileMenuStyle || {
                left: profileMenu.x,
                top: profileMenu.y,
                visibility: "hidden",
              }
            }
          >
            <button
              className="gyshell-layout-menu-item"
              type="button"
              onClick={() => {
                setPendingAction({
                  type: "overwrite",
                  profileId: profileMenu.profileId,
                });
                setProfileMenu(null);
              }}
            >
              {t.settings.overwriteWithCurrentAgentSetting}
            </button>
            <button
              className="gyshell-layout-menu-item is-danger"
              type="button"
              onClick={() => {
                setPendingAction({
                  type: "delete",
                  profileId: profileMenu.profileId,
                });
                setProfileMenu(null);
              }}
            >
              {t.common.delete}
            </button>
          </div>
        ) : null}

        {pendingDialog ? (
          <ConfirmDialog
            open
            title={pendingDialog.title}
            message={pendingDialog.message}
            confirmText={pendingDialog.confirmText}
            cancelText={t.common.cancel}
            danger={pendingDialog.danger}
            loading={busy}
            onCancel={() => setPendingAction(null)}
            onConfirm={pendingDialog.onConfirm}
          />
        ) : null}
      </div>
    );
  });
