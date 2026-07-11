import { RGBA, TextAttributes, type KeyBinding } from "@opentui/core";
import {
  render,
  useKeyboard,
  useRenderer,
  useTerminalDimensions,
} from "@opentui/solid";
import {
  createEffect,
  createMemo,
  createSignal,
  For,
  onCleanup,
  Show,
} from "solid-js";
import { createStore, produce } from "solid-js/store";
import {
  shouldReplayUiUpdateAfterSnapshot,
  type GatewayClient,
} from "./gateway-client";
import type {
  ChatMessage,
  GatewayProfileSummary,
  GatewaySessionSnapshot,
  GatewaySessionSummary,
  GatewayTerminalSummary,
  SkillSummary,
  UIUpdateAction,
} from "./protocol";
import {
  applyRenameToUnloadedSession,
  applyUiUpdate,
  applyUiUpdateToUnloadedSession,
  compactMessageSummary,
  createUnloadedRenamedSession,
  createSessionState,
  findLatestPendingAsk,
  reorderSessionIdsByUpdatedAt,
  type SessionState,
} from "./state";

type OverlayType = "welcome" | "command" | "profile" | "session" | "help";

type OverlayOption = {
  key: string;
  title: string;
  subtitle?: string;
  run: () => void | Promise<void>;
};

type SlashOption = {
  command: string;
  description: string;
};

export interface TuiBootstrapData {
  endpoint: string;
  terminals: GatewayTerminalSummary[];
  profiles: GatewayProfileSummary[];
  skills: SkillSummary[];
  activeProfileId: string;
  initialSessionId: string;
  initialSessionTitle: string;
  initialMessages: ChatMessage[];
  initialSessionBusy: boolean;
  initialSessionLockedProfileId: string | null;
  initialSessionUiRevision?: number;
  restoredSessionCount: number;
  recoveredSessions: GatewaySessionSummary[];
}

type SessionMeta = {
  id: string;
  title: string;
  updatedAt: number;
  messagesCount: number;
  lastMessagePreview?: string;
  loaded: boolean;
  uiRevision?: number;
};

type MentionOption = {
  key: string;
  label: string;
  insertText: string;
  description: string;
  token?: string;
};

type MentionContext = {
  start: number;
  end: number;
  query: string;
};

type SlashContext = {
  start: number;
  end: number;
  query: string;
};

const SLASH_COMMANDS: SlashOption[] = [
  { command: "new", description: "Create a new session" },
  { command: "sessions", description: "Open session list" },
  { command: "profile", description: "Select model profile" },
  { command: "stop", description: "Stop current run" },
  { command: "help", description: "Open help panel" },
  { command: "exit", description: "Exit GyShell TUI" },
];

const RUN_SPINNER_FRAMES = ["|", "/", "-", "\\"];
const ACTIVITY_SWEEP_FRAMES = [
  "[=   ]",
  "[ =  ]",
  "[  = ]",
  "[   =]",
  "[  = ]",
  "[ =  ]",
];

const submitKeybindings: KeyBinding[] = [
  { name: "return", action: "submit" },
  { name: "enter", action: "submit" },
  { name: "linefeed", action: "newline" },
  { name: "j", ctrl: true, action: "newline" },
];

const c = (r: number, g: number, b: number) => RGBA.fromInts(r, g, b, 255);

const ui = {
  bg: c(7, 7, 7),
  panel: c(12, 12, 12),
  panel2: c(17, 17, 17),
  panel3: c(24, 24, 24),
  panel4: c(30, 30, 30),
  border: c(88, 88, 88),
  text: c(245, 245, 245),
  muted: c(207, 207, 207),
  subtle: c(181, 181, 181),
  accent: c(255, 255, 255),
  inverseText: c(10, 10, 10),
};

export function runTui(
  client: GatewayClient,
  data: TuiBootstrapData,
): Promise<void> {
  return new Promise<void>((resolve) => {
    render(() => createTuiRoot(client, data, resolve), {
      targetFps: 60,
      gatherStats: false,
      exitOnCtrlC: false,
      useKittyKeyboard: {},
    });
  });
}

export function createTuiRoot(
  client: GatewayClient,
  data: TuiBootstrapData,
  onExit: () => void,
) {
  return <TuiApp client={client} data={data} onExit={onExit} />;
}

function TuiApp(props: {
  client: GatewayClient;
  data: TuiBootstrapData;
  onExit: () => void;
}) {
  const renderer = useRenderer();
  const dimensions = useTerminalDimensions();
  const initialSession = hydrateInitialSession(props.data);
  const boot = buildBootState(props.data, initialSession);

  const [state, setState] = createStore<{
    endpoint: string;
    terminals: GatewayTerminalSummary[];
    profiles: GatewayProfileSummary[];
    activeProfileId: string;
    sessionOrder: string[];
    sessions: Record<string, SessionState>;
    sessionMeta: Record<string, SessionMeta>;
    activeSessionId: string;
    skills: SkillSummary[];
    input: string;
    suggestionIndex: number;
    overlay: { type: OverlayType; index: number } | null;
    pending: boolean;
    statusLine: string;
  }>({
    endpoint: props.data.endpoint,
    terminals: props.data.terminals,
    profiles: props.data.profiles,
    activeProfileId: props.data.activeProfileId,
    sessionOrder: boot.sessionOrder,
    sessions: boot.sessions,
    sessionMeta: boot.sessionMeta,
    activeSessionId: props.data.initialSessionId,
    skills: props.data.skills.filter((item) => item.enabled !== false),
    input: "",
    suggestionIndex: 0,
    overlay: null,
    pending: false,
    statusLine: `Connected ${props.data.endpoint}`,
  });

  let inputRef: any;
  let scrollRef: any;
  let overlayScrollRef: any;
  const sessionLoadUpdateBuffers = new Map<string, UIUpdateAction[]>();
  const sessionLoadPromises = new Map<string, Promise<void>>();

  const activeSession = createMemo(() => state.sessions[state.activeSessionId]);

  const visibleMessages = createMemo(() => {
    const session = activeSession();
    if (!session) return [] as ChatMessage[];
    return session.messages.filter((item) => item.type !== "tokens_count");
  });

  const renderedMessages = createMemo(() => {
    const messages = visibleMessages();
    if (!messages.length) return messages;
    const lastIndex = messages.length - 1;
    return messages.filter((message, index) => {
      if (message.type === "reasoning" || message.type === "compaction") {
        return message.streaming === true || index === lastIndex;
      }
      return true;
    });
  });

  const pendingAsk = createMemo(() => {
    const session = activeSession();
    if (!session) return undefined;
    return findLatestPendingAsk(session);
  });

  const mentionContext = createMemo(() => {
    const reactiveInput = state.input;
    void reactiveInput;
    const cursor = getInputCursorOffset();
    if (inputRef) {
      const head = inputRef.getTextRange(0, cursor);
      return parseMentionContextFromHead(head, cursor);
    }
    const text = state.input;
    return parseMentionContext(text, cursor || text.length);
  });

  const mentionOptions = createMemo(() => {
    const context = mentionContext();
    if (!context) return [] as MentionOption[];

    const query = context.query.toLowerCase();

    const skillMatches = state.skills
      .filter((item) => item.enabled !== false)
      .filter((item) =>
        matchQuery(query, `${item.name} ${item.description ?? ""}`),
      )
      .map((item) => ({
        key: `skill:${item.name}`,
        label: `@${item.name}`,
        insertText: `@${item.name}`,
        description: item.description || "Skill",
        token: `[MENTION_SKILL:#${item.name}#]`,
      }));

    const terminalAliases = buildTerminalMentionAliases(state.terminals);
    const terminalMatches = terminalAliases.filter((item) => {
      return matchQuery(query, `${item.label} ${item.description}`);
    });

    return [...skillMatches, ...terminalMatches].slice(0, 6);
  });

  const slashContext = createMemo(() => {
    const reactiveInput = state.input;
    void reactiveInput;
    const cursor = getInputCursorOffset();
    if (inputRef) {
      const head = inputRef.getTextRange(0, cursor);
      return parseSlashContextFromHead(head, cursor);
    }
    const text = state.input;
    return parseSlashContext(text, cursor || text.length);
  });

  const slashOptions = createMemo(() => {
    const context = slashContext();
    if (!context) return [] as SlashOption[];

    const currentText = getInputText();
    if (parseStandaloneSlashCommand(currentText)) return [] as SlashOption[];

    const starts = SLASH_COMMANDS.filter((item) =>
      item.command.startsWith(context.query),
    );
    const includes = SLASH_COMMANDS.filter(
      (item) =>
        !item.command.startsWith(context.query) &&
        item.command.includes(context.query),
    );

    return [...starts, ...includes].slice(0, 6);
  });

  const suggestionKind = createMemo<"mention" | "slash" | null>(() => {
    if (mentionOptions().length > 0) return "mention";
    if (slashOptions().length > 0) return "slash";
    return null;
  });

  createEffect(() => {
    const kind = suggestionKind();
    if (!kind) {
      setState("suggestionIndex", 0);
      return;
    }

    const size =
      kind === "mention" ? mentionOptions().length : slashOptions().length;
    if (size === 0) {
      setState("suggestionIndex", 0);
      return;
    }

    if (state.suggestionIndex >= size) {
      setState("suggestionIndex", 0);
    }
  });

  const commandOptions = createMemo<OverlayOption[]>(() => {
    const session = activeSession();
    return [
      {
        key: "new",
        title: "New session",
        subtitle: "Create and switch",
        run: () => {
          void createNewSession();
        },
      },
      {
        key: "sessions",
        title: "Switch session",
        subtitle: "Browse recovered sessions",
        run: () => openOverlay("session"),
      },
      {
        key: "profile",
        title: "Switch profile",
        subtitle: "Change active model profile",
        run: () => openOverlay("profile"),
      },
      {
        key: "stop",
        title: "Stop run",
        subtitle: "Send stop to backend",
        run: () => {
          if (!session) return;
          void stopSession(session.id);
        },
      },
      {
        key: "help",
        title: "Help",
        subtitle: "Show shortcuts and commands",
        run: () => openOverlay("help"),
      },
      {
        key: "exit",
        title: "Exit",
        subtitle: "Close TUI client",
        run: () => exitApp(),
      },
    ];
  });

  const overlayOptions = createMemo<OverlayOption[]>(() => {
    const overlay = state.overlay;
    if (!overlay) return [];

    if (overlay.type === "welcome") {
      return [
        {
          key: "resume",
          title: "Resume current session",
          subtitle: `${state.sessionMeta[state.activeSessionId]?.title ?? "Current session"}`,
          run: () => closeOverlay(),
        },
        {
          key: "new",
          title: "Start new session",
          subtitle: "Create and switch",
          run: () => {
            void createNewSession();
          },
        },
        {
          key: "browse",
          title: "Browse recovered sessions",
          subtitle: `${state.sessionOrder.length} available`,
          run: () => openOverlay("session"),
        },
      ];
    }

    if (overlay.type === "command") return commandOptions();

    if (overlay.type === "profile") {
      return state.profiles.map((profile) => ({
        key: profile.id,
        title: profile.name,
        subtitle: profile.modelName ?? profile.globalModelId,
        run: () => {
          void switchProfile(profile.id);
        },
      }));
    }

    if (overlay.type === "session") {
      return state.sessionOrder.map((sessionId) => {
        const meta = state.sessionMeta[sessionId];
        return {
          key: sessionId,
          title: `${truncateLine(normalizeOutputText(meta?.title || sessionId), 20)} (${shortId(sessionId)})`,
          subtitle: composeSessionSubtitle(meta),
          run: () => {
            void switchSession(sessionId);
          },
        };
      });
    }

    return [
      {
        key: "close",
        title: "Back to chat",
        run: () => closeOverlay(),
      },
    ];
  });

  const applyLiveUpdate = (update: UIUpdateAction): void => {
    setState(
      produce((draft) => {
        const current = draft.sessions[update.sessionId];
        const installedRevision =
          draft.sessionMeta[update.sessionId]?.uiRevision;
        if (
          typeof update.uiRevision === "number" &&
          Number.isFinite(update.uiRevision) &&
          typeof installedRevision === "number" &&
          Number.isFinite(installedRevision) &&
          update.uiRevision <= installedRevision
        ) {
          return;
        }
        if (update.type === "SESSION_RENAMED") {
          const meta = draft.sessionMeta[update.sessionId];
          if (
            applyRenameToUnloadedSession(
              current,
              meta,
              update.title,
              Date.now(),
            )
          ) {
            if (
              typeof update.uiRevision === "number" &&
              Number.isFinite(update.uiRevision)
            ) {
              meta!.uiRevision = update.uiRevision;
            }
            const nextOrder = reorderSessionIdsByUpdatedAt(
              draft.sessionOrder,
              draft.sessionMeta,
            );
            draft.sessionOrder.splice(
              0,
              draft.sessionOrder.length,
              ...nextOrder,
            );
            return;
          }
          if (!meta) {
            const created = createUnloadedRenamedSession(
              update.sessionId,
              update.title,
              Date.now(),
              current,
            );
            draft.sessions[update.sessionId] = created.session;
            draft.sessionMeta[update.sessionId] = {
              ...created.meta,
              uiRevision: update.uiRevision,
            };
            if (!draft.sessionOrder.includes(update.sessionId)) {
              draft.sessionOrder.unshift(update.sessionId);
            }
            return;
          }
        }
        if (!current) {
          draft.sessions[update.sessionId] = createSessionState(
            update.sessionId,
            "New Chat",
          );
          if (!draft.sessionOrder.includes(update.sessionId)) {
            draft.sessionOrder.unshift(update.sessionId);
          }
          draft.sessionMeta[update.sessionId] = {
            id: update.sessionId,
            title: "New Chat",
            updatedAt: Date.now(),
            messagesCount: 0,
            loaded: false,
            uiRevision: update.uiRevision,
          };
        }

        const session = draft.sessions[update.sessionId];
        if (!session) return;
        const meta = draft.sessionMeta[update.sessionId];
        if (meta && !meta.loaded) {
          applyUiUpdateToUnloadedSession(session, meta, update, Date.now());
          const nextOrder = reorderSessionIdsByUpdatedAt(
            draft.sessionOrder,
            draft.sessionMeta,
          );
          draft.sessionOrder.splice(
            0,
            draft.sessionOrder.length,
            ...nextOrder,
          );
          return;
        }

        applyUiUpdate(session, update);
        if (meta) {
          meta.title = session.title;
          meta.updatedAt = Date.now();
          meta.messagesCount = session.messages.length;
          meta.lastMessagePreview = previewFromSession(session);
          meta.loaded = true;
          if (
            typeof update.uiRevision === "number" &&
            Number.isFinite(update.uiRevision)
          ) {
            meta.uiRevision = update.uiRevision;
          }
        }
        if (update.type === "SESSION_RENAMED") {
          const nextOrder = reorderSessionIdsByUpdatedAt(
            draft.sessionOrder,
            draft.sessionMeta,
          );
          draft.sessionOrder.splice(
            0,
            draft.sessionOrder.length,
            ...nextOrder,
          );
        }
      }),
    );
  };

  const unsubscribeUi = props.client.on("uiUpdate", (update) => {
    const loadBuffer = sessionLoadUpdateBuffers.get(update.sessionId);
    if (loadBuffer) {
      loadBuffer.push(update);
      return;
    }
    applyLiveUpdate(update);
  });

  const unsubscribeRaw = props.client.on("raw", (channel, payload) => {
    if (channel === "terminal:tabs") {
      const terminals =
        payload &&
        typeof payload === "object" &&
        "terminals" in payload &&
        Array.isArray((payload as { terminals?: unknown[] }).terminals)
          ? (payload as { terminals: GatewayTerminalSummary[] }).terminals || []
          : [];
      setState("terminals", terminals);
      setState("statusLine", `Terminal tabs updated (${terminals.length})`);
      return;
    }

    if (channel === "skills:updated" && Array.isArray(payload)) {
      const next: SkillSummary[] = payload.flatMap((item) => {
        if (!item || typeof item !== "object") return [];
        const name =
          "name" in item && typeof item.name === "string" ? item.name : null;
        if (!name) return [];
        const description =
          "description" in item && typeof item.description === "string"
            ? item.description
            : undefined;
        const enabled = !("enabled" in item) || item.enabled !== false;
        return [{ name, description, enabled }];
      });
      setState(
        "skills",
        next.filter((item) => item.enabled !== false),
      );
      setState("statusLine", `Skills updated (${next.length})`);
      return;
    }

    if (channel === "tools:mcpUpdated") {
      setState("statusLine", "MCP status updated");
      return;
    }

    if (channel === "tools:builtInUpdated") {
      setState("statusLine", "Built-in tools updated");
      return;
    }

    if (channel === "settings:updated") {
      const profilesPayload = readProfilesFromSettings(payload);
      setState("profiles", profilesPayload.profiles);
      setState("activeProfileId", profilesPayload.activeProfileId);
      setState(
        "statusLine",
        `Settings updated (${lookupProfileName(
          profilesPayload.activeProfileId,
          profilesPayload.profiles,
        )})`,
      );
      return;
    }

    if (channel === "settings:commandPolicyListsUpdated") {
      const counts = countCommandPolicyRules(payload);
      setState(
        "statusLine",
        `Command policy updated (${counts.allow}/${counts.deny}/${counts.ask})`,
      );
      return;
    }

    if (channel === "memory:updated") {
      setState("statusLine", "Memory updated");
    }
  });

  const unsubscribeEvent = props.client.on("gatewayEvent", (event) => {
    if (event.type === "system:notification") {
      setState("statusLine", `System ${safeText(event.payload)}`);
    }
  });

  const unsubscribeClose = props.client.on("close", (code, reason) => {
    setState("statusLine", `Disconnected (${code}) ${reason}`);
  });

  const unsubscribeError = props.client.on("error", (error) => {
    setState("statusLine", `Gateway error ${error.message}`);
  });

  onCleanup(() => {
    unsubscribeUi();
    unsubscribeRaw();
    unsubscribeEvent();
    unsubscribeClose();
    unsubscribeError();
  });

  createEffect(() => {
    const overlayOpen = !!state.overlay;
    const sessionId = state.activeSessionId;
    void sessionId;
    if (overlayOpen) return;

    queueMicrotask(() => {
      if (!inputRef) return;
      if (inputRef.focused) return;
      inputRef.focus();
    });
  });

  createEffect(() => {
    const sessionId = state.activeSessionId;
    void sessionId;
    queueMicrotask(() => {
      if (!scrollRef) return;
      try {
        scrollRef.scrollTo(scrollRef.scrollHeight);
      } catch {
        // Keep rendering when scroll handle is unavailable.
      }
    });
  });

  useKeyboard((event) => {
    const keyName = String(event.name || "").toLowerCase();
    const keySequence = String(
      (event as unknown as { sequence?: string }).sequence || "",
    );

    if (
      !state.overlay &&
      inputRef &&
      !inputRef.focused &&
      isPasteShortcut(
        event as { name?: string; ctrl?: boolean; meta?: boolean },
      )
    ) {
      event.preventDefault();
      inputRef.focus();
      void pasteClipboardIntoInput();
      return;
    }

    if (
      !state.overlay &&
      inputRef &&
      inputRef.focused &&
      !event.ctrl &&
      !event.meta &&
      !event.super
    ) {
      queueMicrotask(() => syncInputStateFromRef(false));
    }

    if (
      !state.overlay &&
      inputRef &&
      !inputRef.focused &&
      !event.ctrl &&
      !event.meta &&
      !event.super
    ) {
      inputRef.focus();
      setState("statusLine", "Input focus recovered");

      if (keyName === "return" || keyName === "enter") {
        event.preventDefault();
        void submitInput();
        return;
      }

      if (keySequence.length === 1) {
        event.preventDefault();
        inputRef.insertText(keySequence);
        setState("input", inputRef.plainText);
        setState("suggestionIndex", 0);
        return;
      }
    }

    const activeSuggestionKind = !state.overlay ? suggestionKind() : null;
    if (activeSuggestionKind) {
      const options =
        activeSuggestionKind === "mention" ? mentionOptions() : slashOptions();
      if (options.length > 0) {
        if (keyName === "down" || keyName === "arrowdown") {
          event.preventDefault();
          setState("suggestionIndex", (value) => (value + 1) % options.length);
          return;
        }

        if (keyName === "up" || keyName === "arrowup") {
          event.preventDefault();
          setState(
            "suggestionIndex",
            (value) => (value - 1 + options.length) % options.length,
          );
          return;
        }

        if (keyName === "escape") {
          event.preventDefault();
          setState("suggestionIndex", 0);
          return;
        }

        if (keyName === "tab" || keyName === "return" || keyName === "enter") {
          event.preventDefault();
          if (activeSuggestionKind === "mention") {
            insertMention(mentionOptions()[state.suggestionIndex]);
          } else {
            insertSlash(slashOptions()[state.suggestionIndex]);
          }
          return;
        }
      }
    }

    if (event.ctrl && event.name === "c") {
      event.preventDefault();
      exitApp();
      return;
    }

    if (event.ctrl && event.name === "k") {
      event.preventDefault();
      openOverlay("command");
      return;
    }

    if (event.ctrl && event.name === "n") {
      event.preventDefault();
      void createNewSession();
      return;
    }

    if (event.ctrl && event.name === "l") {
      event.preventDefault();
      openOverlay("session");
      return;
    }

    const ask = pendingAsk();
    if (!state.overlay && ask) {
      if (event.name === "a") {
        event.preventDefault();
        void resolveAsk(ask, "allow");
        return;
      }
      if (event.name === "d") {
        event.preventDefault();
        void resolveAsk(ask, "deny");
        return;
      }
    }

    if (!state.overlay) return;

    if (event.name === "escape") {
      event.preventDefault();
      closeOverlay();
      return;
    }

    if (event.name === "up" || event.name === "k") {
      event.preventDefault();
      moveOverlayIndex(-1);
      return;
    }

    if (event.name === "down" || event.name === "j") {
      event.preventDefault();
      moveOverlayIndex(1);
      return;
    }

    if (event.name === "return") {
      event.preventDefault();
      void selectOverlayOption();
    }
  });

  function openOverlay(type: OverlayType): void {
    const initialIndex =
      type === "session"
        ? Math.max(
            0,
            state.sessionOrder.findIndex(
              (sessionId) => sessionId === state.activeSessionId,
            ),
          )
        : 0;
    setState("overlay", {
      type,
      index: initialIndex,
    });
    queueMicrotask(() => {
      if (!overlayScrollRef) return;
      overlayScrollRef.scrollTo(initialIndex);
    });
  }

  function closeOverlay(): void {
    setState("overlay", null);
    queueMicrotask(() => {
      if (!inputRef) return;
      inputRef.focus();
    });
  }

  function moveOverlayIndex(direction: number): void {
    const options = overlayOptions();
    if (!options.length) return;

    let nextIndex = 0;
    setState(
      produce((draft) => {
        if (!draft.overlay) return;
        let next = draft.overlay.index + direction;
        if (next < 0) next = options.length - 1;
        if (next >= options.length) next = 0;
        draft.overlay.index = next;
        nextIndex = next;
      }),
    );

    queueMicrotask(() => {
      if (!overlayScrollRef) return;
      try {
        overlayScrollRef.scrollTo(nextIndex);
      } catch {
        // Ignore overlay scroll update failure.
      }
    });
  }

  async function selectOverlayOption(): Promise<void> {
    const overlay = state.overlay;
    if (!overlay) return;
    const options = overlayOptions();
    const selected = options[overlay.index];
    if (!selected) return;
    await selected.run();
  }

  function handleInputContentChange(): void {
    syncInputStateFromRef(true);
  }

  async function handleInputKeyDown(event: {
    name: string;
    ctrl?: boolean;
    meta?: boolean;
    preventDefault: () => void;
  }): Promise<void> {
    if (state.overlay) return;
    queueMicrotask(() => syncInputStateFromRef(false));

    const keyName = String(event.name || "").toLowerCase();
    if (isPasteShortcut(event)) {
      event.preventDefault();
      await pasteClipboardIntoInput();
      return;
    }

    const kind = suggestionKind();
    if (!kind) {
      if (keyName === "/" && inputRef && inputRef.cursorOffset === 0) {
        queueMicrotask(() => {
          syncInputStateFromRef(false);
          setState("suggestionIndex", 0);
        });
        return;
      }
      if (keyName === "@") {
        queueMicrotask(() => {
          syncInputStateFromRef(false);
          setState("suggestionIndex", 0);
        });
        return;
      }
      if (keyName === "return" || keyName === "enter") {
        event.preventDefault();
        void submitInput();
      }
      return;
    }
    return;
  }

  function insertMention(option: MentionOption | undefined): void {
    if (!option || !inputRef) return;
    const context = getMentionContextAtCursor();
    if (!context) return;
    replaceInputRange(context.start, context.end, `${option.insertText} `);
  }

  function insertSlash(option: SlashOption | undefined): void {
    if (!option || !inputRef) return;
    const context = getSlashContextAtCursor();
    if (!context) return;
    replaceInputRange(context.start, context.end, `/${option.command}`);
  }

  async function submitInput(): Promise<void> {
    if (state.overlay) return;
    if (tryHandleBackslashLineContinuation()) return;

    const text = getInputText().trim();
    if (!text) return;

    const standaloneSlash = parseStandaloneSlashCommand(text);
    if (standaloneSlash) {
      clearInput();
      await runSlashCommand(`/${standaloneSlash}`);
      return;
    }

    const session = activeSession();
    if (!session) {
      setState("statusLine", "No active session available");
      return;
    }

    clearInput();

    const encodedText = encodeMentions(text, state.skills, state.terminals);
    setState(
      produce((draft) => {
        const current = draft.sessions[session.id];
        if (!current) return;
        current.isThinking = true;
        current.isBusy = true;
        current.lockedProfileId = draft.activeProfileId || null;
      }),
    );

    void props.client
      .request("agent:startTaskAsync", {
        sessionId: session.id,
        userText: encodedText,
        options: {
          startMode: session.isBusy ? "inserted" : "normal",
        },
      })
      .catch((error) => {
        setState(
          produce((draft) => {
            const current = draft.sessions[session.id];
            if (!current) return;
            current.isThinking = false;
            current.isBusy = false;
          }),
        );
        setState("statusLine", `Failed to send prompt ${safeError(error)}`);
      });
  }

  async function runSlashCommand(raw: string): Promise<void> {
    const [command] = raw.slice(1).split(/\s+/);

    if (command === "new") {
      await createNewSession();
      return;
    }

    if (command === "session" || command === "sessions") {
      openOverlay("session");
      return;
    }

    if (command === "profile") {
      openOverlay("profile");
      return;
    }

    if (command === "help") {
      openOverlay("help");
      return;
    }

    if (command === "stop") {
      const session = activeSession();
      if (session) await stopSession(session.id);
      return;
    }

    if (command === "exit") {
      exitApp();
      return;
    }

    setState("statusLine", `Unknown slash command /${command}`);
  }

  function clearInput(): void {
    setState("input", "");
    setState("suggestionIndex", 0);
    if (inputRef) {
      inputRef.clear();
      inputRef.focus();
    }
  }

  function getInputText(): string {
    if (inputRef) return inputRef.plainText;
    return state.input;
  }

  function tryHandleBackslashLineContinuation(): boolean {
    const text = getInputText();
    if (!text) return false;
    if (!text.endsWith("\\")) return false;
    const replaceStart = text.length - 1;
    const replaceEnd = text.length;

    if (inputRef) {
      const next = `${text.slice(0, replaceStart)}\n${text.slice(replaceEnd)}`;
      inputRef.replaceText(next);
      if (typeof inputRef.gotoBufferEnd === "function") {
        inputRef.gotoBufferEnd();
      }
      syncInputStateFromRef(true);
      return true;
    }

    const next = `${text.slice(0, replaceStart)}\n`;
    setState("input", next);
    setState("suggestionIndex", 0);
    return true;
  }

  function getInputCursorOffset(): number {
    if (inputRef) return Math.max(0, inputRef.cursorOffset);
    return getInputText().length;
  }

  function getMentionContextAtCursor(): MentionContext | null {
    if (!inputRef)
      return parseMentionContext(getInputText(), getInputCursorOffset());
    const cursor = getInputCursorOffset();
    const head = inputRef.getTextRange(0, cursor);
    return parseMentionContextFromHead(head, cursor);
  }

  function getSlashContextAtCursor(): SlashContext | null {
    if (!inputRef)
      return parseSlashContext(getInputText(), getInputCursorOffset());
    const cursor = getInputCursorOffset();
    const head = inputRef.getTextRange(0, cursor);
    return parseSlashContextFromHead(head, cursor);
  }

  function syncInputStateFromRef(resetSuggestion: boolean): void {
    const next = getInputText();
    if (next !== state.input) {
      setState("input", next);
    }
    if (resetSuggestion) {
      setState("suggestionIndex", 0);
    }
  }

  async function pasteClipboardIntoInput(): Promise<void> {
    if (!inputRef) return;
    const pasted = await readClipboardText();
    if (!pasted) {
      setState("statusLine", "Clipboard is empty or unavailable");
      return;
    }

    const normalized = pasted.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    inputRef.insertText(normalized);
    syncInputStateFromRef(true);
    setState("statusLine", `Pasted ${Math.max(1, normalized.length)} chars`);
  }

  function replaceInputRange(
    startOffset: number,
    endOffset: number,
    replacement: string,
  ): void {
    if (!inputRef) return;

    const safeStart = Math.max(0, Math.min(startOffset, endOffset));
    const safeEnd = Math.max(safeStart, endOffset);

    inputRef.cursorOffset = safeStart;
    const startCursor = inputRef.logicalCursor;
    inputRef.cursorOffset = safeEnd;
    const endCursor = inputRef.logicalCursor;

    inputRef.deleteRange(
      startCursor.row,
      startCursor.col,
      endCursor.row,
      endCursor.col,
    );
    inputRef.insertText(replacement);

    syncInputStateFromRef(true);
  }

  async function createNewSession(): Promise<void> {
    setState("pending", true);
    try {
      const result = await props.client.request<{ sessionId: string }>(
        "gateway:createSession",
        {},
      );
      const sessionId = result.sessionId;

      setState(
        produce((draft) => {
          draft.sessions[sessionId] = createSessionState(sessionId);
          if (!draft.sessionOrder.includes(sessionId)) {
            draft.sessionOrder.unshift(sessionId);
          }
          draft.sessionMeta[sessionId] = {
            id: sessionId,
            title: "New Chat",
            updatedAt: Date.now(),
            messagesCount: 0,
            lastMessagePreview: "",
            loaded: true,
          };
          draft.activeSessionId = sessionId;
        }),
      );

      clearInput();
      setState("statusLine", `Created session ${shortId(sessionId)}`);
      closeOverlay();
    } catch (error) {
      setState("statusLine", `Failed to create session ${safeError(error)}`);
    } finally {
      setState("pending", false);
    }
  }

  async function switchSession(sessionId: string): Promise<void> {
    await ensureSessionLoaded(sessionId);
    setState("activeSessionId", sessionId);
    setState(
      "statusLine",
      `Switched session ${state.sessionMeta[sessionId]?.title || shortId(sessionId)}`,
    );
    closeOverlay();
  }

  async function ensureSessionLoaded(sessionId: string): Promise<void> {
    const inFlight = sessionLoadPromises.get(sessionId);
    if (inFlight) {
      await inFlight;
      return;
    }
    const meta = state.sessionMeta[sessionId];
    if (meta?.loaded) return;

    const bufferedUpdates: UIUpdateAction[] = [];
    sessionLoadUpdateBuffers.set(sessionId, bufferedUpdates);
    const loadPromise = (async () => {
      let snapshotRevision: number | undefined;
      let snapshotInstalled = false;
      try {
        const payload = await props.client.request<{
          session: GatewaySessionSnapshot;
        }>("session:get", { sessionId });
        const snapshot = payload.session;
        snapshotRevision = snapshot.uiRevision;
        setState(
          produce((draft) => {
            const session = createSessionState(
              sessionId,
              snapshot.title || "Recovered Session",
            );
            session.messages = (snapshot.messages || []).map(cloneMessage);
            session.isBusy = snapshot.isBusy === true;
            session.isThinking = snapshot.isBusy === true;
            session.lockedProfileId = snapshot.lockedProfileId || null;
            draft.sessions[sessionId] = session;

            const current = draft.sessionMeta[sessionId];
            draft.sessionMeta[sessionId] = {
              id: sessionId,
              title: snapshot.title || current?.title || "Recovered Session",
              updatedAt: snapshot.updatedAt || current?.updatedAt || Date.now(),
              messagesCount:
                snapshot.messages?.length ?? current?.messagesCount ?? 0,
              lastMessagePreview:
                previewFromSession(session) || current?.lastMessagePreview,
              loaded: true,
              uiRevision: snapshot.uiRevision,
            };
          }),
        );
        snapshotInstalled = true;
      } catch (error) {
        setState(
          "statusLine",
          `Failed to load session ${shortId(sessionId)} ${safeError(error)}`,
        );
      } finally {
        sessionLoadUpdateBuffers.delete(sessionId);
        bufferedUpdates
          .filter(
            (update) =>
              !snapshotInstalled ||
              shouldReplayUiUpdateAfterSnapshot(update, snapshotRevision),
          )
          .forEach(applyLiveUpdate);
      }
    })();
    sessionLoadPromises.set(sessionId, loadPromise);
    try {
      await loadPromise;
    } finally {
      if (sessionLoadPromises.get(sessionId) === loadPromise) {
        sessionLoadPromises.delete(sessionId);
      }
    }
  }

  async function switchProfile(profileId: string): Promise<void> {
    try {
      const result = await props.client.request<{
        activeProfileId: string;
        profiles: GatewayProfileSummary[];
      }>("models:setActiveProfile", { profileId });

      setState("activeProfileId", result.activeProfileId);
      setState("profiles", result.profiles);
      setState(
        "statusLine",
        `Profile ${lookupProfileName(result.activeProfileId, result.profiles)}`,
      );
      closeOverlay();
    } catch (error) {
      setState("statusLine", `Profile switch failed ${safeError(error)}`);
    }
  }

  async function stopSession(sessionId: string): Promise<void> {
    try {
      await props.client.request("agent:stopTask", { sessionId });
      setState("statusLine", "Stop signal sent");
    } catch (error) {
      setState("statusLine", `Stop failed ${safeError(error)}`);
    }
  }

  async function resolveAsk(
    message: ChatMessage,
    decision: "allow" | "deny",
  ): Promise<void> {
    try {
      if (message.metadata?.approvalId) {
        await props.client.request("agent:replyCommandApproval", {
          approvalId: message.metadata.approvalId,
          decision,
        });
      } else {
        await props.client.request("agent:replyMessage", {
          messageId: message.backendMessageId ?? message.id,
          payload: { decision },
        });
      }

      setState(
        produce((draft) => {
          const session = draft.sessions[draft.activeSessionId];
          if (!session) return;
          const target = session.messages.find(
            (item) => item.id === message.id,
          );
          if (!target) return;
          target.metadata = {
            ...(target.metadata ?? {}),
            decision,
          };
        }),
      );
      setState("statusLine", `Decision sent ${decision}`);
    } catch (error) {
      setState("statusLine", `Approval failed ${safeError(error)}`);
    }
  }

  function exitApp(): void {
    props.client.close();
    renderer.destroy();
    props.onExit();
  }

  const selectedProfileName = createMemo(() =>
    lookupProfileName(state.activeProfileId, state.profiles),
  );
  const effectiveProfileName = createMemo(() => {
    const lockedProfileId = activeSession()?.lockedProfileId || null;
    if (!lockedProfileId) return selectedProfileName();
    return lookupProfileName(lockedProfileId, state.profiles);
  });
  const activeSessionShortId = createMemo(() => shortId(state.activeSessionId));
  const activeSessionMeta = createMemo(
    () => state.sessionMeta[state.activeSessionId],
  );
  const runActive = createMemo(() =>
    Boolean(state.pending || activeSession()?.isBusy),
  );
  const [runSpinnerIndex, setRunSpinnerIndex] = createSignal(0);

  createEffect(() => {
    if (!runActive()) return;
    const timer = setInterval(() => {
      setRunSpinnerIndex((value) => (value + 1) % RUN_SPINNER_FRAMES.length);
    }, 120);
    onCleanup(() => clearInterval(timer));
  });

  const suggestionLineWidth = createMemo(() =>
    Math.max(24, dimensions().width - 6),
  );
  const overlayPanelWidth = createMemo(() =>
    Math.max(48, Math.min(100, dimensions().width - 8)),
  );
  const overlayPanelHeight = createMemo(() =>
    Math.max(12, Math.min(28, dimensions().height - 4)),
  );
  const overlayListHeight = createMemo(() =>
    Math.max(6, overlayPanelHeight() - 5),
  );
  const overlayOptionLineWidth = createMemo(() =>
    Math.max(20, Math.min(72, overlayPanelWidth() - 6)),
  );
  const inputMinHeight = createMemo(() => {
    const lines = state.input.split("\n").length;
    return Math.max(1, Math.min(5, lines));
  });
  const headerRightText = createMemo(() => {
    const profile = truncateDisplayWidth(effectiveProfileName(), 24);
    const runLabel = runActive()
      ? `RUN ${RUN_SPINNER_FRAMES[runSpinnerIndex()]}`
      : "IDLE";
    const raw = `${profile} | ${runLabel}`;
    const max = Math.max(10, Math.floor(dimensions().width * 0.45));
    return truncateDisplayWidth(raw, max);
  });
  const headerLeftText = createMemo(() => {
    const base = `GyShell | ${activeSessionMeta()?.title || "Untitled"} (${activeSessionShortId()})`;
    const rightWidth = displayWidth(headerRightText());
    const max = Math.max(14, dimensions().width - rightWidth - 5);
    return truncateDisplayWidth(base, max);
  });

  return (
    <box
      width={dimensions().width}
      height={dimensions().height}
      backgroundColor={ui.bg}
      flexDirection="column"
    >
      <box
        flexDirection="row"
        flexShrink={0}
        backgroundColor={ui.panel}
        border={["bottom"]}
        borderColor={ui.border}
        paddingLeft={1}
        paddingRight={1}
      >
        <text fg={ui.accent} attributes={TextAttributes.BOLD} wrapMode="none">
          {headerLeftText()}
        </text>
        <box flexGrow={1} />
        <text fg={ui.subtle} wrapMode="none">
          {headerRightText()}
        </text>
      </box>

      <For each={[state.activeSessionId]}>
        {() => (
          <scrollbox
            ref={(node) => (scrollRef = node)}
            flexGrow={1}
            paddingLeft={1}
            paddingRight={1}
            paddingTop={0}
            paddingBottom={0}
            backgroundColor={ui.panel2}
            stickyScroll
            stickyStart="bottom"
          >
            <Show when={renderedMessages().length === 0}>
              <box paddingTop={1}>
                <text fg={ui.muted}>No messages yet. Start typing below.</text>
              </box>
            </Show>

            <For each={renderedMessages()}>
              {(message, index) => (
                <box
                  marginTop={showHeader(renderedMessages(), index()) ? 1 : 0}
                  flexDirection="column"
                >
                  <Show when={showHeader(renderedMessages(), index())}>
                    <text fg={ui.muted}>
                      {messageHeaderLabel(message, runSpinnerIndex())}{" "}
                      <span style={{ fg: ui.subtle }}>
                        {formatClock(message.timestamp)}
                      </span>
                    </text>
                  </Show>

                  <For each={messageBodyLines(message)}>
                    {(line) => (
                      <box
                        paddingLeft={1}
                        border={["left"]}
                        borderColor={borderColorForMessage(message)}
                        backgroundColor={ui.panel2}
                      >
                        <text fg={textColorForMessage(message)}>{line}</text>
                      </box>
                    )}
                  </For>
                </box>
              )}
            </For>
          </scrollbox>
        )}
      </For>

      <Show when={pendingAsk()}>
        {(ask) => (
          <box
            flexShrink={0}
            backgroundColor={ui.panel3}
            border={["top", "bottom"]}
            borderColor={ui.border}
            paddingLeft={1}
            paddingRight={1}
          >
            <text fg={ui.accent}>
              PERMISSION{" "}
              <span style={{ fg: ui.text }}>
                {truncateLine(ask().metadata?.command || ask().content, 120)}
              </span>
              <span style={{ fg: ui.muted }}> (A allow / D deny)</span>
            </text>
          </box>
        )}
      </Show>

      <Show when={runActive() && !state.overlay}>
        <box
          flexShrink={0}
          backgroundColor={ui.panel4}
          border={["top"]}
          borderColor={ui.border}
          paddingLeft={1}
          paddingRight={1}
        >
          <text fg={ui.accent}>
            RUN {RUN_SPINNER_FRAMES[runSpinnerIndex()]}{" "}
            <span style={{ fg: ui.muted }}>
              session is active, new messages will be inserted
            </span>
          </text>
        </box>
      </Show>

      <Show when={suggestionKind() && !state.overlay}>
        <box
          flexShrink={0}
          backgroundColor={ui.panel3}
          border={["top"]}
          borderColor={ui.border}
          paddingLeft={1}
          paddingRight={1}
        >
          <For
            each={
              suggestionKind() === "mention" ? mentionOptions() : slashOptions()
            }
          >
            {(option, idx) => (
              <box
                backgroundColor={
                  idx() === state.suggestionIndex ? ui.accent : undefined
                }
              >
                <text
                  fg={
                    idx() === state.suggestionIndex ? ui.inverseText : ui.text
                  }
                >
                  {truncateLine(
                    suggestionKind() === "mention"
                      ? `${idx() === state.suggestionIndex ? ">" : " "} ${(option as MentionOption).label} ${(option as MentionOption).description}`
                      : `${idx() === state.suggestionIndex ? ">" : " "} /${(option as SlashOption).command} ${(option as SlashOption).description}`,
                    suggestionLineWidth(),
                  )}
                </text>
              </box>
            )}
          </For>
        </box>
      </Show>

      <box
        flexShrink={0}
        backgroundColor={ui.panel}
        border={["top"]}
        borderColor={ui.border}
        paddingLeft={1}
        paddingRight={1}
      >
        <textarea
          ref={(node) => {
            inputRef = node;
            node.focus();
          }}
          placeholder="Type prompt. Enter send, Ctrl+J or \\+Enter newline, / commands, @ mentions"
          minHeight={inputMinHeight()}
          maxHeight={5}
          textColor={ui.text}
          focusedTextColor={ui.text}
          focusedBackgroundColor={ui.panel}
          backgroundColor={ui.panel}
          cursorColor={ui.accent}
          keyBindings={submitKeybindings}
          onContentChange={handleInputContentChange}
          onKeyDown={(event) => handleInputKeyDown(event as any)}
          onSubmit={() => {
            void submitInput();
          }}
        />
      </box>

      <box
        flexDirection="row"
        flexShrink={0}
        backgroundColor={ui.panel2}
        border={["top"]}
        borderColor={ui.border}
        paddingLeft={1}
        paddingRight={1}
      >
        <text fg={ui.muted}>
          {truncateLine(
            state.statusLine,
            Math.max(18, dimensions().width - 58),
          )}
        </text>
        <box flexGrow={1} />
        <text fg={ui.subtle}>
          Ctrl+K menu | Ctrl+N new | Ctrl+L sessions | Ctrl+C exit
        </text>
      </box>

      <Show when={state.overlay}>
        {(overlay) => (
          <box
            position="absolute"
            top={1}
            left={0}
            right={0}
            bottom={0}
            alignItems="center"
            backgroundColor={ui.bg}
          >
            <box
              width={overlayPanelWidth()}
              height={overlayPanelHeight()}
              backgroundColor={ui.panel2}
              border={["top", "bottom", "left", "right"]}
              borderColor={ui.border}
              padding={1}
              flexDirection="column"
            >
              <box flexDirection="row">
                <text fg={ui.text} attributes={TextAttributes.BOLD}>
                  {overlayTitle(overlay().type)}
                </text>
                <box flexGrow={1} />
                <text fg={ui.muted}>Esc close</text>
              </box>

              <Show when={overlay().type === "help"}>
                <box paddingTop={1}>
                  <text fg={ui.text}>Shortcuts</text>
                  <text fg={ui.muted}>Ctrl+K command palette</text>
                  <text fg={ui.muted}>Ctrl+N new session</text>
                  <text fg={ui.muted}>Ctrl+L session list</text>
                  <text fg={ui.muted}>Ctrl+C exit</text>
                  <text fg={ui.text}>Input</text>
                  <text fg={ui.muted}>
                    Enter send, Ctrl+J or \+Enter newline
                  </text>
                  <text fg={ui.muted}>
                    Tab/Enter accepts @ or / suggestions
                  </text>
                  <text fg={ui.muted}>A / D respond to permission asks</text>
                </box>
              </Show>

              <Show when={overlay().type !== "help"}>
                <scrollbox
                  ref={(node) => (overlayScrollRef = node)}
                  marginTop={1}
                  height={overlayListHeight()}
                  scrollbarOptions={{ visible: false }}
                >
                  <For each={overlayOptions()}>
                    {(option, idx) => (
                      <box
                        paddingLeft={1}
                        paddingRight={1}
                        height={1}
                        flexShrink={0}
                        backgroundColor={
                          idx() === overlay().index ? ui.accent : undefined
                        }
                      >
                        <text
                          fg={
                            idx() === overlay().index ? ui.inverseText : ui.text
                          }
                          wrapMode="none"
                        >
                          {truncateDisplayWidth(
                            `${idx() === overlay().index ? ">" : " "} ${option.title}${option.subtitle ? ` | ${option.subtitle}` : ""}`,
                            overlayOptionLineWidth(),
                          )}
                        </text>
                      </box>
                    )}
                  </For>
                </scrollbox>
              </Show>
            </box>
          </box>
        )}
      </Show>
    </box>
  );
}

function buildBootState(
  data: TuiBootstrapData,
  initialSession: SessionState,
): {
  sessions: Record<string, SessionState>;
  sessionMeta: Record<string, SessionMeta>;
  sessionOrder: string[];
} {
  const sessions: Record<string, SessionState> = {
    [data.initialSessionId]: initialSession,
  };

  const sessionMeta: Record<string, SessionMeta> = {};
  sessionMeta[data.initialSessionId] = {
    id: data.initialSessionId,
    title: initialSession.title,
    updatedAt: Date.now(),
    messagesCount: initialSession.messages.length,
    lastMessagePreview: previewFromSession(initialSession),
    loaded: true,
    uiRevision: data.initialSessionUiRevision,
  };

  for (const summary of data.recoveredSessions) {
    const existing = sessionMeta[summary.id];
    sessionMeta[summary.id] = {
      id: summary.id,
      title: summary.title || existing?.title || "Recovered Session",
      updatedAt: summary.updatedAt || existing?.updatedAt || Date.now(),
      messagesCount: summary.messagesCount || existing?.messagesCount || 0,
      lastMessagePreview:
        summary.lastMessagePreview || existing?.lastMessagePreview,
      loaded: summary.id === data.initialSessionId,
      uiRevision:
        summary.id === data.initialSessionId
          ? data.initialSessionUiRevision ?? summary.uiRevision
          : summary.uiRevision,
    };

    if (summary.id !== data.initialSessionId) {
      const nextSession = createSessionState(
        summary.id,
        summary.title || "Recovered Session",
      );
      nextSession.isBusy = summary.isBusy === true;
      nextSession.isThinking = summary.isBusy === true;
      nextSession.lockedProfileId = summary.lockedProfileId || null;
      sessions[summary.id] = nextSession;
    }
  }

  const sessionOrder = Object.values(sessionMeta)
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .map((item) => item.id);

  if (!sessionOrder.includes(data.initialSessionId)) {
    sessionOrder.unshift(data.initialSessionId);
  }

  return {
    sessions,
    sessionMeta,
    sessionOrder,
  };
}

function parseMentionContext(
  text: string,
  cursorOffset: number,
): MentionContext | null {
  if (!text) return null;
  const safeOffset = Math.max(0, Math.min(cursorOffset, text.length));
  const head = text.slice(0, safeOffset);
  return parseMentionContextFromHead(head, safeOffset);
}

function parseMentionContextFromHead(
  head: string,
  safeOffset: number,
): MentionContext | null {
  if (!head) return null;

  let cursor = head.length - 1;
  while (cursor >= 0 && isMentionQueryChar(head[cursor])) {
    cursor -= 1;
  }

  if (cursor < 0 || head[cursor] !== "@") return null;
  if (cursor > 0 && isMentionQueryChar(head[cursor - 1])) return null;

  const query = head.slice(cursor + 1);
  const startOffset = Math.max(0, safeOffset - query.length - 1);

  return {
    start: startOffset,
    end: safeOffset,
    query,
  };
}

function parseSlashContext(
  text: string,
  cursorOffset: number,
): SlashContext | null {
  if (!text) return null;
  const safeOffset = Math.max(0, Math.min(cursorOffset, text.length));
  const head = text.slice(0, safeOffset);
  return parseSlashContextFromHead(head, safeOffset);
}

function parseSlashContextFromHead(
  head: string,
  safeOffset: number,
): SlashContext | null {
  if (!head) return null;
  if (!head.startsWith("/")) return null;
  if (head.includes("\n")) return null;
  if (head.includes(" ")) return null;

  return {
    start: 0,
    end: safeOffset,
    query: head.slice(1).toLowerCase(),
  };
}

function matchQuery(query: string, candidate: string): boolean {
  if (!query) return true;
  return candidate.toLowerCase().includes(query);
}

function parseStandaloneSlashCommand(input: string): string | null {
  const raw = String(input || "");
  if (!raw.startsWith("/")) return null;
  if (raw.includes("\n")) return null;
  if (!/^\/[A-Za-z0-9_.-]+$/.test(raw)) return null;
  const command = raw.slice(1).toLowerCase();
  const exists = SLASH_COMMANDS.some(
    (item) => item.command.toLowerCase() === command,
  );
  return exists ? command : null;
}

function isMentionQueryChar(char: string | undefined): boolean {
  if (!char) return false;
  return /[A-Za-z0-9_.:-]/.test(char);
}

function showHeader(messages: ChatMessage[], index: number): boolean {
  const current = messages[index];
  const previous = messages[index - 1];
  if (!current) return true;
  if (!previous) return current.role === "user" || current.type === "text";

  if (current.role !== "user" && current.type !== "text") return false;
  if (previous.role !== "user" && previous.type !== "text") return true;

  const sameRole = current.role === previous.role;
  const sameType = labelForMessage(current) === labelForMessage(previous);
  const closeInTime = Math.abs(current.timestamp - previous.timestamp) < 90_000;
  return !(sameRole && sameType && closeInTime);
}

function labelForMessage(message: ChatMessage): string {
  if (message.role === "user") return "YOU";
  if (message.type === "text") return "AI";
  if (message.type === "error") return "ERR";
  if (message.type === "alert") return "ALERT";
  if (message.type === "ask") return "ASK";
  if (message.type === "command") return "RUN";
  if (message.type === "tool_call") return "TOOL";
  if (message.type === "file_edit") return "PATCH";
  if (message.type === "reasoning") return "THINK";
  if (message.type === "compaction") return "COMPACT";
  if (message.type === "compaction_boundary") return "CTX";
  if (message.type === "sub_tool") return "STEP";
  return "AI";
}

function messageHeaderLabel(message: ChatMessage, frameIndex: number): string {
  const baseLabel = labelForMessage(message);
  if (!isActivityBannerMessage(message)) return baseLabel;
  return `${baseLabel} ${activitySweepFrame(frameIndex)}`;
}

function isActivityBannerMessage(message: ChatMessage): boolean {
  return (
    (message.type === "reasoning" || message.type === "compaction") &&
    message.streaming === true
  );
}

function activitySweepFrame(frameIndex: number): string {
  if (ACTIVITY_SWEEP_FRAMES.length === 0) return "[=]";
  const normalizedIndex =
    ((frameIndex % ACTIVITY_SWEEP_FRAMES.length) +
      ACTIVITY_SWEEP_FRAMES.length) %
    ACTIVITY_SWEEP_FRAMES.length;
  return ACTIVITY_SWEEP_FRAMES[normalizedIndex];
}

function borderColorForMessage(message: ChatMessage): RGBA {
  if (message.role === "user") return ui.accent;
  if (message.type === "error") return ui.accent;
  if (message.type === "alert" || message.type === "ask") return ui.muted;
  return ui.border;
}

function textColorForMessage(message: ChatMessage): RGBA {
  if (
    message.type === "reasoning" ||
    message.type === "compaction" ||
    message.type === "compaction_boundary" ||
    message.type === "sub_tool" ||
    message.type === "tool_call"
  )
    return ui.muted;
  return ui.text;
}

function overlayTitle(type: OverlayType): string {
  if (type === "welcome") return "Welcome Back";
  if (type === "command") return "Command Palette";
  if (type === "profile") return "Model Profiles";
  if (type === "session") return "Sessions";
  return "Help";
}

function lookupProfileName(
  activeId: string,
  profiles: GatewayProfileSummary[],
): string {
  const match = profiles.find((item) => item.id === activeId);
  if (!match) return activeId || "No profile";
  return match.modelName ? `${match.name} (${match.modelName})` : match.name;
}

function readProfilesFromSettings(raw: unknown): {
  profiles: GatewayProfileSummary[];
  activeProfileId: string;
} {
  if (!raw || typeof raw !== "object") {
    return { profiles: [], activeProfileId: "" };
  }
  const models = (raw as Record<string, unknown>).models;
  if (!models || typeof models !== "object") {
    return { profiles: [], activeProfileId: "" };
  }
  const modelRecord = models as Record<string, unknown>;
  const profiles = Array.isArray(modelRecord.profiles)
    ? modelRecord.profiles.flatMap((profile) => {
        if (!profile || typeof profile !== "object") return [];
        const record = profile as Record<string, unknown>;
        if (typeof record.id !== "string" || !record.id) return [];
        if (typeof record.name !== "string") return [];
        return [
          {
            id: record.id,
            name: record.name,
            globalModelId:
              typeof record.globalModelId === "string"
                ? record.globalModelId
                : "",
          },
        ];
      })
    : [];
  return {
    profiles,
    activeProfileId:
      typeof modelRecord.activeProfileId === "string"
        ? modelRecord.activeProfileId
        : "",
  };
}

function countCommandPolicyRules(raw: unknown): {
  allow: number;
  deny: number;
  ask: number;
} {
  const source =
    raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  return {
    allow: Array.isArray(source.allowlist) ? source.allowlist.length : 0,
    deny: Array.isArray(source.denylist) ? source.denylist.length : 0,
    ask: Array.isArray(source.asklist) ? source.asklist.length : 0,
  };
}

function composeSessionSubtitle(meta: SessionMeta | undefined): string {
  if (!meta) return "No metadata";
  const flags = [
    `${meta.messagesCount} msgs`,
    formatShortDate(meta.updatedAt),
    meta.loaded ? "cached" : "load on open",
  ];
  return flags.join(" | ");
}

function formatShortDate(timestamp: number): string {
  if (!Number.isFinite(timestamp) || timestamp <= 0) return "unknown time";
  const date = new Date(timestamp);
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hh = String(date.getHours()).padStart(2, "0");
  const mm = String(date.getMinutes()).padStart(2, "0");
  return `${month}-${day} ${hh}:${mm}`;
}

function formatClock(timestamp: number): string {
  if (!Number.isFinite(timestamp) || timestamp <= 0) return "--:--";
  const date = new Date(timestamp);
  const hh = String(date.getHours()).padStart(2, "0");
  const mm = String(date.getMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}

function truncateLine(input: string, max: number): string {
  const normalized = String(input || "")
    .replace(/\s+/g, " ")
    .trim();
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, max - 1)}...`;
}

function displayWidth(input: string): number {
  const normalized = String(input || "");
  const bun = globalThis as unknown as {
    Bun?: { stringWidth?: (value: string) => number };
  };
  const width = bun.Bun?.stringWidth;
  if (typeof width === "function") return width(normalized);
  return normalized.length;
}

function truncateDisplayWidth(input: string, max: number): string {
  const normalized = String(input || "")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) return "";
  if (max <= 0) return "";
  if (displayWidth(normalized) <= max) return normalized;

  const ellipsis = "...";
  const target = Math.max(1, max - displayWidth(ellipsis));
  let output = "";
  for (const char of normalized) {
    const next = `${output}${char}`;
    if (displayWidth(next) > target) break;
    output = next;
  }
  return `${output}${ellipsis}`;
}

function shortId(input: string): string {
  if (!input) return "unknown";
  if (input.length <= 10) return input;
  return `${input.slice(0, 4)}...${input.slice(-4)}`;
}

function isPasteShortcut(event: {
  name?: string;
  ctrl?: boolean;
  meta?: boolean;
}): boolean {
  const keyName = String(event.name || "").toLowerCase();
  if (keyName !== "v") return false;
  return event.ctrl === true || event.meta === true;
}

async function readClipboardText(): Promise<string | null> {
  const testValue = process.env.GYSHELL_TUI_TEST_CLIPBOARD;
  if (typeof testValue === "string" && testValue.length > 0) return testValue;

  const bunGlobal = globalThis as unknown as {
    Bun?: {
      which?: (binary: string) => string | null;
      spawnSync?: (options: {
        cmd: string[];
        stdout?: "pipe" | "inherit" | "ignore";
        stderr?: "pipe" | "inherit" | "ignore";
      }) => { success: boolean; stdout: Uint8Array };
    };
  };

  const bunApi = bunGlobal.Bun;
  if (!bunApi?.spawnSync || !bunApi.which) return null;

  const tryRead = (cmd: string[]): string | null => {
    if (!bunApi.which!(cmd[0])) return null;
    try {
      const result = bunApi.spawnSync!({
        cmd,
        stdout: "pipe",
        stderr: "ignore",
      });
      if (!result.success) return null;
      const text = Buffer.from(result.stdout).toString("utf8");
      if (!text) return null;
      return text;
    } catch {
      return null;
    }
  };

  const platform = process.platform;
  if (platform === "darwin") {
    return tryRead(["pbpaste"]);
  }

  if (platform === "win32") {
    return tryRead([
      "powershell",
      "-NoProfile",
      "-Command",
      "Get-Clipboard -Raw",
    ]);
  }

  return (
    tryRead(["wl-paste", "-n"]) ||
    tryRead(["xclip", "-selection", "clipboard", "-o"])
  );
}

function safeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function safeText(payload: unknown): string {
  if (typeof payload === "string") return payload;
  if (payload && typeof payload === "object") return JSON.stringify(payload);
  return String(payload);
}

function hydrateInitialSession(data: TuiBootstrapData): SessionState {
  const session = createSessionState(
    data.initialSessionId,
    data.initialSessionTitle || "New Chat",
  );
  session.messages = data.initialMessages.map(cloneMessage);
  session.isThinking = data.initialSessionBusy === true;
  session.isBusy = data.initialSessionBusy === true;
  session.lockedProfileId = data.initialSessionLockedProfileId || null;
  return session;
}

function cloneMessage(message: ChatMessage): ChatMessage {
  return {
    ...message,
    metadata: message.metadata ? { ...message.metadata } : undefined,
  };
}

function previewFromSession(session: SessionState): string {
  const latestVisible = [...session.messages]
    .reverse()
    .find((msg) => msg.type !== "tokens_count");
  if (!latestVisible) return "";
  return truncateLine(messagePrimaryText(latestVisible), 120);
}

function messageBodyLines(message: ChatMessage): string[] {
  if (message.type === "text") {
    return markdownToLines(message.content);
  }

  if (message.type === "command") {
    const command = normalizeOutputText(
      message.metadata?.command || message.content,
    );
    const output = normalizeOutputText(message.metadata?.output ?? "");
    const commandTag = message.metadata?.isNowait ? "RUN ASYNC" : "RUN";
    const lines = [
      `[${commandTag}] ${truncateLine(command || "(empty command)", 160)}`,
    ];
    const summary = summarizeTerminalOutput(output);
    if (summary) {
      lines.push(`  ${truncateLine(summary, 160)}`);
    }
    if (typeof message.metadata?.exitCode === "number") {
      lines.push(`  exit ${message.metadata.exitCode}`);
    }
    return lines;
  }

  if (message.type === "tool_call") {
    const toolName = message.metadata?.toolName || "tool";
    const toolTag = toolTagForName(toolName);
    const summary = summarizeToolCall(message);
    return [`[${toolTag}] ${truncateLine(summary, 160)}`];
  }

  if (message.type === "file_edit") {
    const action = message.metadata?.action || "edited";
    const file = message.metadata?.filePath || "unknown file";
    const stats = summarizeDiff(message.metadata?.diff ?? "");
    return [
      `[PATCH] ${action} ${truncateLine(file, 120)}${stats ? ` ${stats}` : ""}`,
    ];
  }

  if (message.type === "reasoning") {
    const detail = normalizeOutputText(message.content);
    if (!detail) return ["[THINK] thinking..."];
    const summary = detail.replace(/^\[thinking\]\s*/i, "");
    return [`[THINK] ${truncateLine(summary || "thinking...", 180)}`];
  }

  if (message.type === "compaction") {
    const title = message.metadata?.subToolTitle || "compaction";
    const output = normalizeOutputText(
      message.metadata?.output ?? message.content,
    );
    const summary = summarizeTerminalOutput(output);
    if (summary)
      return [`[COMPACT] ${truncateLine(`${title} | ${summary}`, 180)}`];
    if (output) return [`[COMPACT] ${truncateLine(output, 180)}`];
    return [`[COMPACT] ${title}`];
  }

  if (message.type === "compaction_boundary") {
    return ["[CTX COMPACTED]"];
  }

  if (message.type === "sub_tool") {
    const title = message.metadata?.subToolTitle || "sub tool";
    const hint = message.metadata?.subToolHint
      ? ` (${message.metadata.subToolHint})`
      : "";
    const output = normalizeOutputText(message.metadata?.output ?? "");
    const summary = summarizeTerminalOutput(output);
    if (summary)
      return [`[STEP] ${truncateLine(`${title}${hint} | ${summary}`, 180)}`];
    return [`[STEP] ${title}${hint}`];
  }

  if (message.type === "ask") {
    return [
      `[ASK] ${truncateLine(normalizeOutputText(message.metadata?.command || message.content), 180)}`,
    ];
  }

  if (message.type === "error") {
    return [
      `[ERROR] ${truncateLine(normalizeOutputText(message.content), 180)}`,
    ];
  }

  if (message.type === "alert") {
    return [
      `[ALERT] ${truncateLine(normalizeOutputText(message.content), 180)}`,
    ];
  }

  return [compactMessageSummary(message, false)];
}

function toolTagForName(toolName: string): string {
  const name = String(toolName || "").toLowerCase();
  if (name.includes("exec_command")) return "RUN";
  if (name.includes("read_command_output")) return "READ CMD";
  if (name.includes("read_terminal")) return "READ TERM";
  if (name.includes("write_stdin")) return "STDIN";
  if (
    name.includes("create_or_edit") ||
    name.includes("write_file") ||
    name.includes("edit_file")
  )
    return "PATCH";
  if (name.includes("read_file")) return "READ FILE";
  return "TOOL";
}

function summarizeToolCall(message: ChatMessage): string {
  const toolName = message.metadata?.toolName || "tool";
  const normalizedInput = normalizeOutputText(message.content || "");
  const normalizedOutput = normalizeOutputText(message.metadata?.output || "");
  const outputSummary = summarizeTerminalOutput(normalizedOutput);

  if (outputSummary) return `${toolName}: ${outputSummary}`;
  if (normalizedInput)
    return `${toolName}: ${truncateLine(normalizedInput, 140)}`;
  return `${toolName} finished`;
}

function summarizeTerminalOutput(raw: string): string {
  const content = extractTerminalContent(raw) || raw;
  const firstLine = content
    .split("\n")
    .map((line) => line.trim())
    .find((line) => !!line && !line.startsWith("="));
  if (!firstLine) return "";
  return firstLine;
}

function extractTerminalContent(raw: string): string {
  if (!raw) return "";
  const match = raw.match(
    /<terminal_content>\s*([\s\S]*?)\s*<\/terminal_content>/i,
  );
  if (!match) return "";
  return String(match[1] || "").trim();
}

function messagePrimaryText(message: ChatMessage): string {
  const lines = messageBodyLines(message);
  return lines.join(" ");
}

function normalizeOutputText(input: string): string {
  return String(input || "")
    .replace(/\u001b\[[0-9;]*m/g, "")
    .replace(
      /\[MENTION_TAB:#([^#\]\r\n]+)(?:##[^#\]\r\n]*)?(?:#\])?/g,
      (_m, name: string) => `@${name}`,
    )
    .replace(
      /\[MENTION_SKILL:#([^#\]\r\n]+)(?:#\])?/g,
      (_m, name: string) => `@${name}`,
    )
    .replace(
      /\[MENTION_FILE:#([^#\]\r\n]+)(?:##[^#\]\r\n]*)?(?:#\])?/g,
      (_m, path: string) => path.split(/[/\\]/).pop() || path,
    )
    .replace(
      /\[MENTION_PASS_CHAT:#([^#\]\r\n]+)(?:##([^#\]\r\n]+))?(?:#\])?/g,
      (_m, _sessionId: string, title: string) =>
        `@Pass Chat: ${decodeMentionComponent(title || "Chat")}`,
    )
    .replace(/\r/g, "")
    .trim();
}

function decodeMentionComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function markdownToLines(text: string, limit?: number): string[] {
  const normalized = normalizeOutputText(text);
  if (!normalized) return [""];

  const rawLines = normalized.split("\n");
  const parsed: string[] = [];
  let inCode = false;

  for (const raw of rawLines) {
    const line = raw.trimEnd();
    if (line.startsWith("```")) {
      inCode = !inCode;
      continue;
    }

    if (inCode) {
      parsed.push(`  ${line}`);
      continue;
    }

    if (/^#{1,6}\s+/.test(line)) {
      parsed.push(line.replace(/^#{1,6}\s+/, "").trim());
      continue;
    }

    if (/^[-*+]\s+/.test(line)) {
      parsed.push(`- ${line.replace(/^[-*+]\s+/, "").trim()}`);
      continue;
    }

    if (/^\d+\.\s+/.test(line)) {
      parsed.push(line);
      continue;
    }

    const clean = line
      .replace(/`([^`]+)`/g, "$1")
      .replace(/\*\*([^*]+)\*\*/g, "$1")
      .replace(/__([^_]+)__/g, "$1")
      .replace(/\*([^*]+)\*/g, "$1")
      .replace(/_([^_]+)_/g, "$1")
      .replace(/~~([^~]+)~~/g, "$1")
      .replace(/\[(.*?)\]\((.*?)\)/g, "$1 ($2)");

    parsed.push(clean);
  }

  const compact = parsed
    .map((line) => line.trimEnd())
    .filter((line, index, arr) => !(line === "" && arr[index - 1] === ""));
  if (limit === undefined || limit < 0) return compact.length ? compact : [""];
  if (compact.length <= limit) return compact.length ? compact : [""];
  return [
    ...compact.slice(0, limit),
    `... (${compact.length - limit} more lines)`,
  ];
}

function encodeMentions(
  input: string,
  skills: SkillSummary[],
  terminals: GatewayTerminalSummary[],
): string {
  let output = input;

  const terminalMap = new Map(
    terminals.map((item) => [item.id.toLowerCase(), item]),
  );
  output = output.replace(
    /@terminal:([A-Za-z0-9_.:-]+)/g,
    (full, rawId: string) => {
      const terminal = terminalMap.get(rawId.toLowerCase());
      if (!terminal) return full;
      return `[MENTION_TAB:#${terminal.title}##${terminal.id}#]`;
    },
  );

  const aliasMap = new Map(
    [
      ...buildSkillMentionAliases(skills),
      ...buildTerminalMentionAliases(terminals),
    ]
      .filter((item) => !!item.token)
      .map((item) => [item.insertText.toLowerCase(), item.token as string]),
  );

  output = output.replace(/@[A-Za-z0-9_.-]+/g, (full) => {
    return aliasMap.get(full.toLowerCase()) ?? full;
  });

  return output;
}

function buildSkillMentionAliases(skills: SkillSummary[]): MentionOption[] {
  return skills
    .filter((item) => item.enabled !== false)
    .map((skill) => ({
      key: `skill:${skill.name}`,
      label: `@${skill.name}`,
      insertText: `@${skill.name}`,
      description: skill.description || "Skill",
      token: `[MENTION_SKILL:#${skill.name}#]`,
    }));
}

function buildTerminalMentionAliases(
  terminals: GatewayTerminalSummary[],
): MentionOption[] {
  const counts = new Map<string, number>();

  return terminals.map((terminal) => {
    const base = normalizeTerminalMentionBase(terminal.title);
    const index = (counts.get(base) || 0) + 1;
    counts.set(base, index);
    const alias = index === 1 ? base : `${base}_${index}`;
    const mention = `@${alias}`;
    return {
      key: `terminal:${terminal.id}`,
      label: mention,
      insertText: mention,
      description: terminal.title,
      token: `[MENTION_TAB:#${terminal.title}##${terminal.id}#]`,
    };
  });
}

function normalizeTerminalMentionBase(title: string): string {
  const normalized = normalizeOutputText(title)
    .replace(/\s+/g, "_")
    .replace(/[^A-Za-z0-9_.-]/g, "")
    .toUpperCase();
  if (normalized) return normalized;
  return "TERMINAL";
}

function summarizeDiff(diff: string): string {
  if (!diff) return "";

  const lines = diff.split("\n");
  let added = 0;
  let removed = 0;

  for (const line of lines) {
    if (
      line.startsWith("+++") ||
      line.startsWith("---") ||
      line.startsWith("@@")
    )
      continue;
    if (line.startsWith("+")) added += 1;
    if (line.startsWith("-")) removed += 1;
  }

  const parts: string[] = [];
  if (added > 0) parts.push(`+${added}`);
  if (removed > 0) parts.push(`-${removed}`);
  if (!parts.length) return "";
  return `(${parts.join(" ")})`;
}
