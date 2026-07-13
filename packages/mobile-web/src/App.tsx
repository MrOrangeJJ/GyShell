import React from "react";
import { Loader2 } from "lucide-react";
import type { AgentTimelineItem } from "./lib/chat-timeline";
import { MessageList } from "./components/chat/MessageList";
import { MessageDetailSheet } from "./components/chat/MessageDetailSheet";
import {
  SessionBrowser,
  type SessionBrowserItem,
} from "./components/chat/SessionBrowser";
import { ComposerBar } from "./components/composer/ComposerBar";
import { BottomNav, type MobileTabKey } from "./components/layout/BottomNav";
import { TopBar } from "./components/layout/TopBar";
import { AgentProfilesPanel } from "./components/panels/AgentProfilesPanel";
import { SettingsPanel } from "./components/panels/SettingsPanel";
import { SkillsPanel } from "./components/panels/SkillsPanel";
import { TerminalPanel } from "./components/panels/TerminalPanel";
import { ToolsPanel } from "./components/panels/ToolsPanel";
import { ToastViewport, type ToastEntry } from "./components/common/Toast";
import { useMobileController } from "./hooks/useMobileController";
import { useMobileI18n } from "./i18n/provider";
import {
  formatSessionListTitle,
  formatTopBarSessionTitle,
} from "./lib/session-title";
import type { ChatMessage } from "./types";

type SessionSubView = "sessions" | "conversation";
type SettingsSubPage = "root" | "skills" | "tools" | "agent-profiles";
const AUTO_SCROLL_THRESHOLD_PX = 64;

function isScrolledNearBottom(
  element: HTMLElement,
  thresholdPx = AUTO_SCROLL_THRESHOLD_PX,
): boolean {
  const remainingDistance =
    element.scrollHeight - element.scrollTop - element.clientHeight;
  return remainingDistance <= thresholdPx;
}

export const App: React.FC = () => {
  const { locale, setLocale, t } = useMobileI18n();
  const { state, actions } = useMobileController();
  const [activeTab, setActiveTab] = React.useState<MobileTabKey>("sessions");
  const [sessionSubView, setSessionSubView] =
    React.useState<SessionSubView>("sessions");
  const [settingsSubPage, setSettingsSubPage] =
    React.useState<SettingsSubPage>("root");
  const [sessionSearchQuery, setSessionSearchQuery] = React.useState("");
  const [detailTurnId, setDetailTurnId] = React.useState<string | null>(null);
  const [rollbackTarget, setRollbackTarget] =
    React.useState<ChatMessage | null>(null);
  const [rollbackPending, setRollbackPending] = React.useState(false);
  const [branchPending, setBranchPending] = React.useState(false);
  const branchPendingRef = React.useRef(false);
  const [toasts, setToasts] = React.useState<ToastEntry[]>([]);
  const toastSeqRef = React.useRef(0);
  const previousBusyRef = React.useRef<Record<string, boolean>>({});
  const originalTitleRef = React.useRef<string>(
    typeof document !== "undefined" ? document.title : "",
  );
  const titleFlashTimerRef = React.useRef<ReturnType<typeof setInterval> | null>(
    null,
  );
  const titleFlashStopRef = React.useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );

  const messageListRef = React.useRef<HTMLDivElement>(null);
  const shouldStickMessageListToBottomRef = React.useRef(true);
  const previousConversationContextRef = React.useRef<{
    activeTab: MobileTabKey;
    sessionSubView: SessionSubView;
    activeSessionId: string | null;
  } | null>(null);

  // Terminal buffer polling is owned by the controller (it holds the gateway client).
  // App only consumes the resulting buffers + the refresh/markSeen actions.
  const buffers = state.terminalBuffers;
  const markSeen = actions.markTerminalBufferSeen;
  const refresh = actions.refreshTerminalBuffers;

  React.useEffect(() => {
    if (activeTab !== "sessions" || sessionSubView !== "conversation") return;
    const element = messageListRef.current;
    if (!element) return;
    const handleScroll = () => {
      shouldStickMessageListToBottomRef.current = isScrolledNearBottom(element);
    };
    handleScroll();
    element.addEventListener("scroll", handleScroll, { passive: true });
    return () => {
      element.removeEventListener("scroll", handleScroll);
    };
  }, [activeTab, sessionSubView, state.activeSessionId]);

  React.useEffect(() => {
    const currentContext = {
      activeTab,
      sessionSubView,
      activeSessionId: state.activeSessionId,
    };
    if (activeTab !== "sessions" || sessionSubView !== "conversation") {
      previousConversationContextRef.current = currentContext;
      return;
    }

    const element = messageListRef.current;
    if (!element) {
      previousConversationContextRef.current = currentContext;
      return;
    }

    const previousContext = previousConversationContextRef.current;
    const hasContextChanged =
      !previousContext ||
      previousContext.activeTab !== currentContext.activeTab ||
      previousContext.sessionSubView !== currentContext.sessionSubView ||
      previousContext.activeSessionId !== currentContext.activeSessionId;

    if (hasContextChanged || shouldStickMessageListToBottomRef.current) {
      element.scrollTop = element.scrollHeight;
      shouldStickMessageListToBottomRef.current = true;
    }

    previousConversationContextRef.current = currentContext;
  }, [activeTab, sessionSubView, state.activeSessionId, state.chatTimeline]);

  React.useEffect(() => {
    setDetailTurnId(null);
    setRollbackTarget(null);
  }, [state.activeSessionId]);

  // Task-complete toast + title flash. Fires when a session transitions from busy -> idle.
  React.useEffect(() => {
    if (state.connectionStatus !== "connected") return;
    const previousBusy = previousBusyRef.current;
    const next: Record<string, boolean> = {};
    const completed: Array<{ sessionId: string; title: string }> = [];
    for (const sessionId of state.sessionOrder) {
      const session = state.sessions[sessionId];
      const busy = !!(session?.isBusy || session?.isThinking);
      next[sessionId] = busy;
      const wasBusy = previousBusy[sessionId];
      if (wasBusy === true && !busy) {
        completed.push({
          sessionId,
          title: formatSessionListTitle(
            state.sessionMeta[sessionId]?.title ||
              session?.title ||
              t.app.untitled,
          ),
        });
      }
    }
    previousBusyRef.current = next;
    if (completed.length === 0) return;

    setToasts((current) => {
      const additions: ToastEntry[] = [];
      for (const item of completed) {
        toastSeqRef.current += 1;
        additions.push({
          id: toastSeqRef.current,
          title: t.app.taskCompleted(item.title),
          actionLabel: t.topBar.sessions,
          onAction: () => {
            // Jump the user all the way back to the session list: surface both
            // the Sessions tab and the list sub-view. Without setActiveTab the
            // toast did nothing when the user was on Terminals/Settings.
            setActiveTab("sessions");
            setSessionSubView("sessions");
          },
        });
      }
      return [...current, ...additions].slice(-3);
    });

    if (!titleFlashTimerRef.current && typeof document !== "undefined") {
      const baseTitle = originalTitleRef.current || "GyShell";
      let on = false;
      titleFlashTimerRef.current = setInterval(() => {
        on = !on;
        document.title = on ? `✅ ${t.app.taskCompleted("")}` : baseTitle;
      }, 1200);
      titleFlashStopRef.current = setTimeout(() => {
        if (titleFlashTimerRef.current) {
          clearInterval(titleFlashTimerRef.current);
          titleFlashTimerRef.current = null;
        }
        titleFlashStopRef.current = null;
        document.title = baseTitle;
      }, 8000);
    }
  }, [state.connectionStatus, state.sessionOrder, state.sessions, state.sessionMeta, t.app, t.topBar.sessions]);

  React.useEffect(() => {
    if (toasts.length === 0) return;
    const timer = setTimeout(() => {
      setToasts((current) => current.slice(1));
    }, 6000);
    return () => clearTimeout(timer);
  }, [toasts]);

  React.useEffect(() => {
    return () => {
      if (titleFlashTimerRef.current) {
        clearInterval(titleFlashTimerRef.current);
        titleFlashTimerRef.current = null;
      }
      if (titleFlashStopRef.current) {
        clearTimeout(titleFlashStopRef.current);
        titleFlashStopRef.current = null;
      }
    };
  }, []);

  const dismissToast = React.useCallback((id: number) => {
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  const branchFromMessage = actions.branchFromMessage;

  const handleRollbackConfirm = React.useCallback(async () => {
    if (!rollbackTarget) return;
    const activeSessionId = state.activeSessionId;
    const backendMessageId = rollbackTarget.backendMessageId;
    if (!activeSessionId || !backendMessageId) {
      setRollbackTarget(null);
      return;
    }

    setRollbackPending(true);
    try {
      const ok = await actions.rollbackToMessage(
        activeSessionId,
        backendMessageId,
      );
      if (!ok) return;
      const rollbackContent = String(rollbackTarget.content || "");
      actions.restoreComposerDraft(
        rollbackContent,
        rollbackTarget.metadata?.inputImages || [],
      );
    } finally {
      setRollbackPending(false);
      setRollbackTarget(null);
    }
  }, [actions, rollbackTarget, state.activeSessionId]);

  const handleBranch = React.useCallback(
    async (message: ChatMessage) => {
      if (
        branchPendingRef.current ||
        !message.backendMessageId ||
        !state.activeSessionId
      ) {
        return;
      }
      branchPendingRef.current = true;
      setBranchPending(true);
      try {
        await branchFromMessage(
          state.activeSessionId,
          message.backendMessageId,
        );
      } finally {
        branchPendingRef.current = false;
        setBranchPending(false);
      }
    },
    [branchFromMessage, state.activeSessionId],
  );

  const sessionItems = React.useMemo<SessionBrowserItem[]>(() => {
    return state.sessionOrder.map((sessionId) => {
      const meta = state.sessionMeta[sessionId];
      const session = state.sessions[sessionId];
      const status = state.sessionStatuses[sessionId];
      const tokenPercent = state.sessionTokenPercents[sessionId] ?? null;
      return {
        id: sessionId,
        title: formatSessionListTitle(
          meta?.title || session?.title || t.app.untitled,
        ),
        updatedAt: meta?.updatedAt || Date.now(),
        preview: meta?.lastMessagePreview || "",
        messagesCount: meta?.messagesCount || 0,
        isRunning: !!(session?.isBusy || session?.isThinking),
        status:
          status ?? { kind: "done", label: "" },
        tokenUsagePercent: tokenPercent,
      };
    });
  }, [
    state.sessionMeta,
    state.sessionOrder,
    state.sessions,
    state.sessionStatuses,
    state.sessionTokenPercents,
    t.app.untitled,
  ]);
  const filteredSessionItems = React.useMemo(() => {
    const keyword = sessionSearchQuery.trim().toLowerCase();
    if (!keyword) return sessionItems;
    return sessionItems.filter((item) => {
      const haystack = `${item.title}\n${item.preview}`.toLowerCase();
      return haystack.includes(keyword);
    });
  }, [sessionItems, sessionSearchQuery]);

  const topBarSessionTitle = formatTopBarSessionTitle(
    state.activeSession?.title || t.app.noSession,
  );
  const sessionShortId = state.activeSessionId
    ? state.activeSessionId.slice(0, 8)
    : undefined;
  const canSend =
    state.connectionStatus === "connected" &&
    (state.composerValue.trim().length > 0 || state.composerImages.length > 0);
  const activeSessionLockedProfileId =
    state.activeSession?.lockedProfileId || null;
  const activeDetailTurn = React.useMemo<AgentTimelineItem | null>(() => {
    if (!detailTurnId) return null;
    const turn = state.chatTimeline.find(
      (item) => item.kind === "agent" && item.id === detailTurnId,
    );
    return turn && turn.kind === "agent" ? turn : null;
  }, [detailTurnId, state.chatTimeline]);
  const detailOpen =
    activeTab === "sessions" &&
    sessionSubView === "conversation" &&
    !!activeDetailTurn;

  const handleJumpToApproval = React.useCallback(() => {
    if (!state.firstApprovalSessionId) return;
    void actions.switchSession(state.firstApprovalSessionId).then(() => {
      setSessionSubView("conversation");
      setActiveTab("sessions");
    });
  }, [actions, state.firstApprovalSessionId]);

  const topTitle = (() => {
    if (activeTab === "sessions") {
      return sessionSubView === "sessions"
        ? t.app.chats
        : topBarSessionTitle;
    }
    if (activeTab === "terminals") {
      return t.tabs.terminals;
    }
    if (activeTab === "settings") {
      if (settingsSubPage === "skills") return t.settings.skillsSection;
      if (settingsSubPage === "tools") return t.settings.toolsSection;
      if (settingsSubPage === "agent-profiles")
        return t.settings.agentProfilesSection;
      return t.tabs.settings;
    }
    return t.appName;
  })();

  const showBackOnTopBar =
    (activeTab === "sessions" && sessionSubView === "conversation") ||
    (activeTab === "settings" && settingsSubPage !== "root");

  return (
    <div className="mobile-app-shell">
      <div
        className="mobile-app modern"
        data-view={
          activeTab === "sessions" && sessionSubView === "conversation"
            ? "conversation"
            : "flow"
        }
      >
        <TopBar
          title={topTitle}
          sessionId={
            activeTab === "sessions" && sessionSubView === "conversation"
              ? sessionShortId
              : undefined
          }
          connectionStatus={state.connectionStatus}
          onOpenSessions={() => {
            setSessionSubView("sessions");
          }}
          onBack={
            showBackOnTopBar
              ? () => {
                  if (activeTab === "settings") {
                    setSettingsSubPage("root");
                    return;
                  }
                  setSessionSubView("sessions");
                }
              : undefined
          }
          showSessionMeta={
            activeTab === "sessions" && sessionSubView === "conversation"
          }
          showSessionAction={false}
          desktopActive={state.desktopActive}
        />

        {state.connectionError ? (
          <section className="error-strip-modern">
            {state.connectionError}
          </section>
        ) : null}

        {activeTab === "sessions" ? (
          sessionSubView === "sessions" ? (
            <SessionBrowser
              activeSessionId={state.activeSessionId}
              items={filteredSessionItems}
              searchQuery={sessionSearchQuery}
              onSearchChange={setSessionSearchQuery}
              onCreateSession={async () => {
                await actions.createSession();
                setSessionSearchQuery("");
                setSessionSubView("conversation");
              }}
              onOpenSession={async (sessionId) => {
                await actions.switchSession(sessionId);
                setSessionSubView("conversation");
              }}
              onDeleteSession={async (sessionId) => {
                const target = sessionItems.find((item) => item.id === sessionId);
                const title = target?.title || t.app.untitled;
                if (!window.confirm(t.sessionBrowser.deleteConfirm(title))) {
                  return;
                }
                const deleted = await actions.deleteSession(sessionId);
                if (deleted && state.activeSessionId === sessionId) {
                  setSessionSubView("sessions");
                }
              }}
              pendingApprovalCount={state.pendingApprovalCount}
              onJumpToApproval={handleJumpToApproval}
            />
          ) : (
            <div className="conversation-view">
              <MessageList
                items={state.chatTimeline}
                onAskDecision={actions.replyAsk}
                onOpenDetail={setDetailTurnId}
                onRollback={setRollbackTarget}
                onBranch={handleBranch}
                rollbackDisabled={state.isRunning || rollbackPending}
                branchDisabled={
                  state.isRunning ||
                  rollbackPending ||
                  branchPending ||
                  state.actionPending
                }
                listRef={messageListRef}
              />

              <ComposerBar
                value={state.composerValue}
                cursor={state.composerCursor}
                images={state.composerImages}
                onChange={actions.setComposerValue}
                onCursorChange={actions.setComposerCursor}
                onAttachImages={(files) => void actions.attachImages(files)}
                onRemoveImage={actions.removeComposerImage}
                onClearImages={actions.clearComposerImages}
                onSend={() => void actions.sendMessage()}
                onStop={() => void actions.stopActiveSession()}
                canSend={canSend}
                isRunning={state.isRunning}
                profiles={state.profiles}
                activeProfileId={state.activeProfileId}
                lockedProfileId={activeSessionLockedProfileId}
                tokenUsagePercent={state.tokenUsagePercent}
                onUpdateProfile={(profileId) =>
                  void actions.updateProfile(profileId)
                }
                mentionOptions={state.mentionOptions}
                onPickMention={actions.pickMention}
              />
            </div>
          )
        ) : null}

        {activeTab === "terminals" ? (
          <TerminalPanel
            terminals={state.terminals}
            sshConnections={state.sshConnections}
            buffers={buffers}
            onCreateTerminal={(target) =>
              void actions.createTerminalTab(target)
            }
            onCloseTerminal={(terminalId) =>
              void actions.closeTerminalTab(terminalId)
            }
            onReconnectTerminal={actions.reconnectTerminalTab}
            onRefreshBuffers={refresh}
            onMarkBufferSeen={markSeen}
            onClearReconnectError={actions.clearReconnectError}
            reconnectingId={state.reconnectingTerminalId}
            reconnectError={state.reconnectError}
          />
        ) : null}

        {activeTab === "settings" ? (
          <section className="panel-scroll settings-panel">
            <div className="settings-list-flat">
              {settingsSubPage === "root" ? (
                <>
                  <SettingsPanel
                    gatewayInput={state.gatewayInput}
                    accessTokenInput={state.accessTokenInput}
                    connectionStatus={state.connectionStatus}
                    actionPending={state.actionPending}
                    connectionError={state.connectionError}
                    onGatewayInputChange={actions.setGatewayInput}
                    onAccessTokenInputChange={actions.setAccessTokenInput}
                    onConnect={() => void actions.connectGateway()}
                    onDisconnect={actions.disconnectGateway}
                    locale={locale}
                    onLocaleChange={setLocale}
                    memoryEnabled={state.memoryEnabled}
                    memoryFilePath={state.memoryFilePath}
                    memoryContent={state.memoryContent}
                    onReloadMemory={() => void actions.reloadMemory()}
                  />

                  <SettingsNavCard
                    title={t.settings.skillsSection}
                    hint={t.skills.enabledCount(
                      state.skills.filter((skill) => skill.enabled).length,
                      state.skills.length,
                    )}
                    onClick={() => setSettingsSubPage("skills")}
                  />
                  <SettingsNavCard
                    title={t.settings.toolsSection}
                    hint={t.tools.summary(
                      state.mcpTools.filter((tool) => tool.enabled).length,
                      state.mcpTools.length,
                      state.builtInTools.filter((tool) => tool.enabled).length,
                      state.builtInTools.length,
                    )}
                    onClick={() => setSettingsSubPage("tools")}
                  />
                  <SettingsNavCard
                    title={t.settings.agentProfilesSection}
                    hint={
                      state.agentSettings?.activeProfileId
                        ? (state.agentSettings.profiles.find(
                            (profile) =>
                              profile.id ===
                              state.agentSettings?.activeProfileId,
                          )?.slotNumber
                            ? t.settings.agentProfileSlot(
                                state.agentSettings.profiles.find(
                                  (profile) =>
                                    profile.id ===
                                    state.agentSettings?.activeProfileId,
                                )!.slotNumber,
                              )
                            : t.settings.agentProfileActive)
                        : t.settings.agentProfileUnsaved
                    }
                    onClick={() => setSettingsSubPage("agent-profiles")}
                  />
                </>
              ) : null}

              {settingsSubPage === "skills" ? (
                <SkillsPanel
                  skills={state.skills}
                  connectionStatus={state.connectionStatus}
                  onReload={actions.reloadSkills}
                  onSetSkillEnabled={actions.setSkillEnabled}
                />
              ) : null}

              {settingsSubPage === "tools" ? (
                <ToolsPanel
                  mcpTools={state.mcpTools}
                  builtInTools={state.builtInTools}
                  connectionStatus={state.connectionStatus}
                  onReload={actions.reloadTools}
                  onSetMcpEnabled={actions.setMcpEnabled}
                  onSetBuiltInEnabled={actions.setBuiltInToolEnabled}
                />
              ) : null}

              {settingsSubPage === "agent-profiles" ? (
                <AgentProfilesPanel
                  state={state.agentSettings}
                  loading={state.agentSettingsLoading}
                  error={state.agentSettingsError}
                  saving={state.agentSettingsSaving}
                  onReload={() => void actions.reloadAgentSettings()}
                  onSaveCurrent={actions.saveCurrentAgentSetting}
                  onApply={actions.applyAgentSetting}
                  onDelete={actions.deleteAgentSetting}
                />
              ) : null}
            </div>
          </section>
        ) : null}

        <BottomNav
          activeTab={activeTab}
          onChange={(nextTab) => {
            if (nextTab === "sessions" && activeTab === "sessions") {
              setSessionSubView("sessions");
            }
            if (nextTab !== "settings" && settingsSubPage !== "root") {
              setSettingsSubPage("root");
            }
            setActiveTab(nextTab);
          }}
          sessionsBadge={state.pendingApprovalCount > 0}
        />

        <MessageDetailSheet
          open={detailOpen}
          turn={activeDetailTurn}
          onClose={() => setDetailTurnId(null)}
          onAskDecision={actions.replyAsk}
        />

        <ToastViewport toasts={toasts} onDismiss={dismissToast} />

        {rollbackTarget ? (
          <div className="confirm-overlay" role="presentation">
            <div
              className="confirm-dialog"
              role="dialog"
              aria-modal="true"
              aria-labelledby="rollback-confirm-title"
            >
              <h3 id="rollback-confirm-title">{t.app.rollbackConfirmTitle}</h3>
              <p>{t.app.rollbackConfirmMessage}</p>
              <div className="confirm-dialog-actions">
                <button
                  type="button"
                  className="accent-btn-flat"
                  onClick={() => setRollbackTarget(null)}
                  disabled={rollbackPending}
                >
                  {t.common.cancel}
                </button>
                <button
                  type="button"
                  className="danger-btn-flat"
                  onClick={() => void handleRollbackConfirm()}
                  disabled={rollbackPending}
                >
                  {rollbackPending ? (
                    <>
                      <Loader2 size={14} className="spin" />
                      {t.app.rollingBack}
                    </>
                  ) : (
                    t.app.rollback
                  )}
                </button>
              </div>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
};

interface SettingsNavCardProps {
  title: string;
  hint: string;
  onClick: () => void;
}

const SettingsNavCard: React.FC<SettingsNavCardProps> = ({
  title,
  hint,
  onClick,
}) => {
  return (
    <button
      type="button"
      className="settings-nav-card"
      onClick={onClick}
    >
      <span className="settings-nav-card-title">{title}</span>
      <span className="settings-nav-card-hint">{hint}</span>
    </button>
  );
};
