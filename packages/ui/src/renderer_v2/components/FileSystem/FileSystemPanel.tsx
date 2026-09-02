import React from "react";
import { createPortal } from "react-dom";
import {
  ArrowUp,
  ArrowUpDown,
  Check,
  Copy,
  File,
  FileText,
  Folder,
  FolderPlus,
  GripVertical,
  MoreVertical,
  Pencil,
  RefreshCw,
  Scissors,
  Trash2,
  X,
} from "lucide-react";
import { observer } from "mobx-react-lite";
import type { FileSystemEntry, FileTransferTaskSnapshot } from "../../lib/ipcTypes";
import type {
  AppStore,
  FileSystemClipboardMode,
  FileSystemClipboardState,
  TerminalTabModel,
} from "../../stores/AppStore";
import {
  MEDIA_PREVIEW_MAX_BYTES,
  resolveFilePreviewSupport,
  TEXT_PREVIEW_MAX_BYTES,
} from "../../lib/filePreviewSupport";
import {
  FILESYSTEM_PANEL_DRAG_MIME,
  admitFileSystemPanelDragPayload,
  encodeFileSystemPanelDragPayload,
  extractNativeDropFilePaths,
  getNativeFilePathResolver,
  hasFileSystemPanelDragPayloadType,
  hasNativeFileDragType,
} from "../../lib/filesystemDragDrop";
import { ConfirmDialog } from "../Common/ConfirmDialog";
import { PanelFindBar } from "../Common/PanelFindBar";
import { CompactPanelTabSelect } from "../Layout/CompactPanelTabSelect";
import {
  resolveFilesystemToolbarMode,
  resolvePanelTabBarMode,
} from "../Layout/panelHeaderPresentation";
import { resolveFloatingMenuPlacement } from "../../lib/menuPlacement";
import {
  DEFAULT_FILESYSTEM_SORT_MODE,
  filterFileSystemEntriesByHidden,
  isFileSystemSortMode,
  sortFileSystemEntries,
  type FileSystemSortMode,
} from "./filesystemSort";
import {
  buildFileSystemTransferPanelModel,
  isFileTransferTerminalStatus,
  type FileTransferPanelSectionKind,
} from "./fileTransferPresentation";
import {
  cycleSearchIndex,
  findTextMatches,
  isFindShortcutEvent,
  splitTextForHighlights,
} from "../../lib/textSearch";
import { isLinux, isWindows } from "../../platform/platform";
import "./filesystem.scss";

interface FileSystemPanelProps {
  store: AppStore;
  panelId: string;
  tabs: TerminalTabModel[];
  activeTabId: string | null;
  onSelectTab: (tabId: string) => void;
  onLayoutHeaderContextMenu?: (event: React.MouseEvent<HTMLElement>) => void;
}

interface BrowserTabState {
  hasBootstrapped: boolean;
  currentPath: string;
  pathInput: string;
  entries: FileSystemEntry[];
  showHiddenFiles: boolean;
  loading: boolean;
  busy: boolean;
  errorMessage: string | null;
  selectedPaths: string[];
  selectionAnchorPath: string | null;
  statusMessage: string | null;
}

const createInitialTabState = (): BrowserTabState => ({
  hasBootstrapped: false,
  currentPath: "",
  pathInput: "",
  entries: [],
  showHiddenFiles: false,
  loading: false,
  busy: false,
  errorMessage: null,
  selectedPaths: [],
  selectionAnchorPath: null,
  statusMessage: null,
});

type FileSystemTransferConflictStrategy = "error" | "overwrite" | "rename";
type InlinePathActionType = "createDirectory" | "createFile" | "renamePath";

interface InlinePathActionState {
  type: InlinePathActionType;
  sourcePath?: string;
  value: string;
}

interface FileContextMenuState {
  anchorX: number;
  anchorY: number;
  entries: FileSystemEntry[];
}

const toErrorMessage = (error: unknown): string => {
  if (
    error instanceof Error &&
    typeof error.message === "string" &&
    error.message.trim().length > 0
  ) {
    return error.message;
  }
  if (typeof error === "string" && error.trim().length > 0) {
    return error;
  }
  return "Operation failed.";
};

const isPathMissingError = (error: unknown): boolean => {
  const maybeError = error as { code?: unknown; message?: unknown } | null;
  if (
    maybeError?.code === "ENOENT" ||
    maybeError?.code === 2 ||
    maybeError?.code === "2"
  ) {
    return true;
  }
  const message =
    typeof maybeError?.message === "string"
      ? maybeError.message
      : error instanceof Error
        ? error.message
        : String(error || "");
  return /no such file|not found|cannot find/i.test(message);
};

const formatFileSize = (size: number): string => {
  if (!Number.isFinite(size) || size <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = size;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  const digits = value >= 100 || unitIndex === 0 ? 0 : value >= 10 ? 1 : 2;
  return `${value.toFixed(digits)} ${units[unitIndex]}`;
};

const joinPath = (basePath: string, leafName: string): string => {
  const trimmedLeaf = leafName.trim();
  if (!trimmedLeaf) return basePath;
  if (!basePath || basePath === ".") return trimmedLeaf;
  if (basePath === "/") return `/${trimmedLeaf.replace(/^\/+/, "")}`;
  return `${basePath.replace(/\/+$/, "")}/${trimmedLeaf.replace(/^\/+/, "")}`;
};

const parentPath = (inputPath: string): string | null => {
  const normalized = inputPath.trim();
  if (!normalized || normalized === ".") return null;
  if (normalized === "/" || /^[A-Za-z]:[\\/]?$/.test(normalized)) return null;

  const withoutTail = normalized.replace(/[\\/]+$/, "");
  if (!withoutTail || withoutTail === "/" || /^[A-Za-z]:$/.test(withoutTail)) {
    return null;
  }

  const slashIndex = Math.max(
    withoutTail.lastIndexOf("/"),
    withoutTail.lastIndexOf("\\"),
  );
  if (slashIndex < 0) return ".";
  if (slashIndex === 0) {
    return withoutTail.startsWith("\\") ? "\\" : "/";
  }

  const parent = withoutTail.slice(0, slashIndex);
  if (/^[A-Za-z]:$/.test(parent)) return `${parent}\\`;
  return parent;
};

const basenameFromPath = (inputPath: string): string => {
  const normalized = String(inputPath || "").trim();
  if (!normalized) return "";
  const segments = normalized
    .replace(/[\\/]+$/, "")
    .split(/[\\/]/)
    .filter(Boolean);
  return segments[segments.length - 1] || normalized;
};

const normalizePathForCompare = (inputPath: string): string => {
  const withForwardSlash = inputPath.replace(/\\/g, "/");
  const trimmed = withForwardSlash.replace(/\/+$/, "");
  return trimmed.length > 0 ? trimmed : "/";
};

const normalizeFileNameForConflict = (
  name: string,
  osType: "unix" | "windows" | undefined,
): string => (osType === "windows" ? name.toLocaleLowerCase() : name);

const isSameOrDescendantPath = (
  candidatePath: string,
  rootPath: string,
): boolean => {
  const normalizedCandidate = normalizePathForCompare(candidatePath);
  const normalizedRoot = normalizePathForCompare(rootPath);
  if (normalizedCandidate === normalizedRoot) return true;
  return normalizedCandidate.startsWith(`${normalizedRoot}/`);
};

export const FileSystemPanel: React.FC<FileSystemPanelProps> = observer(
  ({
    store,
    panelId,
    tabs,
    activeTabId,
    onSelectTab,
    onLayoutHeaderContextMenu,
  }) => {
    const t = store.i18n.t;
    const [stateByTabId, setStateByTabId] = React.useState<
      Record<string, BrowserTabState>
    >({});
    const [sortMode, setSortMode] = React.useState<FileSystemSortMode>(
      DEFAULT_FILESYSTEM_SORT_MODE,
    );
    const [findOpen, setFindOpen] = React.useState(false);
    const [searchQuery, setSearchQuery] = React.useState("");
    const [searchResultIndex, setSearchResultIndex] = React.useState(-1);
    const [inlinePathAction, setInlinePathAction] =
      React.useState<InlinePathActionState | null>(null);
    const clipboard = store.fileSystemClipboard;
    const [deleteConfirmOpen, setDeleteConfirmOpen] = React.useState(false);
    const [isDeleteConfirmLoading, setDeleteConfirmLoading] =
      React.useState(false);
    const [overwriteConfirmOpen, setOverwriteConfirmOpen] =
      React.useState(false);
    const [isOverwriteConfirmLoading, setOverwriteConfirmLoading] =
      React.useState(false);
    const [isExplorerDropHot, setExplorerDropHot] = React.useState(false);
    const [isSameMachineGateway, setSameMachineGateway] = React.useState<
      boolean | null
    >(null);
    const [openToolbarMenu, setOpenToolbarMenu] = React.useState<
      "sort" | "more" | null
    >(null);
    const [toolbarMenuStyle, setToolbarMenuStyle] = React.useState<
      React.CSSProperties | undefined
    >(undefined);
    const [fileContextMenu, setFileContextMenu] =
      React.useState<FileContextMenuState | null>(null);
    const [fileContextMenuStyle, setFileContextMenuStyle] = React.useState<
      React.CSSProperties | undefined
    >(undefined);
    const pendingOverwriteRef = React.useRef<{
      clipboard: FileSystemClipboardState;
      targetTerminalId: string;
      targetPath: string;
      conflictNames: string[];
    } | null>(null);
    const [transferDisplayNow, setTransferDisplayNow] = React.useState(
      () => Date.now(),
    );
    const requestVersionRef = React.useRef<Record<string, number>>({});
    const handledTransferTerminalStatusesRef = React.useRef<
      Record<string, FileTransferTaskSnapshot["status"]>
    >({});
    const reloadDirectoryTimersRef = React.useRef<
      Record<string, ReturnType<typeof setTimeout>>
    >({});
    const inlineActionInputRef = React.useRef<HTMLInputElement | null>(null);
    const sortMenuButtonRef = React.useRef<HTMLButtonElement | null>(null);
    const moreMenuButtonRef = React.useRef<HTMLButtonElement | null>(null);
    const toolbarMenuRef = React.useRef<HTMLDivElement | null>(null);
    const fileContextMenuRef = React.useRef<HTMLDivElement | null>(null);
    const searchInputRef = React.useRef<HTMLInputElement | null>(null);
    const explorerRowRefs = React.useRef<Record<string, HTMLDivElement | null>>(
      {},
    );
    const sortModeRef = React.useRef<FileSystemSortMode>(sortMode);
    const searchQueryRef = React.useRef(searchQuery);

    React.useEffect(() => {
      sortModeRef.current = sortMode;
    }, [sortMode]);

    React.useEffect(() => {
      searchQueryRef.current = searchQuery;
    }, [searchQuery]);

    React.useEffect(() => {
      let cancelled = false;
      void window.gyshell.gateway
        .isSameMachine()
        .then((payload) => {
          if (cancelled) return;
          setSameMachineGateway(payload?.sameMachine === true);
        })
        .catch(() => {
          if (cancelled) return;
          setSameMachineGateway(false);
        });
      return () => {
        cancelled = true;
      };
    }, []);

    React.useEffect(() => {
      if (tabs.length <= 0) return;
      const activeExists =
        !!activeTabId && tabs.some((tab) => tab.id === activeTabId);
      if (!activeExists) {
        onSelectTab(tabs[0].id);
      }
    }, [activeTabId, onSelectTab, tabs]);

    const updateTabState = React.useCallback(
      (
        tabId: string,
        updater: (current: BrowserTabState) => BrowserTabState,
      ): void => {
        setStateByTabId((previous) => {
          const current = previous[tabId] || createInitialTabState();
          const next = updater(current);
          if (next === current) return previous;
          return {
            ...previous,
            [tabId]: next,
          };
        });
      },
      [],
    );

    React.useEffect(() => {
      const timer = window.setInterval(() => {
        setTransferDisplayNow(Date.now());
      }, 1000);
      return () => {
        window.clearInterval(timer);
        Object.values(reloadDirectoryTimersRef.current).forEach((timer) => {
          clearTimeout(timer);
        });
      };
    }, []);

    const loadDirectory = React.useCallback(
      async (terminalId: string, dirPath?: string): Promise<void> => {
        const requestVersion = (requestVersionRef.current[terminalId] || 0) + 1;
        requestVersionRef.current[terminalId] = requestVersion;
        updateTabState(terminalId, (current) => ({
          ...current,
          hasBootstrapped: true,
          loading: true,
          errorMessage: null,
          statusMessage: null,
        }));
        try {
          const result = await window.gyshell.filesystem.list(
            terminalId,
            dirPath,
          );
          if (requestVersionRef.current[terminalId] !== requestVersion) return;
          updateTabState(terminalId, (current) => {
            const visibleEntries = filterFileSystemEntriesByHidden(
              sortFileSystemEntries(result.entries, sortModeRef.current),
              current.showHiddenFiles,
            );
            const selectedPaths = current.selectedPaths.filter((path) =>
              visibleEntries.some((entry) => entry.path === path),
            );
            const selectionAnchorPath =
              current.selectionAnchorPath &&
              selectedPaths.includes(current.selectionAnchorPath)
                ? current.selectionAnchorPath
                : selectedPaths[0] || null;
            return {
              ...current,
              hasBootstrapped: true,
              currentPath: result.path,
              pathInput: result.path,
              entries: result.entries,
              loading: false,
              errorMessage: null,
              selectedPaths,
              selectionAnchorPath,
            };
          });
        } catch (error) {
          if (requestVersionRef.current[terminalId] !== requestVersion) return;
          updateTabState(terminalId, (current) => ({
            ...current,
            hasBootstrapped: true,
            loading: false,
            errorMessage: toErrorMessage(error),
          }));
        }
      },
      [updateTabState],
    );

    const scheduleDirectoryReload = React.useCallback(
      (terminalId: string, reloadPath: string): void => {
        const prevTimer = reloadDirectoryTimersRef.current[terminalId];
        if (prevTimer) {
          clearTimeout(prevTimer);
        }
        reloadDirectoryTimersRef.current[terminalId] = setTimeout(() => {
          delete reloadDirectoryTimersRef.current[terminalId];
          void loadDirectory(terminalId, reloadPath);
        }, 260);
      },
      [loadDirectory],
    );

    React.useEffect(() => {
      Object.values(store.fileTransferTasks).forEach((task) => {
        if (!isFileTransferTerminalStatus(task.status)) {
          return;
        }
        if (
          handledTransferTerminalStatusesRef.current[task.id] === task.status
        ) {
          return;
        }
        handledTransferTerminalStatusesRef.current[task.id] = task.status;

        if (task.status === "success") {
          const successMessage =
            task.mode === "move"
              ? t.filesystem.filesMoved(task.transferredFiles)
              : t.filesystem.filesCopied(task.transferredFiles);
          updateTabState(task.targetTerminalId, (current) => ({
            ...current,
            statusMessage: successMessage,
            errorMessage: null,
          }));
          scheduleDirectoryReload(task.targetTerminalId, task.targetDirPath);
          if (task.mode === "move") {
            scheduleDirectoryReload(
              task.sourceTerminalId,
              parentPath(task.sourcePaths[0] || "") || ".",
            );
            store.clearFileSystemClipboard();
          }
          return;
        }

        if (task.status === "cancelled") {
          updateTabState(task.targetTerminalId, (current) => ({
            ...current,
            statusMessage: t.filesystem.transferCancelled,
          }));
          return;
        }

        const message = task.errorMessage || task.message || t.filesystem.transferFailed;
        updateTabState(task.targetTerminalId, (current) => ({
          ...current,
          errorMessage: message,
          statusMessage: null,
        }));
      });
    }, [
      scheduleDirectoryReload,
      store,
      store.fileTransferTasks,
      t.filesystem,
      updateTabState,
    ]);

    const activeTabStateForBootstrap = activeTabId
      ? stateByTabId[activeTabId]
      : undefined;
    const activeTabLoading = activeTabStateForBootstrap?.loading === true;
    const activeTabBootstrapped =
      activeTabStateForBootstrap?.hasBootstrapped === true;

    React.useEffect(() => {
      if (!activeTabId) return;
      const targetTab = tabs.find((tab) => tab.id === activeTabId) || null;
      if (!targetTab) return;
      if (targetTab.runtimeState === "initializing") return;
      if (activeTabLoading) return;
      if (activeTabBootstrapped) return;
      void loadDirectory(activeTabId);
    }, [
      activeTabBootstrapped,
      activeTabId,
      activeTabLoading,
      loadDirectory,
      tabs,
    ]);

    const activeTab =
      tabs.find((tab) => tab.id === activeTabId) || tabs[0] || null;
    const activeTerminalId = activeTab?.id || null;
    const isActiveTerminalLocal = activeTab?.config?.type === "local";
    const activeState = activeTerminalId
      ? stateByTabId[activeTerminalId] || createInitialTabState()
      : createInitialTabState();
    const menuPlatformClassName = React.useMemo(() => {
      if (isWindows()) return "is-platform-windows";
      if (isLinux()) return "is-platform-linux";
      return "";
    }, []);
    const sortedEntries = React.useMemo(
      () => sortFileSystemEntries(activeState.entries, sortMode),
      [activeState.entries, sortMode],
    );
    const visibleEntries = React.useMemo(
      () =>
        filterFileSystemEntriesByHidden(
          sortedEntries,
          activeState.showHiddenFiles,
        ),
      [activeState.showHiddenFiles, sortedEntries],
    );
    const normalizedSearchQuery = React.useMemo(
      () => searchQuery.trim(),
      [searchQuery],
    );
    const filteredEntries = React.useMemo(() => {
      if (!normalizedSearchQuery) {
        return visibleEntries;
      }
      return visibleEntries.filter(
        (entry) =>
          findTextMatches(entry.name, normalizedSearchQuery).length > 0,
      );
    }, [normalizedSearchQuery, visibleEntries]);
    const selectedEntries = React.useMemo(
      () =>
        filteredEntries.filter((entry) =>
          activeState.selectedPaths.includes(entry.path),
        ),
      [activeState.selectedPaths, filteredEntries],
    );
    const singleSelectedEntry =
      selectedEntries.length === 1 ? selectedEntries[0] : null;
    const selectedCount = selectedEntries.length;
    const sortOptions = React.useMemo(
      () => [
        { value: "name-asc", label: t.filesystem.sortNameAsc },
        { value: "name-desc", label: t.filesystem.sortNameDesc },
        { value: "modified-desc", label: t.filesystem.sortModifiedNewest },
        { value: "modified-asc", label: t.filesystem.sortModifiedOldest },
        { value: "size-desc", label: t.filesystem.sortSizeLargest },
        { value: "size-asc", label: t.filesystem.sortSizeSmallest },
        { value: "type-asc", label: t.filesystem.sortTypeAsc },
        { value: "type-desc", label: t.filesystem.sortTypeDesc },
      ],
      [t.filesystem],
    );
    const activeSortOption = React.useMemo(
      () =>
        sortOptions.find((option) => option.value === sortMode) ||
        sortOptions[0],
      [sortMode, sortOptions],
    );
    const activeSearchEntry =
      normalizedSearchQuery && searchResultIndex >= 0
        ? filteredEntries[searchResultIndex] || null
        : null;

    React.useEffect(() => {
      setInlinePathAction(null);
      setDeleteConfirmOpen(false);
      setDeleteConfirmLoading(false);
      setOverwriteConfirmOpen(false);
      setOverwriteConfirmLoading(false);
      pendingOverwriteRef.current = null;
      setOpenToolbarMenu(null);
      setFileContextMenu(null);
    }, [activeTerminalId]);

    React.useEffect(() => {
      if (!normalizedSearchQuery) {
        setSearchResultIndex(-1);
        return;
      }
      setSearchResultIndex(0);
    }, [activeTerminalId, normalizedSearchQuery]);

    React.useEffect(() => {
      setSearchResultIndex((current) => {
        if (!normalizedSearchQuery || filteredEntries.length <= 0) {
          return -1;
        }
        if (current < 0 || current >= filteredEntries.length) {
          return 0;
        }
        return current;
      });
    }, [filteredEntries.length, normalizedSearchQuery]);

    React.useEffect(() => {
      if (!activeTerminalId || !activeSearchEntry) {
        return;
      }
      const nextPath = activeSearchEntry.path;
      updateTabState(activeTerminalId, (current) => {
        if (
          current.selectedPaths.length === 1 &&
          current.selectedPaths[0] === nextPath &&
          current.selectionAnchorPath === nextPath
        ) {
          return current;
        }
        return {
          ...current,
          selectedPaths: [nextPath],
          selectionAnchorPath: nextPath,
        };
      });
      explorerRowRefs.current[nextPath]?.scrollIntoView({
        block: "nearest",
      });
    }, [activeSearchEntry, activeTerminalId, updateTabState]);

    const recomputeToolbarMenuPosition = React.useCallback(() => {
      const trigger =
        openToolbarMenu === "sort"
          ? sortMenuButtonRef.current
          : openToolbarMenu === "more"
            ? moreMenuButtonRef.current
            : null;
      const menu = toolbarMenuRef.current;
      if (!trigger || !menu) return;

      const rect = trigger.getBoundingClientRect();
      const measured = menu.getBoundingClientRect();
      const placement = resolveFloatingMenuPlacement({
        anchorRect: {
          left: rect.left,
          top: rect.top,
          width: rect.width,
          height: rect.height,
        },
        menuWidth: Math.ceil(measured.width),
        menuHeight: Math.ceil(measured.height),
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
        margin: 8,
        gap: 4,
        preferredMaxHeight: 240,
      });

      setToolbarMenuStyle({
        position: "fixed",
        top: placement.top,
        left: placement.left,
        maxHeight: placement.maxHeight,
        maxWidth: placement.maxWidth,
      });
    }, [openToolbarMenu]);

    React.useEffect(() => {
      if (!openToolbarMenu) return;

      const onMouseDown = (event: MouseEvent) => {
        const target = event.target as Node | null;
        if (!target) return;
        if (toolbarMenuRef.current?.contains(target)) {
          return;
        }
        if (
          sortMenuButtonRef.current?.contains(target) ||
          moreMenuButtonRef.current?.contains(target)
        ) {
          return;
        }
        setOpenToolbarMenu(null);
      };

      const onKeyDown = (event: KeyboardEvent) => {
        if (event.key === "Escape") {
          setOpenToolbarMenu(null);
        }
      };

      const onReflow = () => {
        recomputeToolbarMenuPosition();
      };

      window.addEventListener("mousedown", onMouseDown);
      window.addEventListener("keydown", onKeyDown);
      window.addEventListener("resize", onReflow);
      window.addEventListener("scroll", onReflow, true);
      return () => {
        window.removeEventListener("mousedown", onMouseDown);
        window.removeEventListener("keydown", onKeyDown);
        window.removeEventListener("resize", onReflow);
        window.removeEventListener("scroll", onReflow, true);
      };
    }, [openToolbarMenu, recomputeToolbarMenuPosition]);

    React.useLayoutEffect(() => {
      if (!openToolbarMenu) return;
      recomputeToolbarMenuPosition();
    }, [openToolbarMenu, recomputeToolbarMenuPosition]);

    const recomputeFileContextMenuPosition = React.useCallback(() => {
      const menu = fileContextMenuRef.current;
      if (!fileContextMenu || !menu) return;

      const measured = menu.getBoundingClientRect();
      const placement = resolveFloatingMenuPlacement({
        anchorRect: {
          left: fileContextMenu.anchorX,
          top: fileContextMenu.anchorY,
          width: 0,
          height: 0,
        },
        menuWidth: Math.ceil(measured.width),
        menuHeight: Math.ceil(measured.height),
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
        margin: 8,
        gap: 4,
        preferredMaxHeight: 280,
      });

      setFileContextMenuStyle({
        position: "fixed",
        top: placement.top,
        left: placement.left,
        maxHeight: placement.maxHeight,
        maxWidth: placement.maxWidth,
      });
    }, [fileContextMenu]);

    React.useEffect(() => {
      if (!fileContextMenu) return;

      const onMouseDown = (event: MouseEvent) => {
        const target = event.target as Node | null;
        if (!target) return;
        if (fileContextMenuRef.current?.contains(target)) {
          return;
        }
        setFileContextMenu(null);
      };

      const onKeyDown = (event: KeyboardEvent) => {
        if (event.key === "Escape") {
          setFileContextMenu(null);
        }
      };

      const onReflow = () => {
        recomputeFileContextMenuPosition();
      };

      window.addEventListener("mousedown", onMouseDown);
      window.addEventListener("keydown", onKeyDown);
      window.addEventListener("resize", onReflow);
      window.addEventListener("scroll", onReflow, true);
      return () => {
        window.removeEventListener("mousedown", onMouseDown);
        window.removeEventListener("keydown", onKeyDown);
        window.removeEventListener("resize", onReflow);
        window.removeEventListener("scroll", onReflow, true);
      };
    }, [fileContextMenu, recomputeFileContextMenuPosition]);

    React.useLayoutEffect(() => {
      if (!fileContextMenu) return;
      recomputeFileContextMenuPosition();
    }, [fileContextMenu, recomputeFileContextMenuPosition]);

    const inlineActionSessionKey = React.useMemo(() => {
      if (!inlinePathAction) return null;
      return `${inlinePathAction.type}:${inlinePathAction.sourcePath || ""}`;
    }, [inlinePathAction?.sourcePath, inlinePathAction?.type]);

    React.useEffect(() => {
      if (!inlinePathAction || !inlineActionInputRef.current) return;
      inlineActionInputRef.current.focus();
      inlineActionInputRef.current.select();
    }, [inlineActionSessionKey]);

    const getTransferStatusLabel = React.useCallback(
      (status: FileTransferTaskSnapshot["status"]): string => {
        if (status === "queued") return t.filesystem.transferQueued;
        if (status === "scanning") return t.filesystem.transferScanning;
        if (status === "running") return t.filesystem.transferRunning;
        if (status === "success") return t.filesystem.transferCompleted;
        if (status === "cancelled") return t.filesystem.transferCancelled;
        return t.filesystem.transferFailed;
      },
      [t.filesystem],
    );

    const getTransferSectionLabel = React.useCallback(
      (sectionKind: FileTransferPanelSectionKind): string => {
        if (sectionKind === "background")
          return t.filesystem.transferSectionBackground;
        if (sectionKind === "recent") return t.filesystem.transferSectionRecent;
        return t.filesystem.transferSectionCurrent;
      },
      [t.filesystem],
    );

    const getTransferRouteLabel = React.useCallback(
      (task: FileTransferTaskSnapshot): string => {
        const sourceName = task.sourceTerminalName || task.sourceTerminalId;
        const targetName = task.targetTerminalName || task.targetTerminalId;
        return `${sourceName} -> ${targetName} · ${task.targetDirPath}`;
      },
      [],
    );

    const getTransferDetailLabel = React.useCallback(
      (task: FileTransferTaskSnapshot): string => {
        if (task.errorMessage) return task.errorMessage;
        if (
          task.cancelRequested &&
          !isFileTransferTerminalStatus(task.status)
        ) {
          return t.filesystem.transferCancelling;
        }
        const routeLabel = getTransferRouteLabel(task);
        if (task.status === "queued") {
          return `${t.filesystem.transferWaitingForSlot} · ${routeLabel}`;
        }
        if (task.status === "scanning") {
          return `${task.message || t.filesystem.transferScanning} · ${routeLabel}`;
        }
        if (isFileTransferTerminalStatus(task.status)) {
          return task.message || routeLabel;
        }
        return routeLabel;
      },
      [getTransferRouteLabel, t.filesystem],
    );

    const cancelTransferTask = React.useCallback(
      (taskId: string): void => {
        const current = store.fileTransferTasks[taskId];
        if (!current || isFileTransferTerminalStatus(current.status)) {
          return;
        }
        void store.cancelFileTransferTask(taskId);
      },
      [store, store.fileTransferTasks],
    );

    const runBusyOperation = React.useCallback(
      async (
        terminalId: string,
        operation: () => Promise<void>,
        options?: { successMessage?: string; reloadPath?: string },
      ): Promise<void> => {
        updateTabState(terminalId, (current) => ({
          ...current,
          busy: true,
          statusMessage: null,
          errorMessage: null,
        }));
        try {
          await operation();
          if (options?.reloadPath !== undefined) {
            await loadDirectory(terminalId, options.reloadPath);
          }
          updateTabState(terminalId, (current) => ({
            ...current,
            busy: false,
            statusMessage: options?.successMessage || null,
          }));
        } catch (error) {
          updateTabState(terminalId, (current) => ({
            ...current,
            busy: false,
            errorMessage: toErrorMessage(error),
          }));
        }
      },
      [loadDirectory, updateTabState],
    );

    const handleSelectEntry = React.useCallback(
      (event: React.MouseEvent<HTMLElement>, entry: FileSystemEntry): void => {
        if (!activeTerminalId) return;
        updateTabState(activeTerminalId, (current) => {
          const paths = filterFileSystemEntriesByHidden(
            sortFileSystemEntries(current.entries, sortModeRef.current),
            current.showHiddenFiles,
          )
            .filter((item) =>
              searchQueryRef.current.trim().length > 0
                ? findTextMatches(item.name, searchQueryRef.current.trim())
                    .length > 0
                : true,
            )
            .map((item) => item.path);
          const currentSelection = new Set(current.selectedPaths);
          let nextSelectedPaths: string[] = [];
          let nextAnchorPath = current.selectionAnchorPath;

          if (
            event.shiftKey &&
            current.selectionAnchorPath &&
            paths.includes(current.selectionAnchorPath)
          ) {
            const startIndex = paths.indexOf(current.selectionAnchorPath);
            const endIndex = paths.indexOf(entry.path);
            if (startIndex >= 0 && endIndex >= 0) {
              const [from, to] =
                startIndex <= endIndex
                  ? [startIndex, endIndex]
                  : [endIndex, startIndex];
              nextSelectedPaths = paths.slice(from, to + 1);
              nextAnchorPath = current.selectionAnchorPath;
            }
          } else if (event.metaKey || event.ctrlKey) {
            if (currentSelection.has(entry.path)) {
              currentSelection.delete(entry.path);
            } else {
              currentSelection.add(entry.path);
            }
            nextSelectedPaths = paths.filter((itemPath) =>
              currentSelection.has(itemPath),
            );
            nextAnchorPath = entry.path;
          } else {
            nextSelectedPaths = [entry.path];
            nextAnchorPath = entry.path;
          }

          if (nextSelectedPaths.length === 0) {
            nextAnchorPath = null;
          }

          return {
            ...current,
            selectedPaths: nextSelectedPaths,
            selectionAnchorPath: nextAnchorPath,
            statusMessage: null,
          };
        });
      },
      [activeTerminalId, updateTabState],
    );

    const handleEntryContextMenu = React.useCallback(
      (
        event: React.MouseEvent<HTMLElement>,
        entry: FileSystemEntry,
      ): void => {
        event.preventDefault();
        event.stopPropagation();
        if (!activeTerminalId) return;
        const clickedEntryIsSelected = activeState.selectedPaths.includes(
          entry.path,
        );
        const menuEntries =
          clickedEntryIsSelected && selectedEntries.length > 0
            ? selectedEntries
            : [entry];
        if (!clickedEntryIsSelected) {
          updateTabState(activeTerminalId, (current) => ({
            ...current,
            selectedPaths: [entry.path],
            selectionAnchorPath: entry.path,
            statusMessage: null,
          }));
        }
        setOpenToolbarMenu(null);
        setFileContextMenu({
          anchorX: event.clientX,
          anchorY: event.clientY,
          entries: menuEntries,
        });
      },
      [
        activeState.selectedPaths,
        activeTerminalId,
        selectedEntries,
        updateTabState,
      ],
    );

    const handleToolbarMenuToggle = React.useCallback(
      (menu: "sort" | "more"): void => {
        setOpenToolbarMenu((current) => (current === menu ? null : menu));
      },
      [],
    );

    const handleSortMenuToggle = React.useCallback((): void => {
      handleToolbarMenuToggle("sort");
    }, [handleToolbarMenuToggle]);

    const handleMoreMenuToggle = React.useCallback((): void => {
      handleToolbarMenuToggle("more");
    }, [handleToolbarMenuToggle]);

    const handleSortMenuSelect = React.useCallback(
      (nextValue: string): void => {
        if (!isFileSystemSortMode(nextValue)) return;
        setSortMode(nextValue);
        setOpenToolbarMenu(null);
      },
      [],
    );

    const handleToggleHiddenFiles = React.useCallback((): void => {
      if (!activeTerminalId) return;
      updateTabState(activeTerminalId, (current) => {
        const nextShowHiddenFiles = !current.showHiddenFiles;
        const nextVisibleEntries = filterFileSystemEntriesByHidden(
          sortFileSystemEntries(current.entries, sortModeRef.current),
          nextShowHiddenFiles,
        ).filter((entry) =>
          searchQueryRef.current.trim().length > 0
            ? findTextMatches(entry.name, searchQueryRef.current.trim())
                .length > 0
            : true,
        );
        const visiblePathSet = new Set(
          nextVisibleEntries.map((entry) => entry.path),
        );
        const selectedPaths = current.selectedPaths.filter((path) =>
          visiblePathSet.has(path),
        );
        const selectionAnchorPath =
          current.selectionAnchorPath &&
          visiblePathSet.has(current.selectionAnchorPath)
            ? current.selectionAnchorPath
            : selectedPaths[0] || null;
        return {
          ...current,
          showHiddenFiles: nextShowHiddenFiles,
          selectedPaths,
          selectionAnchorPath,
          statusMessage: null,
        };
      });
    }, [activeTerminalId, updateTabState]);

    const handleHiddenFilesMenuToggle = React.useCallback((): void => {
      handleToggleHiddenFiles();
      setOpenToolbarMenu(null);
    }, [handleToggleHiddenFiles]);

    const navigateDirectory = React.useCallback(
      (targetPath?: string): void => {
        if (!activeTerminalId) return;
        const path =
          typeof targetPath === "string" && targetPath.trim().length > 0
            ? targetPath.trim()
            : undefined;
        void loadDirectory(activeTerminalId, path);
      },
      [activeTerminalId, loadDirectory],
    );

    const handleOpenParent = React.useCallback(() => {
      if (!activeTerminalId || !activeState.currentPath) return;
      const nextPath = parentPath(activeState.currentPath);
      if (!nextPath) return;
      void loadDirectory(activeTerminalId, nextPath);
    }, [activeState.currentPath, activeTerminalId, loadDirectory]);

    const handleCreateDirectory = React.useCallback(() => {
      if (!activeTerminalId) return;
      setInlinePathAction({
        type: "createDirectory",
        value: "",
      });
    }, [activeTerminalId]);

    const handleCreateFile = React.useCallback(() => {
      if (!activeTerminalId) return;
      setInlinePathAction({
        type: "createFile",
        value: "",
      });
    }, [activeTerminalId]);

    const handleRename = React.useCallback(() => {
      if (!activeTerminalId || !singleSelectedEntry) return;
      setInlinePathAction({
        type: "renamePath",
        sourcePath: singleSelectedEntry.path,
        value: singleSelectedEntry.name,
      });
    }, [activeTerminalId, singleSelectedEntry]);

    const cancelInlinePathAction = React.useCallback(() => {
      setInlinePathAction(null);
    }, []);

    const applyInlinePathAction = React.useCallback(() => {
      if (!activeTerminalId || !inlinePathAction) return;
      const trimmedName = inlinePathAction.value.trim();
      if (!trimmedName) {
        updateTabState(activeTerminalId, (current) => ({
          ...current,
          errorMessage: t.filesystem.nameRequired,
        }));
        return;
      }
      if (/[\\/]/.test(trimmedName)) {
        updateTabState(activeTerminalId, (current) => ({
          ...current,
          errorMessage: t.filesystem.invalidNameCharacters,
        }));
        return;
      }

      if (inlinePathAction.type === "createDirectory") {
        const targetPath = joinPath(
          activeState.currentPath || ".",
          trimmedName,
        );
        setInlinePathAction(null);
        void runBusyOperation(
          activeTerminalId,
          async () => {
            await window.gyshell.filesystem.createDirectory(
              activeTerminalId,
              targetPath,
            );
          },
          {
            successMessage: t.filesystem.directoryCreated,
            reloadPath: activeState.currentPath,
          },
        );
        return;
      }

      if (inlinePathAction.type === "createFile") {
        const targetPath = joinPath(
          activeState.currentPath || ".",
          trimmedName,
        );
        setInlinePathAction(null);
        void runBusyOperation(
          activeTerminalId,
          async () => {
            await window.gyshell.filesystem.createFile(
              activeTerminalId,
              targetPath,
            );
          },
          {
            successMessage: t.filesystem.fileCreated,
            reloadPath: activeState.currentPath,
          },
        );
        return;
      }

      const sourcePath = inlinePathAction.sourcePath;
      if (!sourcePath) {
        setInlinePathAction(null);
        return;
      }
      const basePath = parentPath(sourcePath) || activeState.currentPath || ".";
      const targetPath = joinPath(basePath, trimmedName);
      setInlinePathAction(null);
      if (targetPath === sourcePath) {
        return;
      }
      void runBusyOperation(
        activeTerminalId,
        async () => {
          await window.gyshell.filesystem.renamePath(
            activeTerminalId,
            sourcePath,
            targetPath,
          );
        },
        {
          successMessage: t.filesystem.pathRenamed,
          reloadPath: activeState.currentPath,
        },
      );
    }, [
      activeState.currentPath,
      activeTerminalId,
      inlinePathAction,
      runBusyOperation,
      t.filesystem,
      updateTabState,
    ]);

    const deleteRootEntries = React.useMemo(() => {
      const sorted = selectedEntries
        .slice()
        .sort((left, right) => left.path.length - right.path.length);
      return sorted.filter((entry, index) => {
        for (let i = 0; i < index; i += 1) {
          const ancestor = sorted[i];
          if (!ancestor.isDirectory) continue;
          if (isSameOrDescendantPath(entry.path, ancestor.path)) {
            return false;
          }
        }
        return true;
      });
    }, [selectedEntries]);

    const handleDelete = React.useCallback(() => {
      if (!activeTerminalId || deleteRootEntries.length <= 0) return;
      setDeleteConfirmOpen(true);
    }, [activeTerminalId, deleteRootEntries.length]);

    const confirmDeleteSelected = React.useCallback(async (): Promise<void> => {
      if (!activeTerminalId || deleteRootEntries.length <= 0) return;
      setDeleteConfirmLoading(true);
      updateTabState(activeTerminalId, (current) => ({
        ...current,
        busy: true,
        statusMessage: null,
        errorMessage: null,
      }));
      try {
        for (const entry of deleteRootEntries) {
          await window.gyshell.filesystem
            .deletePath(activeTerminalId, entry.path, {
              recursive: entry.isDirectory,
            })
            .catch((error) => {
              if (isPathMissingError(error)) return;
              throw error;
            });
        }
        const reloadPath = activeState.currentPath;
        if (reloadPath) {
          await loadDirectory(activeTerminalId, reloadPath);
        } else {
          await loadDirectory(activeTerminalId);
        }
        updateTabState(activeTerminalId, (current) => ({
          ...current,
          busy: false,
          statusMessage: t.filesystem.pathDeleted,
          selectedPaths: [],
          selectionAnchorPath: null,
        }));
        setDeleteConfirmOpen(false);
      } catch (error) {
        updateTabState(activeTerminalId, (current) => ({
          ...current,
          busy: false,
          errorMessage: toErrorMessage(error),
        }));
      } finally {
        setDeleteConfirmLoading(false);
      }
    }, [
      activeState.currentPath,
      activeTerminalId,
      deleteRootEntries,
      loadDirectory,
      t.filesystem.pathDeleted,
      updateTabState,
    ]);

    const setClipboardFromEntries = React.useCallback(
      (entries: FileSystemEntry[], mode: FileSystemClipboardMode): void => {
        if (!activeTerminalId || entries.length <= 0) return;
        const nextClipboard: FileSystemClipboardState = {
          mode,
          sourceTerminalId: activeTerminalId,
          sourcePaths: entries.map((entry) => entry.path),
          itemNames: entries.map((entry) => entry.name),
          sourceBasePath: activeState.currentPath || ".",
          createdAt: Date.now(),
        };
        store.setFileSystemClipboard(nextClipboard);
        updateTabState(activeTerminalId, (current) => ({
          ...current,
          statusMessage:
            mode === "copy"
              ? t.filesystem.copiedItemsToClipboard(entries.length)
              : t.filesystem.cutItemsToClipboard(entries.length),
          errorMessage: null,
        }));
      },
      [
        activeState.currentPath,
        activeTerminalId,
        store,
        t.filesystem,
        updateTabState,
      ],
    );

    const setClipboardFromSelection = React.useCallback(
      (mode: FileSystemClipboardMode): void => {
        setClipboardFromEntries(selectedEntries, mode);
      },
      [selectedEntries, setClipboardFromEntries],
    );

    const copyFullPathsToClipboard = React.useCallback(
      (entries: FileSystemEntry[]): void => {
        if (!activeTerminalId || entries.length <= 0) return;
        const text = entries.map((entry) => entry.path).join("\n");
        const writeText = navigator.clipboard?.writeText;
        if (!writeText) {
          updateTabState(activeTerminalId, (current) => ({
            ...current,
            errorMessage: t.filesystem.copyFullPathFailed,
            statusMessage: null,
          }));
          return;
        }
        void writeText
          .call(navigator.clipboard, text)
          .then(() => {
            updateTabState(activeTerminalId, (current) => ({
              ...current,
              statusMessage:
                entries.length === 1
                  ? t.filesystem.fullPathCopied
                  : t.filesystem.fullPathsCopied(entries.length),
              errorMessage: null,
            }));
          })
          .catch((error) => {
            updateTabState(activeTerminalId, (current) => ({
              ...current,
              errorMessage: toErrorMessage(error),
              statusMessage: null,
            }));
          });
      },
      [activeTerminalId, t.filesystem, updateTabState],
    );

    const queueClipboardTransfer = React.useCallback(
      (
        clipboardPayload: FileSystemClipboardState,
        targetTerminalId: string,
        targetPath: string,
        conflictStrategy: FileSystemTransferConflictStrategy,
      ): void => {
        const mode = clipboardPayload.mode;
        const sourcePaths = Array.from(clipboardPayload.sourcePaths || []);
        const itemNames = Array.from(clipboardPayload.itemNames || []);
        const statusMessage =
          mode === "move"
            ? t.filesystem.movingItems(itemNames.length)
            : t.filesystem.copyingItems(itemNames.length);

        updateTabState(targetTerminalId, (current) => ({
          ...current,
          statusMessage,
          errorMessage: null,
        }));

        void store
          .startFileTransfer({
            origin: "user",
            mode,
            sourceTerminalId: clipboardPayload.sourceTerminalId,
            sourcePaths,
            targetTerminalId,
            targetDirPath: targetPath,
            overwrite: conflictStrategy === "overwrite",
            conflictStrategy,
          })
          .catch((error) => {
            const message = toErrorMessage(error);
            updateTabState(targetTerminalId, (current) => ({
              ...current,
              errorMessage: message,
              statusMessage: null,
            }));
          });
      },
      [store, t.filesystem, updateTabState],
    );

    const requestClipboardTransfer = React.useCallback(
      (
        clipboardPayload: FileSystemClipboardState,
        targetTerminalId: string,
        targetPath: string,
        conflictStrategy: FileSystemTransferConflictStrategy = "error",
      ): void => {
        const targetOs = activeTab?.remoteOs;
        const existingNameSet = new Set(
          activeState.entries.map((entry) =>
            normalizeFileNameForConflict(entry.name, targetOs),
          ),
        );
        const conflictNames = clipboardPayload.itemNames.filter((name) =>
          existingNameSet.has(normalizeFileNameForConflict(name, targetOs)),
        );
        if (conflictStrategy === "error" && conflictNames.length > 0) {
          pendingOverwriteRef.current = {
            clipboard: clipboardPayload,
            targetTerminalId,
            targetPath,
            conflictNames,
          };
          setOverwriteConfirmOpen(true);
          return;
        }
        queueClipboardTransfer(
          clipboardPayload,
          targetTerminalId,
          targetPath,
          conflictStrategy,
        );
      },
      [activeState.entries, activeTab?.remoteOs, queueClipboardTransfer],
    );

    const handlePasteClipboard = React.useCallback(
      (
        conflictStrategy: FileSystemTransferConflictStrategy = "error",
      ): void => {
        if (!clipboard || !activeTerminalId) return;
        const targetPath = activeState.currentPath || ".";
        requestClipboardTransfer(
          clipboard,
          activeTerminalId,
          targetPath,
          conflictStrategy,
        );
      },
      [
        activeState.currentPath,
        activeTerminalId,
        clipboard,
        requestClipboardTransfer,
      ],
    );

    const confirmConflictAndPaste =
      React.useCallback(
        async (
          conflictStrategy: Exclude<
            FileSystemTransferConflictStrategy,
            "error"
          >,
        ): Promise<void> => {
          const pending = pendingOverwriteRef.current;
          if (!pending) return;
          setOverwriteConfirmLoading(true);
          try {
            queueClipboardTransfer(
              pending.clipboard,
              pending.targetTerminalId,
              pending.targetPath,
              conflictStrategy,
            );
            setOverwriteConfirmOpen(false);
            pendingOverwriteRef.current = null;
          } finally {
            setOverwriteConfirmLoading(false);
          }
        },
        [queueClipboardTransfer],
      );

    const clearClipboard = React.useCallback((): void => {
      pendingOverwriteRef.current = null;
      setOverwriteConfirmOpen(false);
      store.clearFileSystemClipboard();
    }, [store]);

    const handleNativePathDrop = React.useCallback(
      async (sourcePaths: string[]): Promise<void> => {
        if (!activeTerminalId || sourcePaths.length <= 0) return;
        const sameMachine =
          isSameMachineGateway === true
            ? true
            : await window.gyshell.gateway
                .isSameMachine()
                .then((payload) => payload?.sameMachine === true);
        setSameMachineGateway(sameMachine);
        if (!sameMachine) {
          throw new Error(
            "Local drag-and-drop is not available when frontend and backend are on different machines.",
          );
        }
        const localTerminalId = store.getPreferredLocalTerminalId();
        if (!localTerminalId) {
          throw new Error(
            "No Local terminal is available for local filesystem drag-and-drop.",
          );
        }
        const clipboardPayload: FileSystemClipboardState = {
          mode: "copy",
          sourceTerminalId: localTerminalId,
          sourcePaths,
          itemNames: sourcePaths.map((path) => basenameFromPath(path) || path),
          sourceBasePath: parentPath(sourcePaths[0]) || ".",
          createdAt: Date.now(),
        };
        requestClipboardTransfer(
          clipboardPayload,
          activeTerminalId,
          activeState.currentPath || ".",
          "error",
        );
      },
      [
        activeState.currentPath,
        activeTerminalId,
        isSameMachineGateway,
        requestClipboardTransfer,
        store,
      ],
    );

    const handleExplorerDragEnter = React.useCallback(
      (event: React.DragEvent<HTMLDivElement>): void => {
        const isFileSystemPanelDrag = hasFileSystemPanelDragPayloadType(
          event.dataTransfer,
        );
        const isNativeFileDrag = hasNativeFileDragType(event.dataTransfer);
        if (!isFileSystemPanelDrag && !isNativeFileDrag) return;
        setExplorerDropHot(true);
      },
      [],
    );

    const handleExplorerDragLeave = React.useCallback(
      (event: React.DragEvent<HTMLDivElement>): void => {
        const currentTarget = event.currentTarget;
        const related = event.relatedTarget as Node | null;
        if (related && currentTarget.contains(related)) return;
        setExplorerDropHot(false);
      },
      [],
    );

    const handleExplorerDragOver = React.useCallback(
      (event: React.DragEvent<HTMLDivElement>): void => {
        const isFileSystemPanelDrag = hasFileSystemPanelDragPayloadType(
          event.dataTransfer,
        );
        const isNativeFileDrag = hasNativeFileDragType(event.dataTransfer);
        if (!isFileSystemPanelDrag && !isNativeFileDrag) return;
        event.preventDefault();
        if (event.dataTransfer) {
          event.dataTransfer.dropEffect = "copy";
        }
        setExplorerDropHot(true);
      },
      [],
    );

    const handleExplorerDrop = React.useCallback(
      (event: React.DragEvent<HTMLDivElement>): void => {
        const isFileSystemPanelDrag = hasFileSystemPanelDragPayloadType(
          event.dataTransfer,
        );
        const isNativeFileDrag = hasNativeFileDragType(event.dataTransfer);
        if (!isFileSystemPanelDrag && !isNativeFileDrag) {
          return;
        }
        event.preventDefault();
        setExplorerDropHot(false);

        const filesystemAdmission = admitFileSystemPanelDragPayload(
          event.dataTransfer,
        );
        if (!activeTerminalId) return;

        if (filesystemAdmission.kind !== "absent") {
          if (filesystemAdmission.kind === "rejected") return;
          const payload = filesystemAdmission.payload;
          const sourceTerminal = store.terminalTabs.find(
            (tab) => tab.id === payload.sourceTerminalId,
          );
          if (sourceTerminal?.capabilities?.supportsFilesystem !== true) return;

          const clipboardPayload: FileSystemClipboardState = {
            mode: "copy",
            sourceTerminalId: payload.sourceTerminalId,
            sourcePaths: payload.entries.map((entry) => entry.path),
            itemNames: payload.entries.map((entry) => entry.name),
            sourceBasePath: payload.sourceBasePath,
            createdAt: Date.now(),
          };
          requestClipboardTransfer(
            clipboardPayload,
            activeTerminalId,
            activeState.currentPath || ".",
            "error",
          );
          return;
        }

        const nativePaths = extractNativeDropFilePaths(
          event.dataTransfer,
          getNativeFilePathResolver(),
        );
        if (nativePaths.length > 0) {
          void handleNativePathDrop(nativePaths).catch((error) => {
            updateTabState(activeTerminalId, (current) => ({
              ...current,
              errorMessage: toErrorMessage(error),
              statusMessage: null,
            }));
          });
          return;
        }

        updateTabState(activeTerminalId, (current) => ({
          ...current,
          errorMessage:
            "Drop payload was detected but no readable file data was available.",
          statusMessage: null,
        }));
      },
      [
        activeState.currentPath,
        activeTerminalId,
        handleNativePathDrop,
        requestClipboardTransfer,
        updateTabState,
      ],
    );

    const resolveDragEntries = React.useCallback(
      (entry: FileSystemEntry): FileSystemEntry[] => {
        const selectedEntryMap = new Map(
          selectedEntries.map((item) => [item.path, item]),
        );
        const includesDraggedEntry = selectedEntryMap.has(entry.path);
        return includesDraggedEntry ? selectedEntries : [entry];
      },
      [selectedEntries],
    );

    const handleRowDragStart = React.useCallback(
      (
        event: React.DragEvent<HTMLDivElement>,
        entry: FileSystemEntry,
      ): void => {
        if (!activeTerminalId || !event.dataTransfer) return;
        const dragEntries = resolveDragEntries(entry);
        if (dragEntries.length <= 0) return;

        // Local entries map to real on-disk absolute paths, so we hand the drag
        // over to Electron's native drag-out (Finder/desktop/other apps). All
        // in-app drop targets already accept native local paths, so internal
        // drops keep working through the native file payload.
        if (isActiveTerminalLocal) {
          const nativePaths = dragEntries
            .map((item) => item.path)
            .filter(
              (path): path is string =>
                typeof path === "string" && path.length > 0,
            );
          if (nativePaths.length > 0) {
            event.preventDefault();
            window.gyshell?.system?.startFileDrag?.(nativePaths);
            return;
          }
        }

        // Remote (SSH) entries: keep the in-app payload only; their bytes are not
        // on this machine, so native drag-out is not possible here.
        const payload = {
          version: 1 as const,
          sourceTerminalId: activeTerminalId,
          sourceBasePath: activeState.currentPath || ".",
          entries: dragEntries.map((item) => ({
            name: item.name,
            path: item.path,
            isDirectory: item.isDirectory,
            ...(Number.isFinite(item.size)
              ? { size: Math.max(0, Math.floor(item.size)) }
              : {}),
          })),
        };
        event.dataTransfer.setData(
          FILESYSTEM_PANEL_DRAG_MIME,
          encodeFileSystemPanelDragPayload(payload),
        );
        event.dataTransfer.effectAllowed = "copyMove";
      },
      [
        activeState.currentPath,
        activeTerminalId,
        isActiveTerminalLocal,
        resolveDragEntries,
      ],
    );

    const handlePanelKeyDown = React.useCallback(
      (event: React.KeyboardEvent<HTMLElement>): void => {
        const target = event.target as HTMLElement | null;
        if (
          target &&
          (target.tagName === "INPUT" ||
            target.tagName === "TEXTAREA" ||
            target.isContentEditable)
        ) {
          return;
        }
        if (!clipboard) return;
        const isPasteShortcut =
          (event.metaKey || event.ctrlKey) &&
          !event.altKey &&
          !event.shiftKey &&
          event.key.toLowerCase() === "v";
        if (!isPasteShortcut) return;
        event.preventDefault();
        handlePasteClipboard();
      },
      [clipboard, handlePasteClipboard],
    );

    const focusSearchInput = React.useCallback(() => {
      requestAnimationFrame(() => {
        searchInputRef.current?.focus();
        searchInputRef.current?.select();
      });
    }, []);

    const openFind = React.useCallback(() => {
      setFindOpen(true);
      focusSearchInput();
    }, [focusSearchInput]);

    const closeFind = React.useCallback(() => {
      setFindOpen(false);
      setSearchQuery("");
      setSearchResultIndex(-1);
    }, []);

    const moveSearchResult = React.useCallback(
      (direction: "next" | "previous"): void => {
        if (!normalizedSearchQuery || filteredEntries.length <= 0) {
          return;
        }
        setSearchResultIndex((current) =>
          cycleSearchIndex(current, filteredEntries.length, direction),
        );
      },
      [filteredEntries.length, normalizedSearchQuery],
    );

    const handlePanelKeyDownCapture = React.useCallback(
      (event: React.KeyboardEvent<HTMLElement>): void => {
        if (!isFindShortcutEvent(event)) {
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        openFind();
      },
      [openFind],
    );

    const isLayoutDragSource =
      store.layout.isDragging && store.layout.draggingPanelId === panelId;
    const panelRect = store.layout.getPanelRect(panelId);
    const tabBarMode = resolvePanelTabBarMode(
      "filesystem",
      panelRect?.width || 0,
      tabs.length,
      store.panelTabDisplayMode,
    );
    const filesystemToolbarMode = resolveFilesystemToolbarMode(
      panelRect?.width || 0,
    );
    const terminalFontSize = React.useMemo(() => {
      const raw = store.settings?.terminal?.fontSize;
      if (!Number.isFinite(raw)) return 14;
      return Math.max(10, Math.min(28, Math.floor(raw as number)));
    }, [store.settings?.terminal?.fontSize]);
    const filesystemPanelStyle = React.useMemo(
      () =>
        ({
          "--filesystem-font-size": `${terminalFontSize}px`,
        }) as React.CSSProperties,
      [terminalFontSize],
    );
    const transferPanelModel = React.useMemo(
      () =>
        buildFileSystemTransferPanelModel(
          Object.values(store.fileTransferTasks),
          activeTerminalId,
          transferDisplayNow,
        ),
      [activeTerminalId, store.fileTransferTasks, transferDisplayNow],
    );
    const transferHeaderSummary = React.useMemo(() => {
      const { counts } = transferPanelModel;
      const parts: string[] = [];
      if (counts.running > 0) {
        parts.push(t.filesystem.transferSummaryRunning(counts.running));
      }
      if (counts.scanning > 0) {
        parts.push(t.filesystem.transferSummaryScanning(counts.scanning));
      }
      if (counts.queued > 0) {
        parts.push(t.filesystem.transferSummaryQueued(counts.queued));
      }
      if (counts.background > 0) {
        parts.push(t.filesystem.transferSummaryBackground(counts.background));
      }
      if (
        counts.recent > 0 &&
        counts.running + counts.scanning + counts.queued === 0
      ) {
        parts.push(t.filesystem.transferSummaryRecent(counts.recent));
      }
      return parts.join(" · ");
    }, [t.filesystem, transferPanelModel]);
    const inlineActionLabel = React.useMemo(() => {
      if (!inlinePathAction) return "";
      if (inlinePathAction.type === "createDirectory")
        return t.filesystem.createDirectory;
      if (inlinePathAction.type === "createFile")
        return t.filesystem.createFile;
      return t.filesystem.renamePath;
    }, [
      inlinePathAction,
      t.filesystem.createDirectory,
      t.filesystem.createFile,
      t.filesystem.renamePath,
    ]);
    const inlineActionPlaceholder = React.useMemo(() => {
      if (!inlinePathAction) return "";
      if (inlinePathAction.type === "createDirectory")
        return t.filesystem.promptDirectoryName;
      if (inlinePathAction.type === "createFile")
        return t.filesystem.promptFileName;
      return t.filesystem.promptRename;
    }, [
      inlinePathAction,
      t.filesystem.promptDirectoryName,
      t.filesystem.promptFileName,
      t.filesystem.promptRename,
    ]);

    const clipboardHint = React.useMemo(() => {
      if (!clipboard) return null;
      return clipboard.mode === "move"
        ? t.filesystem.clipboardReadyToPasteMove(clipboard.itemNames.length)
        : t.filesystem.clipboardReadyToPasteCopy(clipboard.itemNames.length);
    }, [clipboard, t.filesystem]);
    const deleteConfirmMessage = React.useMemo(() => {
      if (deleteRootEntries.length <= 0) return "";
      if (deleteRootEntries.length === 1) {
        return t.filesystem.confirmDelete(deleteRootEntries[0].name);
      }
      return t.filesystem.confirmDeleteMany(deleteRootEntries.length);
    }, [deleteRootEntries, t.filesystem]);
    const overwriteConflictPreview = React.useMemo(() => {
      const pending = pendingOverwriteRef.current;
      if (!pending || pending.conflictNames.length <= 0) return "";
      const previewNames = pending.conflictNames.slice(0, 4).join(", ");
      if (pending.conflictNames.length <= 4) return previewNames;
      return `${previewNames} ...`;
    }, [overwriteConfirmOpen]);

    if (tabs.length === 0) {
      return (
        <div
          className={`panel panel-filesystem${isLayoutDragSource ? " is-dragging-source" : ""}`}
          style={filesystemPanelStyle}
        >
          <div
            className="filesystem-tabs-container is-draggable"
            draggable
            data-layout-panel-draggable="true"
            data-layout-panel-id={panelId}
            data-layout-panel-kind="filesystem"
            onContextMenu={onLayoutHeaderContextMenu}
          >
            <div className="panel-tab-drag-handle" aria-hidden="true">
              <GripVertical size={12} strokeWidth={2.4} />
            </div>
            <div className="filesystem-tabs-bar" />
          </div>
          <div className="panel-body filesystem-panel-body">
            <div className="filesystem-empty-state">
              {t.filesystem.noTerminalTabs}
            </div>
          </div>
        </div>
      );
    }

    const isBusy = activeState.loading || activeState.busy;

    return (
      <div
        className={`panel panel-filesystem${isLayoutDragSource ? " is-dragging-source" : ""}`}
        style={filesystemPanelStyle}
        tabIndex={0}
        onKeyDownCapture={handlePanelKeyDownCapture}
        onKeyDown={handlePanelKeyDown}
      >
        <ConfirmDialog
          open={deleteConfirmOpen}
          title={t.common.confirmDeleteTitle}
          message={deleteConfirmMessage}
          confirmText={t.common.delete}
          cancelText={t.common.cancel}
          danger
          loading={isDeleteConfirmLoading}
          onCancel={() => {
            if (isDeleteConfirmLoading) return;
            setDeleteConfirmOpen(false);
          }}
          onConfirm={() => {
            void confirmDeleteSelected();
          }}
        />
        <ConfirmDialog
          open={overwriteConfirmOpen}
          title={t.filesystem.pasteConflictTitle}
          message={t.filesystem.pasteConflictMessage(
            pendingOverwriteRef.current?.conflictNames.length || 0,
            overwriteConflictPreview,
          )}
          confirmText={t.filesystem.overwriteAndPaste}
          cancelText={t.common.cancel}
          secondaryText={t.filesystem.keepBothAndPaste}
          danger
          loading={isOverwriteConfirmLoading}
          onCancel={() => {
            if (isOverwriteConfirmLoading) return;
            setOverwriteConfirmOpen(false);
            pendingOverwriteRef.current = null;
          }}
          onSecondary={() => {
            void confirmConflictAndPaste("rename");
          }}
          onConfirm={() => {
            void confirmConflictAndPaste("overwrite");
          }}
        />
        <div
          className="filesystem-tabs-container is-draggable"
          draggable
          data-layout-panel-draggable="true"
          data-layout-panel-id={panelId}
          data-layout-panel-kind="filesystem"
          onContextMenu={onLayoutHeaderContextMenu}
        >
          <div className="panel-tab-drag-handle" aria-hidden="true">
            <GripVertical size={12} strokeWidth={2.4} />
          </div>
          {tabBarMode === "select" ? (
            <CompactPanelTabSelect
              className="filesystem-tabs-select"
              panelId={panelId}
              panelKind="filesystem"
              value={activeTerminalId}
              options={tabs.map((tab) => ({
                value: tab.id,
                label: tab.title,
                leading: (
                  <span className="filesystem-tab-icon">
                    <Folder size={14} strokeWidth={2} />
                  </span>
                ),
                trailing: (
                  <span
                    className={`tab-runtime-state tab-runtime-state-${(tab.runtimeState || "initializing") === "ready" ? "ready" : "inactive"}`}
                    title={tab.runtimeState || "initializing"}
                  />
                ),
              }))}
              onChange={onSelectTab}
              leading={
                <span className="filesystem-tab-icon">
                  <Folder size={14} strokeWidth={2} />
                </span>
              }
              trailing={
                activeTab ? (
                  <span
                    className={`tab-runtime-state tab-runtime-state-${(activeTab.runtimeState || "initializing") === "ready" ? "ready" : "inactive"}`}
                    title={activeTab.runtimeState || "initializing"}
                  />
                ) : null
              }
            />
          ) : (
            <div
              className="filesystem-tabs-bar"
              data-layout-tab-bar="true"
              data-layout-tab-panel-id={panelId}
              data-layout-tab-kind="filesystem"
            >
              {tabs.map((tab, index) => {
                const isActive = tab.id === activeTerminalId;
                const runtimeState = tab.runtimeState || "initializing";
                const runtimeIndicatorState =
                  runtimeState === "ready" ? "ready" : "inactive";
                return (
                  <div
                    key={tab.id}
                    className={
                      isActive ? "filesystem-tab is-active" : "filesystem-tab"
                    }
                    onClick={() => onSelectTab(tab.id)}
                    role="button"
                    tabIndex={0}
                    draggable
                    data-layout-tab-draggable="true"
                    data-layout-tab-id={tab.id}
                    data-layout-tab-kind="filesystem"
                    data-layout-tab-panel-id={panelId}
                    data-layout-tab-index={index}
                  >
                    <span className="filesystem-tab-icon">
                      <Folder size={14} strokeWidth={2} />
                    </span>
                    <span className="filesystem-tab-title">{tab.title}</span>
                    <span
                      className={`tab-runtime-state tab-runtime-state-${runtimeIndicatorState}`}
                      title={runtimeState}
                    />
                  </div>
                );
              })}
            </div>
          )}
          <div className="filesystem-tabs-actions">
            <button
              ref={moreMenuButtonRef}
              className="filesystem-tab-more-btn"
              title={t.common.showMore}
              aria-label={t.common.showMore}
              aria-haspopup="menu"
              aria-expanded={openToolbarMenu === "more"}
              onClick={handleMoreMenuToggle}
              disabled={isBusy}
            >
              <MoreVertical size={14} strokeWidth={2} />
            </button>
          </div>
        </div>

        <div
          className={`filesystem-toolbar ${filesystemToolbarMode === "stacked" ? "is-stacked" : ""}`}
        >
          <div className="filesystem-toolbar-main">
            <button
              className="icon-btn-sm"
              title={t.filesystem.openParent}
              onClick={handleOpenParent}
              disabled={
                isBusy ||
                !activeState.currentPath ||
                activeState.currentPath === "/"
              }
            >
              <ArrowUp size={14} strokeWidth={2} />
            </button>
            <button
              className="icon-btn-sm"
              title={t.common.refresh}
              onClick={() => navigateDirectory(activeState.currentPath)}
              disabled={isBusy}
            >
              <RefreshCw size={14} strokeWidth={2} />
            </button>
            <input
              className="filesystem-path-input"
              value={activeState.pathInput}
              onChange={(event) => {
                if (!activeTerminalId) return;
                const value = event.target.value;
                updateTabState(activeTerminalId, (current) => ({
                  ...current,
                  pathInput: value,
                }));
              }}
              onKeyDown={(event) => {
                if (event.key !== "Enter") return;
                navigateDirectory(activeState.pathInput);
              }}
              placeholder={t.filesystem.pathPlaceholder}
              disabled={isBusy}
            />
          </div>
          <div className="filesystem-toolbar-actions">
            <button
              className="icon-btn-sm"
              title={t.filesystem.createDirectory}
              onClick={handleCreateDirectory}
              disabled={isBusy}
            >
              <FolderPlus size={14} strokeWidth={2} />
            </button>
            <button
              className="icon-btn-sm"
              title={t.filesystem.createFile}
              onClick={handleCreateFile}
              disabled={isBusy}
            >
              <FileText size={14} strokeWidth={2} />
            </button>
            <button
              className="icon-btn-sm"
              title={t.filesystem.renamePath}
              onClick={handleRename}
              disabled={isBusy || !singleSelectedEntry}
            >
              <Pencil size={14} strokeWidth={2} />
            </button>
            <button
              className="icon-btn-sm danger"
              title={t.common.delete}
              onClick={handleDelete}
              disabled={isBusy || selectedCount <= 0}
            >
              <Trash2 size={14} strokeWidth={2} />
            </button>
            {clipboard ? (
              <>
                <button
                  className="icon-btn-sm primary"
                  title={t.filesystem.pastePath}
                  onClick={() => handlePasteClipboard()}
                  disabled={isBusy}
                >
                  <Check size={14} strokeWidth={2.2} />
                </button>
                <button
                  className="icon-btn-sm"
                  title={t.filesystem.cancelClipboard}
                  onClick={clearClipboard}
                  disabled={isBusy}
                >
                  <X size={14} strokeWidth={2.2} />
                </button>
              </>
            ) : (
              <>
                <button
                  className="icon-btn-sm"
                  title={t.filesystem.copyPath}
                  onClick={() => setClipboardFromSelection("copy")}
                  disabled={isBusy || selectedCount <= 0}
                >
                  <Copy size={14} strokeWidth={2} />
                </button>
                <button
                  className="icon-btn-sm"
                  title={t.filesystem.cutPath}
                  onClick={() => setClipboardFromSelection("move")}
                  disabled={isBusy || selectedCount <= 0}
                >
                  <Scissors size={14} strokeWidth={2} />
                </button>
              </>
            )}
            <button
              ref={sortMenuButtonRef}
              type="button"
              className="icon-btn-sm filesystem-toolbar-view-btn"
              title={activeSortOption?.label || t.filesystem.sortNameAsc}
              aria-label={activeSortOption?.label || t.filesystem.sortNameAsc}
              aria-haspopup="menu"
              aria-expanded={openToolbarMenu === "sort"}
              onClick={handleSortMenuToggle}
              disabled={isBusy || activeState.entries.length <= 1}
            >
              <ArrowUpDown size={14} strokeWidth={2} />
            </button>
          </div>
        </div>
        {findOpen ? (
          <PanelFindBar
            inputRef={searchInputRef}
            value={searchQuery}
            placeholder={t.filesystem.searchPlaceholder}
            resultLabel={
              normalizedSearchQuery
                ? filteredEntries.length > 0
                  ? t.common.findResults(
                      Math.max(0, searchResultIndex + 1),
                      filteredEntries.length,
                    )
                  : t.common.findNoResults
                : ""
            }
            onChange={setSearchQuery}
            onPrevious={() => moveSearchResult("previous")}
            onNext={() => moveSearchResult("next")}
            onClose={closeFind}
            disableNavigation={filteredEntries.length <= 0}
          />
        ) : null}
        {openToolbarMenu
          ? createPortal(
              <div
                className={
                  menuPlatformClassName
                    ? `win-select-menu filesystem-toolbar-menu ${menuPlatformClassName}`
                    : "win-select-menu filesystem-toolbar-menu"
                }
                role="menu"
                ref={toolbarMenuRef}
                style={toolbarMenuStyle}
              >
                {openToolbarMenu === "sort" ? (
                  sortOptions.map((option) => {
                    const isSelected = option.value === sortMode;
                    return (
                      <button
                        key={option.value}
                        className={
                          isSelected
                            ? "win-select-option filesystem-toolbar-menu-item is-selected"
                            : "win-select-option filesystem-toolbar-menu-item"
                        }
                        type="button"
                        role="menuitemradio"
                        aria-checked={isSelected}
                        onClick={() => handleSortMenuSelect(option.value)}
                      >
                        <span
                          className={
                            isSelected
                              ? "filesystem-toolbar-menu-marker is-selected"
                              : "filesystem-toolbar-menu-marker"
                          }
                          aria-hidden="true"
                        >
                          <span className="filesystem-toolbar-menu-dot" />
                        </span>
                        <span className="filesystem-toolbar-menu-label">
                          {option.label}
                        </span>
                      </button>
                    );
                  })
                ) : (
                  <button
                    className={
                      activeState.showHiddenFiles
                        ? "win-select-option filesystem-toolbar-menu-item is-selected"
                        : "win-select-option filesystem-toolbar-menu-item"
                    }
                    type="button"
                    role="menuitemcheckbox"
                    aria-checked={activeState.showHiddenFiles}
                    onClick={handleHiddenFilesMenuToggle}
                  >
                    <span
                      className={
                        activeState.showHiddenFiles
                          ? "filesystem-toolbar-menu-marker is-selected"
                          : "filesystem-toolbar-menu-marker"
                      }
                      aria-hidden="true"
                    >
                      <span className="filesystem-toolbar-menu-dot" />
                    </span>
                    <span className="filesystem-toolbar-menu-label">
                      {t.filesystem.showHiddenFiles}
                    </span>
                  </button>
                )}
              </div>,
              document.body,
            )
          : null}
        {fileContextMenu
          ? createPortal(
              <div
                className={
                  menuPlatformClassName
                    ? `win-select-menu filesystem-context-menu ${menuPlatformClassName}`
                    : "win-select-menu filesystem-context-menu"
                }
                role="menu"
                ref={fileContextMenuRef}
                style={fileContextMenuStyle}
              >
                <button
                  className="win-select-option filesystem-context-menu-item"
                  type="button"
                  role="menuitem"
                  disabled={isBusy || fileContextMenu.entries.length <= 0}
                  onClick={() => {
                    const entries = fileContextMenu.entries;
                    setFileContextMenu(null);
                    setClipboardFromEntries(entries, "copy");
                  }}
                >
                  {t.filesystem.copyPath}
                </button>
                <button
                  className="win-select-option filesystem-context-menu-item"
                  type="button"
                  role="menuitem"
                  disabled={isBusy || fileContextMenu.entries.length <= 0}
                  onClick={() => {
                    const entries = fileContextMenu.entries;
                    setFileContextMenu(null);
                    setClipboardFromEntries(entries, "move");
                  }}
                >
                  {t.filesystem.cutPath}
                </button>
                <button
                  className="win-select-option filesystem-context-menu-item"
                  type="button"
                  role="menuitem"
                  disabled={isBusy || fileContextMenu.entries.length !== 1}
                  onClick={() => {
                    setFileContextMenu(null);
                    handleRename();
                  }}
                >
                  {t.filesystem.renamePath}
                </button>
                <button
                  className="win-select-option filesystem-context-menu-item"
                  type="button"
                  role="menuitem"
                  disabled={isBusy || fileContextMenu.entries.length <= 0}
                  onClick={() => {
                    const entries = fileContextMenu.entries;
                    setFileContextMenu(null);
                    copyFullPathsToClipboard(entries);
                  }}
                >
                  {fileContextMenu.entries.length > 1
                    ? t.filesystem.copyFullPaths
                    : t.filesystem.copyFullPath}
                </button>
                <div className="filesystem-context-menu-separator" />
                <button
                  className="win-select-option filesystem-context-menu-item is-danger"
                  type="button"
                  role="menuitem"
                  disabled={isBusy || fileContextMenu.entries.length <= 0}
                  onClick={() => {
                    setFileContextMenu(null);
                    handleDelete();
                  }}
                >
                  {t.common.delete}
                </button>
              </div>,
              document.body,
            )
          : null}

        {inlinePathAction ? (
          <div className="filesystem-inline-action-bar">
            <span className="filesystem-inline-action-label">
              {inlineActionLabel}
            </span>
            <input
              ref={inlineActionInputRef}
              className="filesystem-inline-action-input"
              value={inlinePathAction.value}
              onChange={(event) => {
                const value = event.target.value;
                setInlinePathAction((current) =>
                  current ? { ...current, value } : current,
                );
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  applyInlinePathAction();
                  return;
                }
                if (event.key === "Escape") {
                  event.preventDefault();
                  cancelInlinePathAction();
                }
              }}
              placeholder={inlineActionPlaceholder}
            />
            <button
              className="icon-btn-sm primary"
              type="button"
              title={t.common.create}
              onClick={applyInlinePathAction}
            >
              <Check size={14} strokeWidth={2.4} />
            </button>
            <button
              className="icon-btn-sm"
              type="button"
              title={t.common.cancel}
              onClick={cancelInlinePathAction}
            >
              <X size={14} strokeWidth={2.4} />
            </button>
          </div>
        ) : null}

        <div className="filesystem-status-bar">
          {activeState.errorMessage ? (
            <span className="filesystem-status-error">
              {activeState.errorMessage}
            </span>
          ) : activeState.statusMessage ? (
            <span className="filesystem-status-message">
              {activeState.statusMessage}
            </span>
          ) : activeState.loading ? (
            <span className="filesystem-status-message">
              {t.filesystem.loadingDirectory}
            </span>
          ) : clipboardHint ? (
            <span className="filesystem-status-message">{clipboardHint}</span>
          ) : (
            <span className="filesystem-status-placeholder" />
          )}
        </div>

        <div className="panel-body filesystem-panel-body">
          <div className="filesystem-explorer">
            <div
              className={
                isExplorerDropHot
                  ? "filesystem-list is-drop-hot"
                  : "filesystem-list"
              }
              onDragEnter={handleExplorerDragEnter}
              onDragLeave={handleExplorerDragLeave}
              onDragOver={handleExplorerDragOver}
              onDrop={handleExplorerDrop}
            >
              {filteredEntries.length === 0 && !activeState.loading ? (
                <div className="filesystem-empty-state">
                  {normalizedSearchQuery
                    ? t.filesystem.searchNoResults
                    : t.filesystem.emptyDirectory}
                </div>
              ) : (
                filteredEntries.map((entry) => {
                  const isSelected = activeState.selectedPaths.includes(
                    entry.path,
                  );
                  const Icon = entry.isDirectory ? Folder : File;
                  const nameSegments = normalizedSearchQuery
                    ? splitTextForHighlights(
                        entry.name,
                        findTextMatches(entry.name, normalizedSearchQuery),
                      )
                    : [{ text: entry.name, match: false }];
                  return (
                    <div
                      key={entry.path}
                      className={
                        isSelected
                          ? "filesystem-row is-selected"
                          : "filesystem-row"
                      }
                      ref={(node) => {
                        explorerRowRefs.current[entry.path] = node;
                      }}
                      onClick={(event) => {
                        handleSelectEntry(event, entry);
                        if (!normalizedSearchQuery) {
                          return;
                        }
                        const matchIndex = filteredEntries.findIndex(
                          (candidate) => candidate.path === entry.path,
                        );
                        if (matchIndex >= 0) {
                          setSearchResultIndex(matchIndex);
                        }
                      }}
                      draggable
                      onDragStart={(event) => handleRowDragStart(event, entry)}
                      onContextMenu={(event) =>
                        handleEntryContextMenu(event, entry)
                      }
                      onDoubleClick={() => {
                        if (entry.isDirectory) {
                          navigateDirectory(entry.path);
                          return;
                        }
                        if (!activeTerminalId) return;
                        const previewSupport = resolveFilePreviewSupport(entry);
                        if (!previewSupport.supported) {
                          const maxBytes =
                            previewSupport.kind === "image" ||
                            previewSupport.kind === "pdf"
                              ? MEDIA_PREVIEW_MAX_BYTES
                              : TEXT_PREVIEW_MAX_BYTES;
                          updateTabState(activeTerminalId, (current) => ({
                            ...current,
                            statusMessage:
                              previewSupport.reason === "fileTooLarge"
                                ? t.filesystem.previewTooLarge(
                                    entry.name,
                                    Math.floor(maxBytes / (1024 * 1024)),
                                  )
                                : t.filesystem.previewUnsupportedType(
                                    entry.name,
                                  ),
                            errorMessage: null,
                          }));
                          return;
                        }
                        void (async () => {
                          updateTabState(activeTerminalId, (current) => ({
                            ...current,
                            statusMessage: null,
                            errorMessage: null,
                          }));
                          try {
                            await store.openFileEditorFromFileSystem(
                              activeTerminalId,
                              entry.path,
                            );
                          } catch (error) {
                            updateTabState(activeTerminalId, (current) => ({
                              ...current,
                              errorMessage: toErrorMessage(error),
                              statusMessage: null,
                            }));
                          }
                        })();
                      }}
                      title={entry.path}
                    >
                      <span className="filesystem-row-main">
                        <span className="filesystem-row-icon" aria-hidden="true">
                          <Icon size={14} strokeWidth={2} />
                        </span>
                        <span className="filesystem-row-name">
                          {nameSegments.map((segment, index) =>
                            segment.match ? (
                              <mark
                                key={`${entry.path}:match:${index}`}
                                className="filesystem-row-highlight"
                              >
                                {segment.text}
                              </mark>
                            ) : (
                              <React.Fragment
                                key={`${entry.path}:text:${index}`}
                              >
                                {segment.text}
                              </React.Fragment>
                            ),
                          )}
                        </span>
                      </span>
                      <span className="filesystem-row-meta">
                        {entry.isDirectory
                          ? t.filesystem.directoryLabel
                          : formatFileSize(entry.size)}
                      </span>
                    </div>
                  );
                })
              )}
            </div>
          </div>
          {transferPanelModel.counts.total > 0 ? (
            <div className="filesystem-transfer-panel">
              <div className="filesystem-transfer-panel-header">
                <span className="filesystem-transfer-panel-title">
                  {t.filesystem.transferPanelTitle}
                </span>
                {transferHeaderSummary ? (
                  <span className="filesystem-transfer-panel-summary">
                    {transferHeaderSummary}
                  </span>
                ) : null}
              </div>
              <div className="filesystem-transfer-list">
                {transferPanelModel.sections.map((section) => (
                  <React.Fragment key={section.kind}>
                    {transferPanelModel.sections.length > 1 ? (
                      <div className="filesystem-transfer-section-header">
                        <span>{getTransferSectionLabel(section.kind)}</span>
                        <span className="filesystem-transfer-section-count">
                          {section.tasks.length}
                        </span>
                      </div>
                    ) : null}
                    {section.tasks.map((task) => {
                      const percent = Math.max(0, Math.min(100, task.percent));
                      const taskKindLabel =
                        task.mode === "move"
                          ? t.filesystem.transferMoveKind
                          : t.filesystem.transferCopyKind;
                      const progressLabel =
                        task.totalBytes > 0
                          ? `${formatFileSize(task.bytesDone)} / ${formatFileSize(task.totalBytes)}`
                          : `${task.transferredFiles}/${task.totalFiles || task.itemNames.length}`;
                      const taskName =
                        task.itemNames.length === 1
                          ? task.itemNames[0]
                          : `${task.itemNames[0]} +${task.itemNames.length - 1}`;
                      const canCancel =
                        (task.status === "queued" ||
                          task.status === "scanning" ||
                          task.status === "running") &&
                        !task.cancelRequested;
                      const originLabel =
                        task.origin === "agent"
                          ? t.filesystem.transferAgentOrigin
                          : t.filesystem.transferUserOrigin;
                      const statusLabel =
                        task.cancelRequested &&
                        !isFileTransferTerminalStatus(task.status)
                          ? t.filesystem.transferCancelling
                          : getTransferStatusLabel(task.status);
                      const detailLabel = getTransferDetailLabel(task);
                      const routeLabel = getTransferRouteLabel(task);

                      return (
                        <div
                          key={task.id}
                          className={`filesystem-transfer-item is-${task.status} is-origin-${task.origin}`}
                          title={routeLabel}
                        >
                          <div className="filesystem-transfer-main">
                            <span className="filesystem-transfer-kind">
                              {taskKindLabel}
                            </span>
                            <span className="filesystem-transfer-origin">
                              {originLabel}
                            </span>
                            <span
                              className="filesystem-transfer-name"
                              title={task.itemNames.join(", ")}
                            >
                              {taskName}
                            </span>
                            <span className="filesystem-transfer-status">
                              {statusLabel}
                            </span>
                            {canCancel ? (
                              <button
                                className="filesystem-transfer-cancel-btn"
                                title={t.filesystem.cancelTransfer}
                                onClick={() => cancelTransferTask(task.id)}
                              >
                                <X size={18} />
                              </button>
                            ) : (
                              <span
                                className="filesystem-transfer-cancel-spacer"
                                aria-hidden="true"
                              />
                            )}
                          </div>
                          <div className="filesystem-transfer-progress">
                            <span className="filesystem-transfer-progress-track">
                              <span
                                className="filesystem-transfer-progress-fill"
                                style={{ width: `${percent}%` }}
                              />
                            </span>
                            <span className="filesystem-transfer-progress-label">
                              {progressLabel}
                            </span>
                          </div>
                          <div
                            className="filesystem-transfer-message"
                            title={detailLabel}
                          >
                            {detailLabel}
                          </div>
                        </div>
                      );
                    })}
                  </React.Fragment>
                ))}
              </div>
            </div>
          ) : null}
          <div className="filesystem-footnote">
            {clipboard
              ? t.filesystem.pasteShortcutHint
              : t.filesystem.doubleClickToOpenEditor}
          </div>
        </div>
      </div>
    );
  },
);
