import React, {
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import { ArrowUpRight, LoaderCircle, Sparkles, UserRound } from "lucide-react";
import type { TerminalConnectionStatus } from "@gyshell/shared";
import {
  TerminalConnectionStatusCard,
  type TerminalConnectionCardLabels,
} from "./TerminalConnectionStatusCard";
import { TerminalSessionDividerOverlay } from "./TerminalSessionDividerOverlay";
import { TerminalCommandMarks } from "./TerminalCommandMarks";
import { useTerminalBlockDock } from "./block/useTerminalBlockDock";
import { resolveTerminalDockAnchor } from "./block/terminalDockModel";
import {
  TerminalCommandNavigator,
  type TerminalCommandNavigatorLabels,
} from "./TerminalCommandNavigator";
import { getNavigableTerminalAnnotations } from "./terminalCommandNavigation";
import { Terminal } from "@xterm/xterm";
import type { IMarker, ITheme } from "@xterm/xterm";
import type {
  TerminalActivitySnapshot,
  TerminalSessionBoundary,
} from "@gyshell/shared";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { WebLinksAddon } from "@xterm/addon-web-links";
import "@xterm/xterm/css/xterm.css";
import "./xtermView.scss";
import type { TerminalConfig, TerminalViewMode } from "../../lib/ipcTypes";
import {
  TerminalCommandDraft,
  type TerminalCommandDraftLabels,
} from "./TerminalCommandDraft";
import {
  getOrCreateTerminalSearchHandle,
  type TerminalSearchResultsChangeHandler,
  type XTermSearchHandle,
} from "./terminalSearchHandle";
import {
  getDefaultCommandDraftShortcut,
  matchesCommandDraftShortcut,
} from "../../lib/commandDraftShortcut";
import { isTerminalTrackedByBackend } from "./runtimeRetention";
import { resolveTerminalSize } from "./terminalDimensions";
import {
  mergeTerminalRefitRequests,
  NORMAL_TERMINAL_REFIT_REQUEST,
  normalizeTerminalRecoveryReason,
  RECOVERY_TERMINAL_REFIT_REQUEST,
  shouldScheduleTerminalRecoveryOnActivate,
  shouldSendTerminalBackendResize,
  type TerminalBackendResizeFailure,
  type TerminalRefitRequest,
} from "./terminalRecovery";
import { isRuntimeOwnedByUi } from "./runtimeOwnership";
import {
  admitFileSystemPanelDragPayload,
  extractNativeDropFilePaths,
  getFileSystemPanelDragPayloadPaths,
  getNativeFilePathResolver,
  hasFileSystemPanelDragPayloadType,
  hasNativeFileDragType,
} from "../../lib/filesystemDragDrop";
import {
  resolveTerminalWindowsPty,
  resolveTerminalWindowsPtyTransition,
  windowsPtyOptionsEqual,
  type TerminalRemoteOs,
  type TerminalSystemInfoLike,
} from "./terminalWindowsPty";
import {
  TerminalWriteCoordinator,
  type TerminalWriteTransition,
} from "./terminalWriteCoordinator";
import {
  hasTerminalLiveOffsetGap,
  mergeTerminalInitialReplay,
} from "./terminalInitialReplay";
import {
  selectTerminalActivityContext,
} from "./terminalActivityModel";
import { createTerminalActivityRuntime } from "./terminalActivityRuntime";
import {
  loadTerminalRecoveryMetadata,
  type TerminalRecoveryMetadata,
} from "./terminalRecoveryMetadata";
import { createTerminalMarkerRegistry } from "./terminalMarkerRegistry";
import {
  useTerminalActivities,
  type TerminalActivityMarkerRange,
} from "./useTerminalActivities";
import {
  TerminalViewSwitch,
  type TerminalViewModeLabels,
} from "./TerminalViewSwitch";
import {
  commandFromPromptLine,
  readTerminalBlockLogicalLine,
  type TerminalCommandAnnotation,
} from "./block/terminalBlockModel";
import { resolveTerminalRevealTop } from "./terminalReveal";
import { TerminalBlockView } from "./block/TerminalBlockView";
import {
  blockStatusText,
  type TerminalBlockLabels,
} from "./block/blockLabels";
import {
  applyTerminalFontOptions,
  resolveTerminalFontOptions,
} from "./terminalFontOptions";
import {
  TERMINAL_FOOTER_HEIGHT_PX,
  TERMINAL_REVEAL_FLASH_MS,
  TERMINAL_VIEW_CHROME_STYLE,
} from "./terminalViewChrome";
import "./terminalViewChrome.scss";

const SCROLLBAR_HIDE_DELAY = 2000; // ms
const RUNTIME_RELEASE_DELAY = 4000; // ms
const TERMINAL_WRITE_RECOVERY_DRAIN_TIMEOUT_MS = 10_000;
const COMMAND_DRAFT_SPINNER_FRAMES = ["|", "/", "-", "\\"];
const COMMAND_DRAFT_FAILURE_VISIBILITY_MS = 1000;
const TERMINAL_SEARCH_OPTIONS = {
  caseSensitive: false,
  decorations: {
    matchBackground: "rgba(214, 154, 36, 0.18)",
    matchBorder: "rgba(214, 154, 36, 0.4)",
    matchOverviewRuler: "rgba(214, 154, 36, 0.5)",
    activeMatchBackground: "rgba(214, 154, 36, 0.42)",
    activeMatchBorder: "rgba(214, 154, 36, 0.9)",
    activeMatchColorOverviewRuler: "rgba(214, 154, 36, 0.9)",
  },
};

type CommandDraftOpenRequest = {
  id: number;
  placement: "center" | "pointer";
  terminalId: string;
};

type TerminalSettings = {
  fontSize?: number;
  lineHeight?: number;
  scrollback?: number;
  cursorStyle?: "block" | "underline" | "bar";
  cursorBlink?: boolean;
  copyOnSelect?: boolean;
  rightClickToPaste?: boolean;
  commandDraftShortcut?: string;
};

interface XTermViewProps {
  config: TerminalConfig;
  theme: ITheme;
  terminalSettings?: TerminalSettings;
  runtimeState?: "initializing" | "ready" | "exited";
  connectionStatusLabel: string;
  connectionStatus?: TerminalConnectionStatus;
  disconnectedStatusLabel: string;
  connectionCardLabels?: TerminalConnectionCardLabels;
  onReconnect?: () => void;
  commandDraftLabels?: TerminalCommandDraftLabels;
  commandDraftShortcut?: string;
  commandDraftProfileId?: string;
  commandDraftProfileOptions?: Array<{ id: string; name: string }>;
  onCommandDraftProfileChange?: (profileId: string) => void;
  commandDraftOpenRequest?: CommandDraftOpenRequest | null;
  onCommandDraftOpenRequestHandled?: (
    requestId: number,
    terminalId: string,
  ) => void;
  remoteOs?: TerminalRemoteOs;
  systemInfo?: TerminalSystemInfoLike;
  isOwnedByUi?: () => boolean;
  supportsFilesystem: boolean;
  isActive?: boolean;
  layoutSignature?: string;
  onSelectionChange?: (selectionText: string) => void;
  onSearchResultsChange?: (payload: {
    resultCount: number;
    resultIndex: number;
  }) => void;
  terminalViewMode: TerminalViewMode;
  blockLabels: TerminalBlockLabels;
  commandNavigatorLabels: TerminalCommandNavigatorLabels;
  viewModeLabels: TerminalViewModeLabels;
  dividerLabels: {
    title: string;
    resumedAt: string;
    lastCommand: string;
    exitCode: (code: number) => string;
  };
  locale: "en" | "zh-CN";
  sessionTitleLookup?: (sessionId: string) => string | undefined;
  commandSessionTitleLookup?: (sessionId: string) => string | undefined;
  onTerminalViewModeChange?: (mode: TerminalViewMode) => void;
}

interface TerminalRuntime {
  terminalId: string;
  term: Terminal;
  fit: FitAddon;
  searchAddon: SearchAddon;
  mountEl: HTMLDivElement;
  contextMenuId: string;
  selectionHandler?: (selectionText: string) => void;
  settings?: TerminalSettings;
  uiOwnershipCheck?: () => boolean;
  supportsFilesystem: boolean;
  isActive: boolean;
  hostEl: HTMLDivElement | null;
  refCount: number;
  releaseTimer: number | null;
  scrollHideTimer: number | null;
  activityMarkers: Map<string, TerminalActivityMarkerRange>;
  sessionMarkers: Map<string, IMarker>;
  offsetAnchors: Map<number, IMarker>;
  recoveryMetadata?: TerminalRecoveryMetadata;
  markerRegistry: ReturnType<typeof createTerminalMarkerRegistry>;
  scheduleActivityMarker: (
    activity: TerminalActivitySnapshot,
    edge: "start" | "end",
  ) => void;
  clearActivityMarker: (activityId: string) => void;
  activityMetadataListener?: (
    metadata: TerminalRecoveryMetadata,
  ) => void;
  activityMarkerLayoutListener?: () => void;
  cleanupBackendData: () => void;
  cleanupContextMenuListener: () => void;
  inputDispose: () => void;
  selectionDispose: () => void;
  scrollDispose: () => void;
  removeDomListeners: () => void;
  refitFrame: number | null;
  settleRefitFrame: number | null;
  pendingRefitRequest: TerminalRefitRequest;
  backendResizeGeneration: number;
  failedBackendResize: TerminalBackendResizeFailure | null;
  lastHandledRecoveryEpoch: number;
  pendingRecoveryRefit: boolean;
  writeCoordinator: TerminalWriteCoordinator;
}

interface PendingTerminalActivityMarker {
  activityId: string;
  edge: "start" | "end";
  offset: number;
}

interface TerminalRenderMetadata {
  remoteOs?: TerminalRemoteOs;
  windowsRelease?: string;
}

interface BufferedTerminalOutputEvent extends TerminalRenderMetadata {
  data: string;
  offset?: number;
  outputSequence?: number;
  runtimeGeneration?: number;
}

const runtimePool = new Map<string, TerminalRuntime>();
let terminalRecoveryEpoch = 0;

const registerTerminalActivityMarker = (
  runtime: TerminalRuntime,
  activityId: string,
  edge: "start" | "end",
  targetLine?: number,
  targetAtLineStart?: boolean,
): void => {
  if (runtime.term.buffer.active.type !== "normal") return;
  const range = runtime.activityMarkers.get(activityId) || {};
  if (range[edge] && !range[edge]?.isDisposed) return;
  const cursorLine =
    runtime.term.buffer.active.baseY + runtime.term.buffer.active.cursorY;
  const marker = runtime.term.registerMarker(
    Number.isFinite(targetLine)
      ? Math.floor(targetLine as number) - cursorLine
      : 0,
  );
  if (!marker) return;
  range[edge] = marker;
  if (edge === "end") {
    range.endAtLineStart = Number.isFinite(targetLine)
      ? targetAtLineStart === true
      : runtime.term.buffer.active.cursorX === 0;
  }
  runtime.activityMarkers.set(activityId, range);
  marker.onDispose(() => {
    const current = runtime.activityMarkers.get(activityId);
    if (!current || current[edge] !== marker) return;
    current[edge] = undefined;
    if (!current.start && !current.end) {
      runtime.activityMarkers.delete(activityId);
    }
    runtime.activityMarkerLayoutListener?.();
  });
};

/** Typed commands have no recorded text: show what follows the prompt. */
const resolvePromptPreview = (line: string | undefined): string | undefined =>
  commandFromPromptLine(line) ?? (line?.trim() || undefined);

const toPlainConfig = (config: TerminalConfig): TerminalConfig =>
  JSON.parse(JSON.stringify(config)) as TerminalConfig;

const clearTimer = (timerId: number | null): void => {
  if (timerId !== null) {
    window.clearTimeout(timerId);
  }
};

const clearAnimationFrame = (frameId: number | null): void => {
  if (frameId !== null) {
    window.cancelAnimationFrame(frameId);
  }
};

const noteTerminalRecoveryEvent = (): number => {
  terminalRecoveryEpoch += 1;
  return terminalRecoveryEpoch;
};

const requestBackendResize = (
  runtime: TerminalRuntime,
  cols: number,
  rows: number,
): void => {
  const generation = runtime.backendResizeGeneration + 1;
  runtime.backendResizeGeneration = generation;
  runtime.failedBackendResize = null;
  try {
    void window.gyshell.terminal
      .resize(runtime.terminalId, cols, rows)
      .catch(() => {
        if (runtime.backendResizeGeneration !== generation) return;
        runtime.failedBackendResize = { cols, rows };
      });
  } catch {
    if (runtime.backendResizeGeneration !== generation) return;
    runtime.failedBackendResize = { cols, rows };
  }
};

const applyRuntimeWindowsPty = (
  runtime: TerminalRuntime,
  metadata: TerminalRenderMetadata,
): boolean => {
  if (!metadata.remoteOs) return false;
  const currentWindowsPty = runtime.term.options.windowsPty;
  const nextWindowsPty = resolveTerminalWindowsPtyTransition(
    currentWindowsPty,
    metadata.remoteOs,
    { release: metadata.windowsRelease },
  );
  if (windowsPtyOptionsEqual(currentWindowsPty, nextWindowsPty)) {
    return false;
  }
  runtime.term.options.windowsPty = nextWindowsPty ?? {};
  return true;
};

const getTerminalRenderMetadataKey = (
  metadata: TerminalRenderMetadata,
): string | undefined =>
  metadata.remoteOs
    ? `${metadata.remoteOs}:${metadata.windowsRelease ?? "unknown"}`
    : undefined;

const createRuntimeWindowsPtyTransition = (
  runtime: TerminalRuntime,
  metadata: TerminalRenderMetadata,
  onChanged?: () => void,
): TerminalWriteTransition | undefined => {
  const key = getTerminalRenderMetadataKey(metadata);
  if (!key) return undefined;
  return {
    key,
    apply: () => {
      if (applyRuntimeWindowsPty(runtime, metadata)) {
        onChanged?.();
      }
    },
  };
};

const refitRuntime = (
  runtime: TerminalRuntime,
  request: TerminalRefitRequest = NORMAL_TERMINAL_REFIT_REQUEST,
): boolean => {
  if (runtime.writeCoordinator.hasPendingWrites) return false;
  const host = runtime.hostEl;
  if (!host || host.clientWidth <= 0 || host.clientHeight <= 0) {
    runtime.writeCoordinator.endRefitBarrier();
    return true;
  }
  try {
    if (request.clearTextureAtlas) {
      runtime.term.clearTextureAtlas();
    }
    const previousCols = runtime.term.cols;
    const previousRows = runtime.term.rows;
    runtime.fit.fit();
    const next = runtime.fit.proposeDimensions();
    const size = resolveTerminalSize(next, {
      cols: runtime.term.cols,
      rows: runtime.term.rows,
    });
    if (
      shouldSendTerminalBackendResize({
        previousCols,
        previousRows,
        nextCols: size.cols,
        nextRows: size.rows,
        forceBackendResize: request.forceBackendResize,
        failedBackendResize: runtime.failedBackendResize,
      })
    ) {
      requestBackendResize(runtime, size.cols, size.rows);
    }
    runtime.term.refresh(0, Math.max(0, runtime.term.rows - 1));
  } catch {
    // ignore transient DOM/layout issues
  } finally {
    runtime.writeCoordinator.endRefitBarrier();
  }
  return true;
};

const scheduleRuntimeRefit = (
  runtime: TerminalRuntime,
  request: TerminalRefitRequest = NORMAL_TERMINAL_REFIT_REQUEST,
): void => {
  runtime.pendingRefitRequest = mergeTerminalRefitRequests(
    runtime.pendingRefitRequest,
    request,
  );
  clearAnimationFrame(runtime.refitFrame);
  clearAnimationFrame(runtime.settleRefitFrame);
  runtime.refitFrame = window.requestAnimationFrame(() => {
    runtime.refitFrame = null;
    runtime.writeCoordinator.beginRefitBarrier();
    const nextRequest = runtime.pendingRefitRequest;
    if (!refitRuntime(runtime, nextRequest)) return;
    runtime.pendingRefitRequest = { ...NORMAL_TERMINAL_REFIT_REQUEST };
    // Resizable panel layout can settle one frame later; run one more fit pass.
    runtime.settleRefitFrame = window.requestAnimationFrame(() => {
      runtime.settleRefitFrame = null;
      runtime.writeCoordinator.beginRefitBarrier();
      if (runtime.writeCoordinator.hasPendingWrites) {
        scheduleRuntimeRefit(runtime, NORMAL_TERMINAL_REFIT_REQUEST);
        return;
      }
      refitRuntime(runtime, NORMAL_TERMINAL_REFIT_REQUEST);
    });
  });
};

const scheduleRuntimeRecoveryRefit = (
  runtime: TerminalRuntime,
  recoveryEpoch = terminalRecoveryEpoch,
): void => {
  runtime.lastHandledRecoveryEpoch = Math.max(
    runtime.lastHandledRecoveryEpoch,
    recoveryEpoch,
  );
  runtime.pendingRecoveryRefit = false;
  scheduleRuntimeRefit(runtime, RECOVERY_TERMINAL_REFIT_REQUEST);
};

const attachRuntimeToHost = (
  runtime: TerminalRuntime,
  hostEl: HTMLDivElement,
): void => {
  if (runtime.hostEl === hostEl && runtime.mountEl.parentElement === hostEl)
    return;
  if (
    runtime.mountEl.parentElement &&
    runtime.mountEl.parentElement !== hostEl
  ) {
    runtime.mountEl.parentElement.removeChild(runtime.mountEl);
  }
  hostEl.replaceChildren(runtime.mountEl);
  runtime.hostEl = hostEl;
};

const disposeRuntime = (runtime: TerminalRuntime): void => {
  clearTimer(runtime.releaseTimer);
  clearTimer(runtime.scrollHideTimer);
  clearAnimationFrame(runtime.refitFrame);
  clearAnimationFrame(runtime.settleRefitFrame);
  runtime.releaseTimer = null;
  runtime.scrollHideTimer = null;
  runtime.activityMarkers.clear();
  runtime.markerRegistry.dispose();
  runtime.refitFrame = null;
  runtime.settleRefitFrame = null;
  runtime.cleanupBackendData();
  runtime.cleanupContextMenuListener();
  runtime.inputDispose();
  runtime.selectionDispose();
  runtime.scrollDispose();
  runtime.removeDomListeners();
  runtime.hostEl = null;
  runtime.writeCoordinator.dispose();
  runtime.term.dispose();
};

const installRuntimeWriteCoordinatorDrainHandler = (
  runtime: TerminalRuntime,
): void => {
  runtime.writeCoordinator.setDrainHandler(() => {
    if (
      runtime.writeCoordinator.isRefitBarrierActive &&
      runtime.refitFrame === null
    ) {
      scheduleRuntimeRefit(runtime);
    }
  });
};

const replaceRuntimeWriteCoordinator = (runtime: TerminalRuntime): void => {
  runtime.writeCoordinator.dispose();
  runtime.writeCoordinator = new TerminalWriteCoordinator((data, callback) => {
    runtime.term.write(data, callback);
  }, "unknown");
  installRuntimeWriteCoordinatorDrainHandler(runtime);
};

const createRuntime = (
  config: TerminalConfig,
  theme: ITheme,
  settings: TerminalSettings | undefined,
  supportsFilesystem: boolean,
  remoteOs?: TerminalRemoteOs,
  systemInfo?: TerminalSystemInfoLike,
): TerminalRuntime => {
  const windowsPty = resolveTerminalWindowsPty(remoteOs, systemInfo);
  const term = new Terminal({
    allowTransparency: true,
    cursorBlink: settings?.cursorBlink ?? true,
    cursorStyle: settings?.cursorStyle ?? "block",
    ...resolveTerminalFontOptions(settings),
    scrollback: settings?.scrollback ?? 5000,
    theme,
    windowsPty,
    // Like Windows Terminal/ConPTY, iTerm and Terminal.app: a clear-screen
    // (ED2) pushes the viewport into scrollback instead of erasing it, so
    // restored history and its "Session Resumed" divider stay intact and in
    // place. ED3 (clear scrollback) still removes them.
    scrollOnEraseInDisplay: true,
    allowProposedApi: true,
  });

  const fit = new FitAddon();
  term.loadAddon(fit);
  const searchAddon = new SearchAddon();
  term.loadAddon(searchAddon);

  const webLinks = new WebLinksAddon((_event, url) => {
    window.gyshell.system.openExternal(url).catch(() => {
      // ignore
    });
  });
  term.loadAddon(webLinks);

  const mountEl = document.createElement("div");
  mountEl.style.width = "100%";
  mountEl.style.height = "100%";
  mountEl.style.position = "relative";

  term.open(mountEl);
  try {
    fit.fit();
  } catch {
    // ignore transient DOM/layout issues
  }

  const markerRegistry = createTerminalMarkerRegistry(term);
  const runtime: TerminalRuntime = {
    terminalId: config.id,
    term,
    fit,
    searchAddon,
    mountEl,
    contextMenuId: `terminal-${config.id}`,
    selectionHandler: undefined,
    settings,
    uiOwnershipCheck: undefined,
    supportsFilesystem,
    isActive: false,
    hostEl: null,
    refCount: 0,
    releaseTimer: null,
    scrollHideTimer: null,
    markerRegistry,
    activityMarkers: new Map(),
    sessionMarkers: markerRegistry.boundaryMarkers,
    offsetAnchors: markerRegistry.offsetAnchors,
    scheduleActivityMarker: () => {},
    clearActivityMarker: () => {},
    activityMetadataListener: undefined,
    activityMarkerLayoutListener: undefined,
    cleanupBackendData: () => {},
    cleanupContextMenuListener: () => {},
    inputDispose: () => {},
    selectionDispose: () => {},
    scrollDispose: () => {},
    removeDomListeners: () => {},
    refitFrame: null,
    settleRefitFrame: null,
    pendingRefitRequest: { ...NORMAL_TERMINAL_REFIT_REQUEST },
    backendResizeGeneration: 0,
    failedBackendResize: null,
    lastHandledRecoveryEpoch: terminalRecoveryEpoch,
    pendingRecoveryRefit: false,
    writeCoordinator: new TerminalWriteCoordinator(
      (data, callback) => {
        term.write(data, callback);
      },
      getTerminalRenderMetadataKey({
        remoteOs,
        windowsRelease: systemInfo?.release,
      }),
    ),
  };

  installRuntimeWriteCoordinatorDrainHandler(runtime);

  const showScrollbar = () => {
    runtime.hostEl?.classList.add("is-scrollbar-visible");
    clearTimer(runtime.scrollHideTimer);
    runtime.scrollHideTimer = window.setTimeout(() => {
      runtime.hostEl?.classList.remove("is-scrollbar-visible");
      runtime.scrollHideTimer = null;
    }, SCROLLBAR_HIDE_DELAY);
  };

  const inputDisposable = term.onData((data) => {
    window.gyshell.terminal.write(config.id, data);
  });

  const selectionDisposable = term.onSelectionChange(() => {
    const selectionText = term.getSelection();
    runtime.selectionHandler?.(selectionText);
    if (selectionText && runtime.settings?.copyOnSelect) {
      navigator.clipboard.writeText(selectionText).catch(() => {
        // ignore
      });
    }
  });

  const scrollDisposable = term.onScroll(() => {
    showScrollbar();
  });

  const handlePaste = (event: ClipboardEvent) => {
    const selectionText = term.getSelection();
    if (selectionText) {
      event.preventDefault();
      navigator.clipboard
        .writeText(selectionText)
        .then(() => {
          term.paste(selectionText);
        })
        .catch(() => {
          term.paste(selectionText);
        });
    }
  };

  const handleDragOver = (event: DragEvent) => {
    const isFileDrop =
      hasFileSystemPanelDragPayloadType(event.dataTransfer) ||
      hasNativeFileDragType(event.dataTransfer);
    if (!isFileDrop) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = "copy";
    }
  };

  const handleDrop = (event: DragEvent) => {
    const isFileDrop =
      hasFileSystemPanelDragPayloadType(event.dataTransfer) ||
      hasNativeFileDragType(event.dataTransfer);
    if (!isFileDrop) return;
    event.preventDefault();
    event.stopPropagation();
    const filesystemAdmission = admitFileSystemPanelDragPayload(
      event.dataTransfer,
    );
    let paths: string[];
    if (filesystemAdmission.kind === "absent") {
      paths = extractNativeDropFilePaths(
        event.dataTransfer,
        getNativeFilePathResolver(),
      );
    } else {
      const sourceIsCurrentlyOwned = (() => {
        try {
          return runtime.uiOwnershipCheck?.() === true;
        } catch {
          return false;
        }
      })();
      if (
        filesystemAdmission.kind === "rejected" ||
        filesystemAdmission.payload.sourceTerminalId !== config.id ||
        runtime.supportsFilesystem !== true ||
        !sourceIsCurrentlyOwned
      ) {
        return;
      }
      paths = getFileSystemPanelDragPayloadPaths(filesystemAdmission.payload);
    }
    if (!paths.length) return;
    window.gyshell.terminal.writePaths(config.id, paths).catch(() => {
      // ignore
    });
  };

  const handleContextMenu = (event: MouseEvent) => {
    if (runtime.settings?.rightClickToPaste) {
      event.preventDefault();
      navigator.clipboard
        .readText()
        .then((text) => {
          if (text) term.paste(text);
        })
        .catch(() => {
          // ignore
        });
      return;
    }
    event.preventDefault();
    const selectionText = term.getSelection();
    window.gyshell.ui.showContextMenu({
      id: runtime.contextMenuId,
      canCopy: selectionText.trim().length > 0,
      canPaste: true,
    });
  };

  const onContextMenuAction = (data: {
    id: string;
    action: "copy" | "paste";
  }) => {
    if (data.id !== runtime.contextMenuId) return;
    if (data.action === "copy") {
      const selectionText = term.getSelection();
      if (selectionText) {
        navigator.clipboard.writeText(selectionText).catch(() => {
          // ignore
        });
      }
      return;
    }
    if (data.action === "paste") {
      const selectionText = term.getSelection();
      if (selectionText) {
        navigator.clipboard
          .writeText(selectionText)
          .then(() => {
            term.paste(selectionText);
          })
          .catch(() => {
            term.paste(selectionText);
          });
        return;
      }
      navigator.clipboard
        .readText()
        .then((text) => {
          if (text) term.paste(text);
        })
        .catch(() => {
          // ignore
        });
    }
  };

  mountEl.addEventListener("paste", handlePaste);
  mountEl.addEventListener("dragover", handleDragOver, true);
  mountEl.addEventListener("drop", handleDrop, true);
  mountEl.addEventListener("contextmenu", handleContextMenu);
  const removeContextMenuListener =
    window.gyshell.ui.onContextMenuAction(onContextMenuAction);

  let lastBufferOffset = 0;
  let lastCommittedBufferOffset = 0;
  let isSyncingInitialBuffer = true;
  const pendingLiveEvents: BufferedTerminalOutputEvent[] = [];
  const outputConsumerId = `${config.id}:${Date.now()}:${Math.random()
    .toString(36)
    .slice(2)}`;
  let outputConsumerDisposed = false;
  let outputConsumerAttached = false;
  let attachedRuntimeGeneration: number | undefined;
  let writeCoordinatorRuntimeGeneration: number | undefined;
  let failedWriteCoordinatorGeneration: number | undefined;
  let failedCoordinatorRecoveryInFlight = false;
  const pendingActivityMarkers = new Map<
    string,
    PendingTerminalActivityMarker
  >();
  const rememberActivityOffsetAnchor = (offset: number): void => {
    runtime.markerRegistry.rememberOffsetAnchor(offset);
  };
  const clearActivityOffsetAnchors = (): void => {
    runtime.markerRegistry.clearOffsetAnchors();
  };
  const terminalFlowApi = window.gyshell.terminal;
  const installWriteCoordinatorFailureHandler = (generation?: number): void => {
    const coordinator = runtime.writeCoordinator;
    coordinator.setFailureHandler((error) => {
      const failureGeneration = Number.isSafeInteger(generation)
        ? generation
        : writeCoordinatorRuntimeGeneration;
      failedWriteCoordinatorGeneration = failureGeneration;
      isSyncingInitialBuffer = true;
      if (Number.isSafeInteger(failureGeneration)) {
        terminalFlowApi.reportOutputFailure?.(
          config.id,
          outputConsumerId,
          failureGeneration as number,
          error.message,
        );
      }
      // Keep the logical consumer registered. The backend detaches it from
      // the failed controller before stopping that runtime, then the next
      // runtime generation can reuse the same consumer after we replace the
      // failed coordinator below.
    });
  };
  const prepareWriteCoordinatorForGeneration = (
    generation: number | undefined,
  ): boolean => {
    if (!Number.isSafeInteger(generation)) return false;
    const normalizedGeneration = generation as number;
    if (
      Number.isSafeInteger(failedWriteCoordinatorGeneration) &&
      failedWriteCoordinatorGeneration !== normalizedGeneration
    ) {
      return true;
    }
    writeCoordinatorRuntimeGeneration = normalizedGeneration;
    installWriteCoordinatorFailureHandler(normalizedGeneration);
    return false;
  };
  installWriteCoordinatorFailureHandler();

  const commitActivityMarkers = (
    boundaries: PendingTerminalActivityMarker[],
  ): void => {
    for (const boundary of boundaries) {
      registerTerminalActivityMarker(
        runtime,
        boundary.activityId,
        boundary.edge,
      );
    }
    runtime.activityMarkerLayoutListener?.();
  };
  const clearActivityMarker = (activityId: string): void => {
    pendingActivityMarkers.delete(`${activityId}:start`);
    pendingActivityMarkers.delete(`${activityId}:end`);
    const range = runtime.activityMarkers.get(activityId);
    if (!range) return;
    runtime.activityMarkers.delete(activityId);
    range.start?.dispose();
    range.end?.dispose();
  };

  runtime.clearActivityMarker = clearActivityMarker;
  runtime.scheduleActivityMarker = (activity, edge) => {
    const offset = edge === "start" ? activity.startOffset : activity.endOffset;
    if (!Number.isFinite(offset)) return;
    if (
      Number.isSafeInteger(activity.runtimeGeneration) &&
      Number.isSafeInteger(attachedRuntimeGeneration) &&
      activity.runtimeGeneration !== attachedRuntimeGeneration
    ) {
      return;
    }
    const range = runtime.activityMarkers.get(activity.id);
    if (range?.[edge] && !range[edge]?.isDisposed) return;
    const boundary: PendingTerminalActivityMarker = {
      activityId: activity.id,
      edge,
      offset: Math.max(0, Math.floor(offset as number)),
    };
    const key = `${activity.id}:${edge}`;
    const anchor = runtime.markerRegistry.getOffsetAnchor(boundary.offset);
    if (anchor) {
      pendingActivityMarkers.delete(key);
      registerTerminalActivityMarker(
        runtime,
        boundary.activityId,
        boundary.edge,
        anchor.marker.line,
        anchor.atLineStart,
      );
      runtime.activityMarkerLayoutListener?.();
      return;
    }
    if (boundary.offset < lastCommittedBufferOffset) {
      // Once xterm has parsed bytes beyond a boundary, ANSI rewrites and
      // wrapping make retroactive byte-to-row reconstruction unsafe.
      return;
    }
    if (boundary.offset <= lastBufferOffset) {
      pendingActivityMarkers.delete(key);
      runtime.writeCoordinator.checkpoint(() => {
        commitActivityMarkers([boundary]);
      });
      return;
    }
    pendingActivityMarkers.set(key, boundary);
  };

  const activityRuntime = createTerminalActivityRuntime(
    runtime,
    typeof terminalFlowApi.onActivity === "function"
      ? terminalFlowApi.onActivity
      : undefined,
  );

  const writeDataWithOffset = (
    data: string,
    offset?: number,
    metadata: TerminalRenderMetadata = {},
    applyMetadataWhenDuplicate = false,
    completion?: () => void,
    failure?: (error: Error) => void,
  ): void => {
    const transition = createRuntimeWindowsPtyTransition(runtime, metadata);
    if (!data) {
      if (applyMetadataWhenDuplicate) {
        runtime.writeCoordinator.write("", transition, completion, failure);
      } else {
        completion?.();
      }
      return;
    }
    if (!Number.isFinite(offset)) {
      runtime.writeCoordinator.write(data, transition, completion, failure);
      return;
    }

    const normalizedOffset = Math.max(0, Math.floor(offset as number));
    const completeAtOffset = (): void => {
      rememberActivityOffsetAnchor(normalizedOffset);
      lastCommittedBufferOffset = Math.max(
        lastCommittedBufferOffset,
        normalizedOffset,
      );
      completion?.();
    };
    const chunkStart = Math.max(0, normalizedOffset - data.length);
    if (normalizedOffset <= lastBufferOffset) {
      if (applyMetadataWhenDuplicate) {
        runtime.writeCoordinator.write("", transition, completion, failure);
      } else {
        completion?.();
      }
      return;
    }
    const overlap = Math.max(0, lastBufferOffset - chunkStart);
    const nextChunk = data.slice(overlap);
    const nextChunkStart = chunkStart + overlap;
    const boundaries = [...pendingActivityMarkers.entries()]
      .filter(([, boundary]) => boundary.offset <= normalizedOffset)
      .sort((left, right) => left[1].offset - right[1].offset);
    for (const [key, boundary] of boundaries) {
      pendingActivityMarkers.delete(key);
      if (boundary.offset < nextChunkStart) {
        // The retained ring buffer no longer contains this boundary.
        continue;
      }
    }
    const visibleBoundaries = boundaries
      .map(([, boundary]) => boundary)
      .filter((boundary) => boundary.offset >= nextChunkStart);
    let cursorOffset = nextChunkStart;
    let cursorIndex = 0;
    let transitionPending = transition;
    let completionScheduled = false;
    let boundaryIndex = 0;
    while (boundaryIndex < visibleBoundaries.length) {
      const boundaryOffset = visibleBoundaries[boundaryIndex].offset;
      const sameOffset: PendingTerminalActivityMarker[] = [];
      while (
        boundaryIndex < visibleBoundaries.length &&
        visibleBoundaries[boundaryIndex].offset === boundaryOffset
      ) {
        sameOffset.push(visibleBoundaries[boundaryIndex]);
        boundaryIndex += 1;
      }
      const endIndex = Math.max(
        cursorIndex,
        Math.min(nextChunk.length, boundaryOffset - nextChunkStart),
      );
      const prefix = nextChunk.slice(cursorIndex, endIndex);
      const isFinalBoundary =
        boundaryOffset >= normalizedOffset &&
        boundaryIndex >= visibleBoundaries.length;
      const boundaryCompletion = () => {
        commitActivityMarkers(sameOffset);
        if (isFinalBoundary) completeAtOffset();
      };
      if (prefix) {
        runtime.writeCoordinator.write(
          prefix,
          transitionPending,
          undefined,
          failure,
        );
        transitionPending = undefined;
      }
      runtime.writeCoordinator.checkpoint(boundaryCompletion);
      completionScheduled = completionScheduled || isFinalBoundary;
      cursorIndex = endIndex;
      cursorOffset = boundaryOffset;
    }
    const suffix = nextChunk.slice(cursorIndex);
    if (suffix) {
      runtime.writeCoordinator.write(
        suffix,
        transitionPending,
        completeAtOffset,
        failure,
      );
      completionScheduled = true;
    } else if (!completionScheduled) {
      if (cursorOffset < normalizedOffset) {
        runtime.writeCoordinator.write(
          nextChunk,
          transitionPending,
          completeAtOffset,
          failure,
        );
      } else {
        runtime.writeCoordinator.checkpoint(completeAtOffset);
      }
    }
    lastBufferOffset = normalizedOffset;
  };

  const acknowledgeBufferedEvent = (
    event: BufferedTerminalOutputEvent,
  ): void => {
    if (
      Number.isSafeInteger(event.outputSequence) &&
      Number.isSafeInteger(event.runtimeGeneration)
    ) {
      terminalFlowApi.acknowledgeOutput?.(
        config.id,
        outputConsumerId,
        event.runtimeGeneration as number,
        event.outputSequence as number,
      );
    }
  };

  const reportBufferedEventFailure = (
    event: BufferedTerminalOutputEvent,
    error: Error,
  ): void => {
    if (Number.isSafeInteger(event.runtimeGeneration)) {
      terminalFlowApi.reportOutputFailure?.(
        config.id,
        outputConsumerId,
        event.runtimeGeneration as number,
        error.message,
      );
    }
  };

  const flushPendingLiveEvents = (): void => {
    if (isSyncingInitialBuffer || pendingLiveEvents.length === 0) return;
    const pending = pendingLiveEvents.splice(0, pendingLiveEvents.length);
    for (let index = 0; index < pending.length; index += 1) {
      if (isSyncingInitialBuffer) {
        pendingLiveEvents.push(...pending.slice(index));
        return;
      }
      processBufferedOutputEvent(pending[index]);
    }
  };

  const replayBufferedOutput = (
    initial: {
      data: string;
      offset: number;
      remoteOs?: TerminalRemoteOs;
      windowsRelease?: string;
      sessionBoundaries?: readonly TerminalSessionBoundary[];
    },
    replayEvents: BufferedTerminalOutputEvent[],
    failureGeneration?: number,
    recoveringFailedCoordinator = false,
  ): void => {
    const replaySegments = [
      {
        data: initial.data || "",
        offset: initial.offset,
        remoteOs: initial.remoteOs,
        windowsRelease: initial.windowsRelease,
      },
      ...replayEvents,
    ];
    const replay = mergeTerminalInitialReplay(replaySegments);
    const latestMetadata = [...replaySegments]
      .reverse()
      .find(
        (segment) =>
          Boolean(segment.remoteOs) || Boolean(segment.windowsRelease),
      );
    const replayMetadata: TerminalRenderMetadata = latestMetadata || initial;

    const boundaries = initial.sessionBoundaries || [];
    const registerRestoreMarker = (
      boundary: TerminalSessionBoundary,
    ): void => {
      runtime.markerRegistry.registerBoundary(boundary.id, 1);
      runtime.activityMarkerLayoutListener?.();
    };

    const acknowledgeReplay = (): void => {
      replayEvents.forEach(acknowledgeBufferedEvent);
      if (recoveringFailedCoordinator) {
        failedCoordinatorRecoveryInFlight = false;
      }
      isSyncingInitialBuffer = false;
      flushPendingLiveEvents();
    };
    const reportReplayFailure = (error: Error): void => {
      if (recoveringFailedCoordinator) {
        failedCoordinatorRecoveryInFlight = false;
      }
      const latestEventGeneration = [...replayEvents]
        .reverse()
        .find((event) =>
          Number.isSafeInteger(event.runtimeGeneration),
        )?.runtimeGeneration;
      const generation = Number.isSafeInteger(latestEventGeneration)
        ? latestEventGeneration
        : Number.isSafeInteger(failureGeneration)
          ? failureGeneration
          : attachedRuntimeGeneration;
      if (Number.isSafeInteger(generation)) {
        failedWriteCoordinatorGeneration = generation as number;
        isSyncingInitialBuffer = true;
        terminalFlowApi.reportOutputFailure?.(
          config.id,
          outputConsumerId,
          generation as number,
          error.message,
        );
      }
    };

    if (replay.hasGap) {
      reportReplayFailure(
        new Error(
          `Visible terminal initial replay gap detected between offsets ${String(
            replay.gapStart,
          )} and ${String(replay.gapEnd)}.`,
        ),
      );
      return;
    }

    const dataStartOffset = Math.max(0, replay.offset - replay.data.length);
    const visibleBoundaries = boundaries
      .filter(
        (boundary) =>
          Number.isFinite(boundary.offset) &&
          boundary.offset >= dataStartOffset &&
          boundary.offset <= replay.offset,
      )
      .sort((left, right) => left.offset - right.offset);
    const latestVisibleBoundary =
      visibleBoundaries[visibleBoundaries.length - 1];

    const writeReplayThroughBoundaries = (
      cursorIndex: number,
      boundaryIndex: number,
    ): void => {
      if (boundaryIndex >= visibleBoundaries.length) {
        writeDataWithOffset(
          replay.data.slice(cursorIndex),
          replay.offset,
          replayMetadata,
          boundaryIndex === 0,
          acknowledgeReplay,
          reportReplayFailure,
        );
        return;
      }

      const boundaryOffset = visibleBoundaries[boundaryIndex].offset;
      const boundaryDataIndex = Math.max(
        cursorIndex,
        Math.min(replay.data.length, boundaryOffset - dataStartOffset),
      );
      const boundaryGroup: TerminalSessionBoundary[] = [];
      let nextBoundaryIndex = boundaryIndex;
      while (
        nextBoundaryIndex < visibleBoundaries.length &&
        visibleBoundaries[nextBoundaryIndex].offset === boundaryOffset
      ) {
        boundaryGroup.push(visibleBoundaries[nextBoundaryIndex]);
        nextBoundaryIndex += 1;
      }
      const isHistorical =
        latestVisibleBoundary !== undefined &&
        boundaryOffset <= latestVisibleBoundary.offset;
      writeDataWithOffset(
        replay.data.slice(cursorIndex, boundaryDataIndex),
        dataStartOffset + boundaryDataIndex,
        isHistorical ? initial : replayMetadata,
        true,
        () => {
          boundaryGroup.forEach((boundary) => registerRestoreMarker(boundary));
          writeReplayThroughBoundaries(boundaryDataIndex, nextBoundaryIndex);
        },
        reportReplayFailure,
      );
    };

    writeReplayThroughBoundaries(0, 0);
  };

  const beginFailedCoordinatorRecovery = (
    requestedGeneration: number,
  ): void => {
    if (failedCoordinatorRecoveryInFlight || outputConsumerDisposed) return;
    failedCoordinatorRecoveryInFlight = true;
    isSyncingInitialBuffer = true;
    const retiringCoordinator = runtime.writeCoordinator;

    void (async () => {
      const drained = await retiringCoordinator.waitForDrain(
        TERMINAL_WRITE_RECOVERY_DRAIN_TIMEOUT_MS,
      );
      if (outputConsumerDisposed) return;

      const currentGeneration = Number.isSafeInteger(attachedRuntimeGeneration)
        ? (attachedRuntimeGeneration as number)
        : requestedGeneration;
      if (!drained) {
        failedCoordinatorRecoveryInFlight = false;
        terminalFlowApi.reportOutputFailure?.(
          config.id,
          outputConsumerId,
          currentGeneration,
          "Timed out waiting for older visible xterm writes before recovery.",
        );
        return;
      }

      try {
        // A parser exception can leave xterm's internal mode state suspect.
        // Reset the parser and rebuild the visible tail from the same bounded
        // backend buffer used to recover the headless xterm.
        runtime.term.reset();
        clearActivityOffsetAnchors();
        replaceRuntimeWriteCoordinator(runtime);
        lastBufferOffset = 0;
        lastCommittedBufferOffset = 0;
        failedWriteCoordinatorGeneration = undefined;
        writeCoordinatorRuntimeGeneration = currentGeneration;
        installWriteCoordinatorFailureHandler(currentGeneration);

        const initial = await window.gyshell.terminal.getBufferDelta(
          config.id,
          0,
        );
        if (outputConsumerDisposed) return;
        const metadata = await loadTerminalRecoveryMetadata(
          window.gyshell.terminal,
          config.id,
        );
        activityRuntime.recover(metadata);
        const replayEvents = pendingLiveEvents.splice(
          0,
          pendingLiveEvents.length,
        );
        const latestGeneration = [...replayEvents]
          .reverse()
          .find((event) =>
            Number.isSafeInteger(event.runtimeGeneration),
          )?.runtimeGeneration;
        const replayGeneration = Number.isSafeInteger(latestGeneration)
          ? (latestGeneration as number)
          : currentGeneration;
        attachedRuntimeGeneration = replayGeneration;
        writeCoordinatorRuntimeGeneration = replayGeneration;
        installWriteCoordinatorFailureHandler(replayGeneration);
        replayBufferedOutput(
          {
            ...initial,
            sessionBoundaries: metadata.sessionBoundaries,
          },
          replayEvents,
          replayGeneration,
          true,
        );
      } catch (error) {
        failedCoordinatorRecoveryInFlight = false;
        failedWriteCoordinatorGeneration = currentGeneration;
        terminalFlowApi.reportOutputFailure?.(
          config.id,
          outputConsumerId,
          currentGeneration,
          error instanceof Error ? error.message : String(error),
        );
      }
    })();
  };

  function processBufferedOutputEvent(
    event: BufferedTerminalOutputEvent,
  ): void {
    if (Number.isSafeInteger(event.runtimeGeneration)) {
      const eventGeneration = event.runtimeGeneration as number;
      attachedRuntimeGeneration = Number.isSafeInteger(
        attachedRuntimeGeneration,
      )
        ? Math.max(attachedRuntimeGeneration as number, eventGeneration)
        : eventGeneration;
    }

    if (Number.isSafeInteger(failedWriteCoordinatorGeneration)) {
      isSyncingInitialBuffer = true;
      pendingLiveEvents.push(event);
      if (
        Number.isSafeInteger(event.runtimeGeneration) &&
        event.runtimeGeneration !== failedWriteCoordinatorGeneration
      ) {
        beginFailedCoordinatorRecovery(event.runtimeGeneration as number);
      }
      return;
    }

    if (
      !isSyncingInitialBuffer &&
      Number.isSafeInteger(event.runtimeGeneration) &&
      hasTerminalLiveOffsetGap(lastBufferOffset, event)
    ) {
      const eventGeneration = event.runtimeGeneration as number;
      isSyncingInitialBuffer = true;
      pendingLiveEvents.push(event);
      failedWriteCoordinatorGeneration = eventGeneration;
      terminalFlowApi.reportOutputFailure?.(
        config.id,
        outputConsumerId,
        eventGeneration,
        `Visible terminal output gap detected before offset ${String(event.offset)}.`,
      );
      return;
    }

    prepareWriteCoordinatorForGeneration(event.runtimeGeneration);
    if (isSyncingInitialBuffer) {
      pendingLiveEvents.push(event);
      return;
    }
    writeDataWithOffset(
      event.data,
      event.offset,
      event,
      false,
      () => acknowledgeBufferedEvent(event),
      (error) => reportBufferedEventFailure(event, error),
    );
  }

  const cleanup = window.gyshell.terminal.onData(
    ({
      terminalId,
      data,
      offset,
      remoteOs,
      windowsRelease,
      outputSequence,
      runtimeGeneration,
    }) => {
      if (terminalId === config.id) {
        processBufferedOutputEvent({
          data,
          offset,
          remoteOs,
          windowsRelease,
          outputSequence,
          runtimeGeneration,
        });
      }
    },
  );
  let outputAttachmentPromise: Promise<
    | {
        runtimeGeneration?: number;
        data: string;
        offset: number;
        remoteOs?: TerminalRemoteOs;
        windowsRelease?: string;
        sessionBoundaries?: TerminalSessionBoundary[];
      }
    | undefined
  > = Promise.resolve(undefined);
  if (typeof terminalFlowApi.attachOutputConsumer === "function") {
    outputAttachmentPromise = (async () => {
      let attempt = 0;
      while (!outputConsumerDisposed) {
        try {
          const result = await terminalFlowApi.attachOutputConsumer!(
            config.id,
            outputConsumerId,
          );
          if (outputConsumerDisposed) {
            terminalFlowApi.detachOutputConsumer?.(config.id, outputConsumerId);
            return undefined;
          }
          if (Number.isSafeInteger(result?.runtimeGeneration)) {
            attachedRuntimeGeneration = result.runtimeGeneration;
            prepareWriteCoordinatorForGeneration(result.runtimeGeneration);
          }
          outputConsumerAttached = true;
          return result;
        } catch (error) {
          attempt += 1;
          if (attempt === 1 || attempt % 5 === 0) {
            console.warn(
              `[XTermView] Failed to attach output consumer for ${config.id}; retrying (attempt ${attempt}).`,
              error,
            );
          }
          await new Promise<void>((resolve) => {
            window.setTimeout(resolve, Math.min(1000, 50 * 2 ** attempt));
          });
        }
      }
      return undefined;
    })();
  }

  const plainConfig = toPlainConfig(config);
  const dims = fit.proposeDimensions();
  const size = resolveTerminalSize(dims, {
    cols: term.cols,
    rows: term.rows,
  });
  window.gyshell.terminal
    .createTab({ ...plainConfig, cols: size.cols, rows: size.rows })
    .catch(() => {
      // ignore: backend is idempotent and may fail during hot reload; user will see logs in devtools
    });
  requestBackendResize(runtime, size.cols, size.rows);

  const syncBufferedOutput = async (): Promise<void> => {
    try {
      const attachment = await outputAttachmentPromise;
      if (outputConsumerDisposed) return;
      const initial =
        attachment || {
          ...(await window.gyshell.terminal.getBufferDelta(config.id, 0)),
          sessionBoundaries: undefined,
        };
      const metadata = await loadTerminalRecoveryMetadata(
        window.gyshell.terminal,
        config.id,
      );
      activityRuntime.recover(metadata);
      const replayEvents = pendingLiveEvents.splice(
        0,
        pendingLiveEvents.length,
      );
      const latestGeneration = [...replayEvents]
        .reverse()
        .find((event) =>
          Number.isSafeInteger(event.runtimeGeneration),
        )?.runtimeGeneration;
      replayBufferedOutput(
        {
          ...initial,
          sessionBoundaries:
            initial.sessionBoundaries ?? metadata.sessionBoundaries,
        },
        replayEvents,
        Number.isSafeInteger(latestGeneration)
          ? latestGeneration
          : attachedRuntimeGeneration,
      );
    } catch (error) {
      const failureGeneration = Number.isSafeInteger(attachedRuntimeGeneration)
        ? (attachedRuntimeGeneration as number)
        : [...pendingLiveEvents]
            .reverse()
            .find((event) => Number.isSafeInteger(event.runtimeGeneration))
            ?.runtimeGeneration;
      if (Number.isSafeInteger(failureGeneration)) {
        failedWriteCoordinatorGeneration = failureGeneration;
        terminalFlowApi.reportOutputFailure?.(
          config.id,
          outputConsumerId,
          failureGeneration as number,
          error instanceof Error ? error.message : String(error),
        );
      } else {
        console.warn(
          `[XTermView] Initial terminal buffer replay failed for ${config.id}.`,
          error,
        );
        isSyncingInitialBuffer = false;
        flushPendingLiveEvents();
      }
    }
  };
  void syncBufferedOutput();

  runtime.cleanupBackendData = () => {
    activityRuntime.dispose();
    cleanup();
    clearActivityOffsetAnchors();
    outputConsumerDisposed = true;
    if (outputConsumerAttached) {
      terminalFlowApi.detachOutputConsumer?.(config.id, outputConsumerId);
      outputConsumerAttached = false;
    }
  };
  runtime.cleanupContextMenuListener = removeContextMenuListener;
  runtime.inputDispose = () => inputDisposable.dispose();
  runtime.selectionDispose = () => selectionDisposable.dispose();
  runtime.scrollDispose = () => scrollDisposable.dispose();
  runtime.removeDomListeners = () => {
    mountEl.removeEventListener("paste", handlePaste);
    mountEl.removeEventListener("dragover", handleDragOver, true);
    mountEl.removeEventListener("drop", handleDrop, true);
    mountEl.removeEventListener("contextmenu", handleContextMenu);
  };

  return runtime;
};

const acquireRuntime = (
  config: TerminalConfig,
  theme: ITheme,
  settings: TerminalSettings | undefined,
  supportsFilesystem: boolean,
  uiOwnershipCheck?: () => boolean,
  remoteOs?: TerminalRemoteOs,
  systemInfo?: TerminalSystemInfoLike,
): TerminalRuntime => {
  let runtime = runtimePool.get(config.id);
  if (!runtime) {
    runtime = createRuntime(
      config,
      theme,
      settings,
      supportsFilesystem,
      remoteOs,
      systemInfo,
    );
    runtimePool.set(config.id, runtime);
  }
  if (uiOwnershipCheck) {
    runtime.uiOwnershipCheck = uiOwnershipCheck;
  }
  runtime.supportsFilesystem = supportsFilesystem;
  runtime.refCount += 1;
  clearTimer(runtime.releaseTimer);
  runtime.releaseTimer = null;
  return runtime;
};

const releaseRuntime = (
  terminalId: string,
  options?: {
    decrementRefCount?: boolean;
  },
): void => {
  const runtime = runtimePool.get(terminalId);
  if (!runtime) return;
  if (options?.decrementRefCount !== false) {
    runtime.refCount = Math.max(0, runtime.refCount - 1);
  }
  if (runtime.refCount > 0) return;

  clearTimer(runtime.releaseTimer);
  runtime.releaseTimer = window.setTimeout(() => {
    const pending = runtimePool.get(terminalId);
    if (!pending || pending.refCount > 0) return;
    if (!isRuntimeOwnedByUi(pending.uiOwnershipCheck)) {
      disposeRuntime(pending);
      runtimePool.delete(terminalId);
      return;
    }

    isTerminalTrackedByBackend(terminalId).then((stillTrackedByBackend) => {
      const latest = runtimePool.get(terminalId);
      if (!latest || latest.refCount > 0) return;
      if (!isRuntimeOwnedByUi(latest.uiOwnershipCheck)) {
        disposeRuntime(latest);
        runtimePool.delete(terminalId);
        return;
      }

      if (stillTrackedByBackend) {
        latest.releaseTimer = window.setTimeout(() => {
          releaseRuntime(terminalId, { decrementRefCount: false });
        }, RUNTIME_RELEASE_DELAY);
        return;
      }

      disposeRuntime(latest);
      runtimePool.delete(terminalId);
    });
  }, RUNTIME_RELEASE_DELAY);
};

export const XTermView = React.forwardRef<XTermSearchHandle, XTermViewProps>(
  function XTermView(props, ref): React.ReactElement {
    const hostRef = useRef<HTMLDivElement>(null);
    const runtimeRef = useRef<TerminalRuntime | null>(null);
    const searchHandleRef = useRef<XTermSearchHandle | null>(null);
    const onSearchResultsChangeRef = useRef<
      TerminalSearchResultsChangeHandler | undefined
    >(props.onSearchResultsChange);
    const aliveRef = useRef(true);
    const isActiveRef = useRef(props.isActive !== false);
    const commandDraftFailureTimerRef = useRef<number | null>(null);
    const lastHandledDraftRequestIdRef = useRef(0);
    const lastPointerRef = useRef<{ x: number; y: number } | null>(null);
    const [hiddenConnectionFailureAt, setHiddenConnectionFailureAt] =
      useState<number | null>(null);
    const [commandDraftOpen, setCommandDraftOpen] = useState(false);
    const [commandDraftInput, setCommandDraftInput] = useState("");
    const [commandDraftPending, setCommandDraftPending] = useState(false);
    const [commandDraftFailed, setCommandDraftFailed] = useState(false);
    const [commandDraftPosition, setCommandDraftPosition] = useState<{
      left: number;
      top: number;
      width?: number;
    } | null>(null);
    const [commandDraftSpinnerFrame, setCommandDraftSpinnerFrame] = useState(0);
    // The runtime's xterm, as state so both views re-render when it changes.
    const [runtimeTerminal, setRuntimeTerminal] = useState<Terminal | null>(
      null,
    );
    const {
      activities,
      sessionBoundaries,
      blockFocusRequest,
      selectedCommandId,
      activityLayoutRevision,
      setBlockFocusRequest,
      setSelectedCommandId,
    } = useTerminalActivities(runtimeRef, props.config.id, runtimeTerminal);
    const [blockNative, setBlockNative] = useState(false);
    const pendingRevealRef = useRef<{ activityId: string }>();
    const revealFlashRef = useRef<() => void>();
    // The Block view always docks the active prompt (the real xterm) at the
    // bottom; only the alternate-screen fallback shows the full terminal.
    // A disconnected session has no prompt to dock (connecting keeps it:
    // SSH password and host-key prompts are answered there).
    const dockVisible =
      props.terminalViewMode === "block" &&
      !blockNative &&
      props.runtimeState !== "exited" &&
      props.isActive !== false;
    const dockActivitiesRef = useRef(activities);
    dockActivitiesRef.current = activities;
    const getDockAnchor = useCallback(
      () =>
        resolveTerminalDockAnchor(dockActivitiesRef.current, (activityId) =>
          runtimeRef.current?.activityMarkers.get(activityId),
        ),
      [],
    );
    const dock = useTerminalBlockDock(
      runtimeTerminal,
      hostRef.current,
      dockVisible,
      TERMINAL_FOOTER_HEIGHT_PX,
      getDockAnchor,
    );
    const resolvedCommandDraftShortcut =
      props.commandDraftShortcut ?? getDefaultCommandDraftShortcut();

    useImperativeHandle(
      ref,
      () =>
        getOrCreateTerminalSearchHandle(
          searchHandleRef,
          runtimeRef,
          onSearchResultsChangeRef,
          TERMINAL_SEARCH_OPTIONS,
        ),
      [],
    );

    useEffect(() => {
      aliveRef.current = true;
      return () => {
        aliveRef.current = false;
        if (commandDraftFailureTimerRef.current !== null) {
          window.clearTimeout(commandDraftFailureTimerRef.current);
          commandDraftFailureTimerRef.current = null;
        }
      };
    }, []);

    useEffect(() => {
      onSearchResultsChangeRef.current = props.onSearchResultsChange;
    }, [props.onSearchResultsChange]);

    const resolveDraftPosition = useCallback(
      (
        placement: "center" | "pointer",
      ): { left: number; top: number; width?: number } | null => {
        const hostEl = hostRef.current;
        if (!hostEl) return null;
        const rect = hostEl.getBoundingClientRect();
        const preferredWidth = Math.min(
          460,
          Math.max(320, Math.floor(rect.width * 0.48)),
        );
        const pointer = placement === "pointer" ? lastPointerRef.current : null;
        const leftFromPointer = pointer
          ? pointer.x - Math.floor(preferredWidth * 0.25)
          : rect.left + Math.round((rect.width - preferredWidth) / 2);
        const topFromPointer = pointer ? pointer.y + 18 : rect.top + 28;
        const minLeft = 12;
        const maxLeft = Math.max(
          minLeft,
          window.innerWidth - preferredWidth - 12,
        );
        const left = Math.min(
          maxLeft,
          Math.max(minLeft, Math.round(leftFromPointer)),
        );
        const estimatedHeight = 138;
        const minTop = Math.max(8, rect.top + 8);
        const maxTop = Math.max(
          minTop,
          Math.min(
            window.innerHeight - estimatedHeight - 12,
            rect.bottom - estimatedHeight - 8,
          ),
        );
        const top = Math.min(
          maxTop,
          Math.max(minTop, Math.round(topFromPointer)),
        );
        return {
          left,
          top,
          width: preferredWidth,
        };
      },
      [],
    );

    const openCommandDraft = useCallback(
      (placement: "center" | "pointer") => {
        if (commandDraftPending) {
          return;
        }
        setCommandDraftInput("");
        setCommandDraftPosition(resolveDraftPosition(placement));
        setCommandDraftOpen(true);
      },
      [commandDraftPending, resolveDraftPosition],
    );

    const submitCommandDraft = useCallback(async () => {
      const prompt = commandDraftInput.trim();
      const profileId = String(props.commandDraftProfileId || "").trim();
      if (!prompt || commandDraftPending || !profileId) return;

      if (commandDraftFailureTimerRef.current !== null) {
        window.clearTimeout(commandDraftFailureTimerRef.current);
        commandDraftFailureTimerRef.current = null;
      }
      setCommandDraftFailed(false);
      setCommandDraftOpen(false);
      setCommandDraftPending(true);
      setCommandDraftPosition(null);
      setCommandDraftInput("");
      const startedAt = Date.now();
      console.debug("[TerminalCommandDraftUI] Start", {
        terminalId: props.config.id,
        profileId,
        promptChars: prompt.length,
      });

      try {
        const result = await window.gyshell.terminal.generateCommandDraft(
          props.config.id,
          prompt,
          profileId,
        );
        const command =
          typeof result?.command === "string" ? result.command : "";
        const runtime = runtimeRef.current;
        if (
          !runtime ||
          runtime.terminalId !== props.config.id ||
          !command.trim()
        ) {
          console.debug("[TerminalCommandDraftUI] Empty result", {
            terminalId: props.config.id,
            profileId,
            elapsedMs: Date.now() - startedAt,
          });
          return;
        }
        if (isActiveRef.current) {
          runtime.term.focus();
        }
        runtime.term.paste(command);
        console.debug("[TerminalCommandDraftUI] Finished", {
          terminalId: props.config.id,
          profileId,
          elapsedMs: Date.now() - startedAt,
          commandChars: command.length,
        });
      } catch (error) {
        console.warn("[TerminalCommandDraftUI] Failed", {
          terminalId: props.config.id,
          profileId,
          elapsedMs: Date.now() - startedAt,
          error: error instanceof Error ? error.message : String(error),
        });
        if (aliveRef.current) {
          setCommandDraftFailed(true);
          commandDraftFailureTimerRef.current = window.setTimeout(() => {
            commandDraftFailureTimerRef.current = null;
            if (aliveRef.current) {
              setCommandDraftFailed(false);
            }
          }, COMMAND_DRAFT_FAILURE_VISIBILITY_MS);
        }
      } finally {
        if (aliveRef.current) {
          setCommandDraftPending(false);
        }
      }
    }, [
      commandDraftInput,
      commandDraftPending,
      props.commandDraftProfileId,
      props.config.id,
    ]);

    useEffect(() => {
      if (!commandDraftPending) {
        setCommandDraftSpinnerFrame(0);
        return;
      }
      const timer = window.setInterval(() => {
        setCommandDraftSpinnerFrame(
          (current) => (current + 1) % COMMAND_DRAFT_SPINNER_FRAMES.length,
        );
      }, 90);
      return () => {
        window.clearInterval(timer);
      };
    }, [commandDraftPending]);

    useEffect(() => {
      if (props.isActive !== false) {
        return;
      }
      if (commandDraftFailureTimerRef.current !== null) {
        window.clearTimeout(commandDraftFailureTimerRef.current);
        commandDraftFailureTimerRef.current = null;
      }
      setCommandDraftOpen(false);
      setCommandDraftFailed(false);
      setCommandDraftPosition(null);
    }, [props.isActive]);

    useEffect(() => {
      isActiveRef.current = props.isActive !== false;
    }, [props.isActive]);

    useEffect(() => {
      const request = props.commandDraftOpenRequest;
      if (
        !request ||
        request.terminalId !== props.config.id ||
        commandDraftPending
      ) {
        return;
      }
      if (request.id === lastHandledDraftRequestIdRef.current) {
        return;
      }
      lastHandledDraftRequestIdRef.current = request.id;
      openCommandDraft(request.placement);
      props.onCommandDraftOpenRequestHandled?.(request.id, request.terminalId);
    }, [
      commandDraftPending,
      openCommandDraft,
      props.commandDraftOpenRequest,
      props.config.id,
      props.onCommandDraftOpenRequestHandled,
    ]);

    useEffect(() => {
      const hostEl = hostRef.current;
      if (!hostEl) return;

      const runtime = acquireRuntime(
        props.config,
        props.theme,
        props.terminalSettings,
        props.supportsFilesystem,
        props.isOwnedByUi,
        props.remoteOs,
        props.systemInfo,
      );
      runtime.selectionHandler = props.onSelectionChange;
      runtime.settings = props.terminalSettings;
      runtime.uiOwnershipCheck = props.isOwnedByUi;
      runtime.isActive = props.isActive ?? false;
      runtimeRef.current = runtime;
      attachRuntimeToHost(runtime, hostEl);
      setRuntimeTerminal(runtime.term);
      setBlockNative(false);

      const handleResize = () => {
        const activeRuntime = runtimeRef.current;
        if (!activeRuntime?.isActive) return;
        scheduleRuntimeRefit(activeRuntime);
      };

      const handleRecoveryHint = () => {
        const recoveryEpoch = noteTerminalRecoveryEvent();
        const activeRuntime = runtimeRef.current;
        if (!activeRuntime?.isActive) return;
        scheduleRuntimeRecoveryRefit(activeRuntime, recoveryEpoch);
      };

      const handleVisibilityChange = () => {
        if (document.visibilityState !== "visible") return;
        handleRecoveryHint();
      };

      window.addEventListener("resize", handleResize);
      window.addEventListener("pageshow", handleRecoveryHint);
      document.addEventListener("visibilitychange", handleVisibilityChange);
      const resizeObserver =
        typeof ResizeObserver !== "undefined"
          ? new ResizeObserver(() => {
              const activeRuntime = runtimeRef.current;
              if (!activeRuntime?.isActive) return;
              scheduleRuntimeRefit(activeRuntime);
            })
          : null;
      resizeObserver?.observe(hostEl);
      const removeRecoveryHintListener =
        typeof window.gyshell.terminal.onRecoveryHint === "function"
          ? window.gyshell.terminal.onRecoveryHint((payload) => {
              if (!normalizeTerminalRecoveryReason(payload?.reason)) return;
              handleRecoveryHint();
            })
          : () => {};

      return () => {
        window.removeEventListener("resize", handleResize);
        window.removeEventListener("pageshow", handleRecoveryHint);
        document.removeEventListener(
          "visibilitychange",
          handleVisibilityChange,
        );
        resizeObserver?.disconnect();
        removeRecoveryHintListener();
        hostEl.classList.remove("is-scrollbar-visible");
        const activeRuntime = runtimeRef.current;
        if (activeRuntime && activeRuntime.terminalId === props.config.id) {
          runtimeRef.current = null;
        }
        releaseRuntime(props.config.id);
      };
    }, [props.config.id]);

    useEffect(() => {
      const hostEl = hostRef.current;
      if (!hostEl || !resolvedCommandDraftShortcut) return;

      const handleMouseMove = (event: MouseEvent) => {
        lastPointerRef.current = { x: event.clientX, y: event.clientY };
      };

      const handleKeyDown = (event: KeyboardEvent) => {
        if (!props.isActive || commandDraftPending) {
          return;
        }
        if (
          event.repeat ||
          !matchesCommandDraftShortcut(event, resolvedCommandDraftShortcut)
        ) {
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        openCommandDraft("pointer");
      };

      hostEl.addEventListener("mousemove", handleMouseMove, true);
      hostEl.addEventListener("keydown", handleKeyDown, true);

      return () => {
        hostEl.removeEventListener("mousemove", handleMouseMove, true);
        hostEl.removeEventListener("keydown", handleKeyDown, true);
      };
    }, [
      commandDraftPending,
      openCommandDraft,
      props.isActive,
      resolvedCommandDraftShortcut,
    ]);

    useEffect(() => {
      const runtime = runtimeRef.current;
      if (!runtime) return;
      runtime.selectionHandler = props.onSelectionChange;
    }, [props.onSelectionChange, props.config.id]);

    useEffect(() => {
      const runtime = runtimeRef.current;
      if (!runtime) {
        return;
      }
      const disposable = runtime.searchAddon.onDidChangeResults((payload) => {
        onSearchResultsChangeRef.current?.({
          resultCount: payload.resultCount,
          resultIndex: payload.resultIndex,
        });
      });
      return () => {
        disposable.dispose();
      };
    }, [props.config.id]);

    useEffect(() => {
      const runtime = runtimeRef.current;
      if (!runtime) return;
      runtime.settings = props.terminalSettings;
    }, [props.terminalSettings, props.config.id]);

    useEffect(() => {
      const runtime = runtimeRef.current;
      if (!runtime) return;
      runtime.uiOwnershipCheck = props.isOwnedByUi;
      runtime.supportsFilesystem = props.supportsFilesystem;
    }, [props.isOwnedByUi, props.supportsFilesystem, props.config.id]);

    useEffect(() => {
      const runtime = runtimeRef.current;
      if (!runtime) return;
      runtime.isActive = props.isActive ?? false;
      if (runtime.isActive) {
        if (
          shouldScheduleTerminalRecoveryOnActivate({
            recoveryEpoch: terminalRecoveryEpoch,
            lastHandledRecoveryEpoch: runtime.lastHandledRecoveryEpoch,
            pendingRecoveryRefit: runtime.pendingRecoveryRefit,
          })
        ) {
          scheduleRuntimeRecoveryRefit(runtime, terminalRecoveryEpoch);
        } else {
          scheduleRuntimeRefit(runtime);
        }
      }
    }, [props.isActive, props.config.id]);

    useEffect(() => {
      const runtime = runtimeRef.current;
      if (!runtime) return;

      const transition = createRuntimeWindowsPtyTransition(
        runtime,
        {
          remoteOs: props.remoteOs,
          windowsRelease: props.systemInfo?.release,
        },
        () => {
          if (runtime.isActive) {
            requestAnimationFrame(() => {
              const activeRuntime = runtimeRef.current;
              if (
                !activeRuntime ||
                activeRuntime.terminalId !== props.config.id
              )
                return;
              scheduleRuntimeRecoveryRefit(activeRuntime);
            });
            return;
          }
          runtime.pendingRecoveryRefit = true;
        },
      );
      runtime.writeCoordinator.write("", transition);
    }, [props.remoteOs, props.systemInfo?.release, props.config.id]);

    // Live-update theme (Tabby-style behavior)
    useEffect(() => {
      const runtime = runtimeRef.current;
      if (!runtime) return;
      runtime.term.options.theme = props.theme;
    }, [props.theme, props.config.id]);

    // Shared with the Block view so its rows match the docked prompt.
    const terminalFont = React.useMemo(
      () =>
        resolveTerminalFontOptions({
          fontSize: props.terminalSettings?.fontSize,
          lineHeight: props.terminalSettings?.lineHeight,
        }),
      [props.terminalSettings?.fontSize, props.terminalSettings?.lineHeight],
    );

    // Live-update terminal settings
    useEffect(() => {
      const runtime = runtimeRef.current;
      if (!runtime) return;
      runtime.settings = props.terminalSettings;
      const options = runtime.term.options;
      applyTerminalFontOptions(runtime.term, terminalFont);
      if (props.terminalSettings?.scrollback !== undefined)
        options.scrollback = props.terminalSettings.scrollback;
      if (props.terminalSettings?.cursorStyle)
        options.cursorStyle = props.terminalSettings.cursorStyle;
      if (props.terminalSettings?.cursorBlink !== undefined)
        options.cursorBlink = props.terminalSettings.cursorBlink;

      // Refit after changes
      requestAnimationFrame(() => {
        if (!props.isActive) return;
        const activeRuntime = runtimeRef.current;
        if (!activeRuntime || activeRuntime.terminalId !== props.config.id)
          return;
        scheduleRuntimeRefit(activeRuntime);
      });
    }, [
      terminalFont,
      props.terminalSettings?.scrollback,
      props.terminalSettings?.cursorStyle,
      props.terminalSettings?.cursorBlink,
      props.config.id,
      props.isActive,
    ]);

    // Re-fit when the tab becomes active (Tabby-like behavior)
    useEffect(() => {
      if (!props.isActive) return;
      const runtime = runtimeRef.current;
      if (!runtime || runtime.terminalId !== props.config.id) return;
      requestAnimationFrame(() => {
        const activeRuntime = runtimeRef.current;
        if (!activeRuntime || activeRuntime.terminalId !== props.config.id)
          return;
        scheduleRuntimeRefit(activeRuntime);
      });
    }, [props.isActive, props.layoutSignature, props.config.id]);

    const blockLabels = props.blockLabels;
    const connectionFailureReason =
      props.connectionStatus?.phase === "failed"
        ? props.connectionStatus.lines.map((line) => line.text).join(" · ")
        : "";
    const usesNormalBuffer =
      runtimeRef.current?.term.buffer.active.type === "normal";
    const contextActivity = selectTerminalActivityContext(activities);
    const contextMarker = contextActivity
      ? runtimeRef.current?.activityMarkers.get(contextActivity.id)?.start
      : undefined;
    const contextStatus = contextActivity
      ? blockStatusText(contextActivity, blockLabels)
      : "";

    const commandAnnotations = React.useMemo<
      TerminalCommandAnnotation[]
    >(() => {
      const runtime = runtimeRef.current;
      if (!runtime) return [];
      return activities.flatMap((activity) => {
        const range = runtime.activityMarkers.get(activity.id);
        if (!range?.start || range.start.isDisposed) return [];
        return [
          {
            id: activity.id,
            startLine: range.start.line,
            endLine:
              range.end && !range.end.isDisposed
                ? range.end.line + (range.endAtLineStart ? 0 : 1)
                : undefined,
            endSharesNextRow:
              !!range.end && !range.end.isDisposed && !range.endAtLineStart,
            activity,
            bufferPreview: !activity.command
              ? resolvePromptPreview(
                  readTerminalBlockLogicalLine(
                    runtime.term.buffer.normal,
                    range.start.line,
                    runtime.term.buffer.normal.length,
                    runtime.term.cols,
                  )?.text,
                )
              : undefined,
          },
        ];
      });
    }, [activities, activityLayoutRevision]);
    const navigableAnnotations = React.useMemo(
      () => getNavigableTerminalAnnotations(commandAnnotations),
      [commandAnnotations],
    );

    // A rewritten prompt can share a marker row with an older command. Match
    // the Block projection's last-boundary-wins rule before offering a jump.
    const canInspectContext = Boolean(
      contextMarker &&
      !contextMarker.isDisposed &&
      props.onTerminalViewModeChange &&
      commandAnnotations
        .filter((entry) => entry.startLine === contextMarker.line)
        .at(-1)?.id === contextActivity?.id,
    );

    const contextTitle = contextActivity
      ? contextActivity.intent ||
        contextActivity.command ||
        commandAnnotations.find((entry) => entry.id === contextActivity.id)
          ?.bufferPreview ||
        blockLabels.output
      : "";

    const inspectCommand = (activityId: string) => {
      setSelectedCommandId(activityId);
      setBlockFocusRequest((current) => ({
        activityId,
        revision: (current?.revision || 0) + 1,
      }));
      props.onTerminalViewModeChange?.("block");
    };
    /** Viewport top that shows the command row near the top, with a little
     *  of the previous output above it; undefined when it cannot be shown. */
    const resolveCommandRevealTop = (activityId: string): number | undefined => {
      const runtime = runtimeRef.current;
      const marker = runtime?.activityMarkers.get(activityId)?.start;
      if (
        !runtime ||
        runtime.term.buffer.active.type !== "normal" ||
        !marker ||
        marker.isDisposed
      ) {
        return undefined;
      }
      return resolveTerminalRevealTop({
        commandLine: marker.line,
        viewportRows: runtime.term.rows,
        maxTop: runtime.term.buffer.active.baseY,
      });
    };
    /** Briefly tints the command's rows so the eye lands on them. */
    const flashCommandRows = (activityId: string) => {
      const runtime = runtimeRef.current;
      const marker = runtime?.activityMarkers.get(activityId)?.start;
      revealFlashRef.current?.();
      revealFlashRef.current = undefined;
      if (!runtime || !marker || marker.isDisposed) return;
      const { term } = runtime;
      const buffer = term.buffer.normal;
      const echo = readTerminalBlockLogicalLine(
        buffer,
        marker.line,
        Math.min(buffer.length, marker.line + 16),
        term.cols,
      );
      const height = Math.max(1, (echo?.endLine ?? marker.line + 1) - marker.line);
      // Own marker: disposing the flash must never touch the Activity marker.
      const flashMarker = term.registerMarker(
        marker.line - (buffer.baseY + buffer.cursorY),
      );
      if (!flashMarker) return;
      const decoration = term.registerDecoration({
        marker: flashMarker,
        width: term.cols,
        height,
        layer: "top",
      });
      decoration?.onRender((element) =>
        element.classList.add("terminal-reveal-flash"),
      );
      const timer = window.setTimeout(() => dispose(), TERMINAL_REVEAL_FLASH_MS);
      const dispose = () => {
        window.clearTimeout(timer);
        decoration?.dispose();
        flashMarker.dispose();
      };
      revealFlashRef.current = dispose;
    };
    const revealCommandInTerminal = (activityId: string) => {
      setSelectedCommandId(activityId);
      props.onTerminalViewModeChange?.("classic");
      // Leaving the Block view refits xterm a frame or two later, and xterm
      // re-syncs its scroll position after a resize (shifting it by the row
      // delta). Hold the landing until the layout has been stable for a few
      // frames; a wheel by the user cancels it (see the effect below).
      const token = { activityId };
      pendingRevealRef.current = token;
      const startedAt = performance.now();
      let stableFrames = 0;
      let flashed = false;
      const step = () => {
        const runtime = runtimeRef.current;
        if (!runtime || pendingRevealRef.current !== token) return;
        const top = resolveCommandRevealTop(activityId);
        if (top === undefined) {
          pendingRevealRef.current = undefined;
          return;
        }
        if (runtime.term.buffer.active.viewportY !== top) {
          runtime.term.scrollToLine(top);
          stableFrames = 0;
        } else {
          stableFrames += 1;
        }
        if (!flashed) {
          flashed = true;
          flashCommandRows(activityId);
        }
        if (stableFrames < 6 && performance.now() - startedAt < 1000) {
          requestAnimationFrame(step);
        } else {
          pendingRevealRef.current = undefined;
        }
      };
      requestAnimationFrame(step);
    };
    // A user scroll ends a pending landing; unmount clears the flash.
    useEffect(() => {
      const host = hostRef.current;
      const cancel = () => {
        pendingRevealRef.current = undefined;
      };
      host?.addEventListener("wheel", cancel, { passive: true });
      return () => {
        host?.removeEventListener("wheel", cancel);
        pendingRevealRef.current = undefined;
        revealFlashRef.current?.();
        revealFlashRef.current = undefined;
      };
    }, []);

    // Connecting / disconnected state for either footer (Terminal or Block).
    const connectionStatusNode =
      props.runtimeState === "initializing" ? (
        <span className="terminal-connection-status" aria-live="polite">
          <LoaderCircle size={13} aria-hidden="true" />
          <span>
            {props.connectionStatusLabel}
          </span>
        </span>
      ) : props.runtimeState === "exited" ? (
        connectionFailureReason ? (
          <button
            type="button"
            className="terminal-connection-status is-exited is-failed"
            title={connectionFailureReason}
            onClick={() => setHiddenConnectionFailureAt(null)}
          >
            <span>{props.disconnectedStatusLabel}</span>
            <span className="terminal-connection-status-reason">
              {connectionFailureReason}
            </span>
          </button>
        ) : (
          <span className="terminal-connection-status is-exited">
            {props.disconnectedStatusLabel}
          </span>
        )
      ) : null;

    // Classic view only: the Block view is itself the command list (gutter
    // jumps and the footer context still open a block there).
    const commandNavigator = () => (
      <TerminalCommandNavigator
        annotations={navigableAnnotations}
        labels={props.commandNavigatorLabels}
        selectedId={selectedCommandId}
        disabled={
          !usesNormalBuffer ||
          props.isActive === false ||
          props.terminalViewMode === "block"
        }
        onNavigate={revealCommandInTerminal}
      />
    );

    React.useLayoutEffect(() => {
      const mount = runtimeRef.current?.mountEl;
      if (!mount) return;
      const reading =
        props.terminalViewMode === "block" && !blockNative && !dockVisible;
      mount.inert = reading;
      if (reading) runtimeRef.current?.term.blur();
      return () => {
        mount.inert = false;
      };
    }, [props.terminalViewMode, blockNative, runtimeTerminal, dockVisible]);

    useEffect(() => {
      const runtime = runtimeRef.current;
      if (!runtime || runtime.terminalId !== props.config.id) return;
      const frame = window.requestAnimationFrame(() => {
        scheduleRuntimeRefit(runtime);
      });
      return () => window.cancelAnimationFrame(frame);
    }, [props.config.id, props.isActive, props.terminalViewMode]);

    return (
      <>
        <div
          className={`xterm-shell${props.terminalViewMode === "block" ? ` is-block-mode${blockNative ? " is-block-native" : ""}${dockVisible ? " is-block-input" : ""}` : ""}`}
          style={TERMINAL_VIEW_CHROME_STYLE}
        >
          <div className="xterm-host" ref={hostRef} />
          {runtimeTerminal && props.terminalViewMode === "classic" ? (
            <TerminalCommandMarks
              terminal={runtimeTerminal}
              annotations={navigableAnnotations}
              selectedId={selectedCommandId}
              labels={blockLabels}
              onInspect={inspectCommand}
            />
          ) : null}
          <TerminalConnectionStatusCard
            status={props.connectionStatus}
            hidden={
              props.connectionStatus?.phase === "failed" &&
              hiddenConnectionFailureAt === props.connectionStatus.updatedAt
            }
            labels={props.connectionCardLabels}
            onReconnect={props.onReconnect}
            onHide={() =>
              setHiddenConnectionFailureAt(
                props.connectionStatus?.updatedAt ?? null,
              )
            }
          />
          {runtimeTerminal && props.terminalViewMode === "classic" ? (
            <TerminalSessionDividerOverlay
              terminal={runtimeTerminal}
              boundaries={sessionBoundaries}
              markers={runtimeRef.current?.sessionMarkers || new Map()}
              labels={props.dividerLabels}
              locale={props.locale}
            />
          ) : null}
          {commandDraftPending || commandDraftFailed ? (
            <div
              className={
                commandDraftFailed
                  ? "xterm-command-draft-status is-error"
                  : "xterm-command-draft-status"
              }
              aria-hidden="true"
            >
              <span className="xterm-command-draft-status-frame">
                {commandDraftPending
                  ? `[${COMMAND_DRAFT_SPINNER_FRAMES[commandDraftSpinnerFrame]}]`
                  : "[x]"}
              </span>
              <span className="xterm-command-draft-status-text">
                {commandDraftPending
                  ? props.commandDraftLabels?.pending || "drafting command"
                  : props.commandDraftLabels?.failed || "draft failed"}
              </span>
            </div>
          ) : null}
          {runtimeTerminal ? (
            <TerminalBlockView
              key={props.config.id}
              terminal={runtimeTerminal}
              annotations={commandAnnotations}
              theme={props.theme}
              font={terminalFont}
              labels={blockLabels}
              visible={props.terminalViewMode === "block"}
              isActive={
                props.isActive !== false && props.terminalViewMode === "block"
              }
              focusRequest={blockFocusRequest}
              onSelectActivity={setSelectedCommandId}
              onNativeModeChange={setBlockNative}
              onSelectionChange={props.onSelectionChange}
              copyOnSelect={props.terminalSettings?.copyOnSelect}
              rightClickToPaste={
                dockVisible && props.terminalSettings?.rightClickToPaste
              }
              viewModeLabels={props.viewModeLabels}
              onViewModeChange={props.onTerminalViewModeChange}
              dock={dockVisible ? dock : undefined}
              onRevealInTerminal={revealCommandInTerminal}
              sessionTitleLookup={props.sessionTitleLookup}
              commandSessionTitleLookup={props.commandSessionTitleLookup}
              footerStatus={connectionStatusNode}
              sessionState={
                props.runtimeState === "exited"
                  ? "disconnected"
                  : props.runtimeState === "initializing"
                    ? "connecting"
                    : undefined
              }
            />
          ) : null}
          {props.terminalViewMode === "classic" ? (
            <footer className="terminal-view-toolbar xterm-classic-toolbar">
              {connectionStatusNode ? (
                connectionStatusNode
              ) : contextActivity ? (
                <button
                  type="button"
                  className={`terminal-classic-context is-${contextActivity.actor} is-${contextActivity.status}`}
                  disabled={!canInspectContext}
                  title={`${canInspectContext ? blockLabels.openBlock : blockLabels.outputUnavailable}\n${contextTitle}`}
                  aria-label={`${canInspectContext ? blockLabels.openBlock : blockLabels.outputUnavailable}: ${contextTitle}`}
                  onClick={() => inspectCommand(contextActivity.id)}
                >
                  {contextActivity.actor === "agent" ? (
                    <Sparkles size={13} aria-label={blockLabels.agent} />
                  ) : (
                    <UserRound size={13} aria-label={blockLabels.user} />
                  )}
                  <span className="terminal-classic-context-phase">
                    {contextActivity.status === "running"
                      ? blockLabels.running
                      : blockLabels.lastCommand}
                  </span>
                  <span className="terminal-classic-context-title">
                    {contextTitle}
                  </span>
                  {contextActivity.status !== "running" ? (
                    <span className="terminal-classic-context-status">
                      {contextStatus}
                    </span>
                  ) : null}
                  {canInspectContext ? (
                    <ArrowUpRight size={12} aria-hidden="true" />
                  ) : null}
                </button>
              ) : (
                <span className="terminal-view-toolbar-idle">
                  {usesNormalBuffer
                    ? props.viewModeLabels.classic
                    : blockLabels.alternate}
                </span>
              )}
              {props.onTerminalViewModeChange ? commandNavigator() : null}
              {props.onTerminalViewModeChange ? (
                <TerminalViewSwitch
                  value="classic"
                  labels={props.viewModeLabels}
                  onChange={props.onTerminalViewModeChange}
                />
              ) : null}
            </footer>
          ) : null}
        </div>
        <TerminalCommandDraft
          open={commandDraftOpen}
          value={commandDraftInput}
          position={commandDraftPosition}
          profileId={props.commandDraftProfileId || ""}
          profileOptions={props.commandDraftProfileOptions || []}
          labels={
            props.commandDraftLabels || {
              title: "Command Draft",
              placeholder:
                "Describe what command you want to generate for this terminal tab.",
              send: "Generate",
              shortcutHint: "Open with Cmd/Ctrl+O",
              pending: "drafting command",
              failed: "draft failed",
              noProfile: "no profile",
            }
          }
          onChange={setCommandDraftInput}
          onProfileChange={(profileId) => {
            props.onCommandDraftProfileChange?.(profileId);
          }}
          onSubmit={() => {
            void submitCommandDraft();
          }}
          onCancel={() => {
            if (commandDraftPending) return;
            setCommandDraftOpen(false);
          }}
        />
      </>
    );
  },
);
