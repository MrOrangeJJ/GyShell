import React, {
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import { Terminal } from "@xterm/xterm";
import type { FontWeight, ITheme } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { WebLinksAddon } from "@xterm/addon-web-links";
import "@xterm/xterm/css/xterm.css";
import "./xtermView.scss";
import type { TerminalConfig } from "../../lib/ipcTypes";
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
  getNativeFilePathResolver,
  hasFileSystemPanelDragPayloadType,
  hasNativeFileDragType,
  resolveTerminalDropPathsForTarget,
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

const SCROLLBAR_HIDE_DELAY = 2000; // ms
const RUNTIME_RELEASE_DELAY = 4000; // ms
const TERMINAL_WRITE_RECOVERY_DRAIN_TIMEOUT_MS = 10_000;
const COMMAND_DRAFT_SPINNER_FRAMES = ["|", "/", "-", "\\"];
const COMMAND_DRAFT_FAILURE_VISIBILITY_MS = 1000;
const TERMINAL_FONT_WEIGHT: FontWeight = 500;
const TERMINAL_FONT_WEIGHT_BOLD: FontWeight = "bold";
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
  isActive?: boolean;
  layoutSignature?: string;
  onSelectionChange?: (selectionText: string) => void;
  onSearchResultsChange?: (payload: {
    resultCount: number;
    resultIndex: number;
  }) => void;
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
  isActive: boolean;
  hostEl: HTMLDivElement | null;
  refCount: number;
  releaseTimer: number | null;
  scrollHideTimer: number | null;
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
  runtime.writeCoordinator = new TerminalWriteCoordinator(
    (data, callback) => {
      runtime.term.write(data, callback);
    },
    "unknown",
  );
  installRuntimeWriteCoordinatorDrainHandler(runtime);
};

const createRuntime = (
  config: TerminalConfig,
  theme: ITheme,
  settings: TerminalSettings | undefined,
  remoteOs?: TerminalRemoteOs,
  systemInfo?: TerminalSystemInfoLike,
): TerminalRuntime => {
  const windowsPty = resolveTerminalWindowsPty(remoteOs, systemInfo);
  const term = new Terminal({
    allowTransparency: true,
    cursorBlink: settings?.cursorBlink ?? true,
    cursorStyle: settings?.cursorStyle ?? "block",
    fontSize: settings?.fontSize ?? 14,
    fontWeight: TERMINAL_FONT_WEIGHT,
    fontWeightBold: TERMINAL_FONT_WEIGHT_BOLD,
    lineHeight: Math.max(1, settings?.lineHeight ?? 1.2),
    scrollback: settings?.scrollback ?? 5000,
    theme,
    windowsPty,
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
    isActive: false,
    hostEl: null,
    refCount: 0,
    releaseTimer: null,
    scrollHideTimer: null,
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
    const paths = resolveTerminalDropPathsForTarget(
      event.dataTransfer,
      config.id,
      getNativeFilePathResolver(),
    );
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
  const terminalFlowApi = window.gyshell.terminal as typeof window.gyshell.terminal & {
    attachOutputConsumer?: (
      terminalId: string,
      consumerId: string,
    ) => Promise<{
      runtimeGeneration?: number;
      data: string;
      offset: number;
      remoteOs?: TerminalRemoteOs;
      windowsRelease?: string;
    }>;
    detachOutputConsumer?: (terminalId: string, consumerId: string) => void;
    acknowledgeOutput?: (
      terminalId: string,
      consumerId: string,
      runtimeGeneration: number,
      outputSequence: number,
    ) => void;
    reportOutputFailure?: (
      terminalId: string,
      consumerId: string,
      runtimeGeneration: number,
      errorMessage: string,
    ) => void;
  };
  const installWriteCoordinatorFailureHandler = (
    generation?: number,
  ): void => {
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
        runtime.writeCoordinator.write(
          "",
          transition,
          completion,
          failure,
        );
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
      lastCommittedBufferOffset = Math.max(
        lastCommittedBufferOffset,
        normalizedOffset,
      );
      completion?.();
    };
    const chunkStart = Math.max(0, normalizedOffset - data.length);
    if (normalizedOffset <= lastBufferOffset) {
      if (applyMetadataWhenDuplicate) {
        runtime.writeCoordinator.write(
          "",
          transition,
          completeAtOffset,
          failure,
        );
      } else {
        completion?.();
      }
      return;
    }
    if (chunkStart < lastBufferOffset) {
      const overlap = lastBufferOffset - chunkStart;
      const nextChunk = data.slice(Math.max(0, overlap));
      if (nextChunk) {
        runtime.writeCoordinator.write(
          nextChunk,
          transition,
          completeAtOffset,
          failure,
        );
      } else {
        completeAtOffset();
      }
      lastBufferOffset = normalizedOffset;
      return;
    }
    runtime.writeCoordinator.write(
      data,
      transition,
      completeAtOffset,
      failure,
    );
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
        .find((event) => Number.isSafeInteger(event.runtimeGeneration))
        ?.runtimeGeneration;
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

    writeDataWithOffset(
      replay.data,
      replay.offset,
      replayMetadata,
      true,
      acknowledgeReplay,
      reportReplayFailure,
    );
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
        const replayEvents = pendingLiveEvents.splice(
          0,
          pendingLiveEvents.length,
        );
        const latestGeneration = [...replayEvents]
          .reverse()
          .find((event) => Number.isSafeInteger(event.runtimeGeneration))
          ?.runtimeGeneration;
        const replayGeneration = Number.isSafeInteger(latestGeneration)
          ? (latestGeneration as number)
          : currentGeneration;
        attachedRuntimeGeneration = replayGeneration;
        writeCoordinatorRuntimeGeneration = replayGeneration;
        installWriteCoordinatorFailureHandler(replayGeneration);
        replayBufferedOutput(
          initial,
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
  let outputAttachmentPromise: Promise<{
    runtimeGeneration?: number;
    data: string;
    offset: number;
    remoteOs?: TerminalRemoteOs;
    windowsRelease?: string;
  } | undefined> = Promise.resolve(undefined);
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
            terminalFlowApi.detachOutputConsumer?.(
              config.id,
              outputConsumerId,
            );
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
        attachment ||
        (await window.gyshell.terminal.getBufferDelta(config.id, 0));
      const replayEvents = pendingLiveEvents.splice(
        0,
        pendingLiveEvents.length,
      );
      const latestGeneration = [...replayEvents]
        .reverse()
        .find((event) => Number.isSafeInteger(event.runtimeGeneration))
        ?.runtimeGeneration;
      replayBufferedOutput(
        initial,
        replayEvents,
        Number.isSafeInteger(latestGeneration)
          ? latestGeneration
          : attachedRuntimeGeneration,
      );
    } catch (error) {
      const failureGeneration = Number.isSafeInteger(
        attachedRuntimeGeneration,
      )
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
    cleanup();
    outputConsumerDisposed = true;
    if (outputConsumerAttached) {
      terminalFlowApi.detachOutputConsumer?.(
        config.id,
        outputConsumerId,
      );
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
  uiOwnershipCheck?: () => boolean,
  remoteOs?: TerminalRemoteOs,
  systemInfo?: TerminalSystemInfoLike,
): TerminalRuntime => {
  let runtime = runtimePool.get(config.id);
  if (!runtime) {
    runtime = createRuntime(config, theme, settings, remoteOs, systemInfo);
    runtimePool.set(config.id, runtime);
  }
  if (uiOwnershipCheck) {
    runtime.uiOwnershipCheck = uiOwnershipCheck;
  }
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
    >(
      props.onSearchResultsChange,
    );
    const aliveRef = useRef(true);
    const isActiveRef = useRef(props.isActive !== false);
    const commandDraftFailureTimerRef = useRef<number | null>(null);
    const lastHandledDraftRequestIdRef = useRef(0);
    const lastPointerRef = useRef<{ x: number; y: number } | null>(null);
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
    }, [props.isOwnedByUi, props.config.id]);

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

    // Live-update terminal settings
    useEffect(() => {
      const runtime = runtimeRef.current;
      if (!runtime) return;
      runtime.settings = props.terminalSettings;
      const options = runtime.term.options;
      if (props.terminalSettings?.fontSize)
        options.fontSize = props.terminalSettings.fontSize;
      if (props.terminalSettings?.lineHeight)
        options.lineHeight = Math.max(1, props.terminalSettings.lineHeight);
      options.fontWeight = TERMINAL_FONT_WEIGHT;
      options.fontWeightBold = TERMINAL_FONT_WEIGHT_BOLD;
      if (props.terminalSettings?.scrollback)
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
      props.terminalSettings?.fontSize,
      props.terminalSettings?.lineHeight,
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

    return (
      <>
        <div className="xterm-shell">
          <div className="xterm-host" ref={hostRef} />
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
