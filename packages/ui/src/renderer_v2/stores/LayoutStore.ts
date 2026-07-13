import {
  makeObservable,
  observable,
  action,
  computed,
  toJS,
  runInAction,
} from "mobx";
import type { AppStore } from "./AppStore";
import { PANEL_KIND_LIST, getPanelKindAdapter } from "./panelKindAdapters";
import {
  MAX_LAYOUT_PANELS,
  MAX_SAVED_LAYOUT_SLOTS,
  addSavedLayoutSlot,
  buildLayoutTree,
  deleteSavedLayoutSlot,
  deriveLegacyLayoutSnapshot,
  findSavedLayoutSlot,
  getFirstPanelId,
  getPanelCount,
  listPanels,
  makeLayoutId,
  normalizeSavedLayoutState,
  movePanel,
  overwriteSavedLayoutSlot,
  removePanel,
  setSplitSizes,
  splitPanel,
  splitPanelWithPanelId,
  swapPanels,
  type DropDirection,
  type LayoutNode,
  type LayoutPanelTabBinding,
  type LayoutRect,
  type LayoutSplitNode,
  type LayoutTree,
  type LayoutViewport,
  type PanelKind,
  type SavedLayoutSlot,
  type SplitDirection,
  type TabDragPayload,
} from "../layout";
import {
  clampSplitSizesToChildMinSizePercentages,
  computeChildMinSizePercentages,
  computeLayoutGeometry,
  validateLayoutTree,
} from "../layout";

const DEFAULT_VIEWPORT: LayoutViewport = {
  width: 0,
  height: 0,
};

const PREVIEW_PANEL_ID = "__layout-preview-panel__";

const toSplitPlacement = (
  direction: DropDirection,
): { direction: SplitDirection; position: "before" | "after" } | null => {
  if (direction === "left")
    return { direction: "horizontal", position: "before" };
  if (direction === "right")
    return { direction: "horizontal", position: "after" };
  if (direction === "top") return { direction: "vertical", position: "before" };
  if (direction === "bottom")
    return { direction: "vertical", position: "after" };
  return null;
};

const unique = (items: string[]): string[] => {
  const seen = new Set<string>();
  const next: string[] = [];
  items.forEach((item) => {
    if (!item || seen.has(item)) return;
    seen.add(item);
    next.push(item);
  });
  return next;
};

const findSplitNodeById = (
  node: LayoutNode,
  splitNodeId: string,
): LayoutSplitNode | null => {
  if (node.type !== "split") return null;
  if (node.id === splitNodeId) return node;
  for (const child of node.children) {
    const match = findSplitNodeById(child, splitNodeId);
    if (match) return match;
  }
  return null;
};

const getViewportRect = (viewport: LayoutViewport): LayoutRect => ({
  left: 0,
  top: 0,
  width: viewport.width,
  height: viewport.height,
});

type DragType = "panel" | "tab" | null;
type SyncPanelBindingOptions = {
  persist?: boolean;
  preservePanelActiveTabs?: boolean;
};
type TabReorderTarget = {
  panelId: string;
  anchorTabId: string | null;
  position: "before" | "after";
} | null;

export class LayoutStore {
  tree: LayoutTree = buildLayoutTree(undefined);
  isReady = false;
  savedLayoutSlots: SavedLayoutSlot[] = [];
  activeSavedLayoutId: string | null = null;

  viewport: LayoutViewport = { ...DEFAULT_VIEWPORT };

  // Drag state
  isDragging = false;
  dragType: DragType = null;
  draggingPanelId: string | null = null;
  draggingExternalPanelKind: PanelKind | null = null;
  draggingTab: TabDragPayload | null = null;
  dragX = 0;
  dragY = 0;
  dropTargetPanelId: string | null = null;
  dropDirection: DropDirection | null = null;
  dropPreviewRect: LayoutRect | null = null;
  tabReorderTarget: TabReorderTarget = null;

  private appStore: AppStore;
  private persistTimer: ReturnType<typeof setTimeout> | null = null;
  private pinnedEmptyPanelIds = new Set<string>();
  private layoutSaveRequestId = 0;

  constructor(appStore: AppStore) {
    this.appStore = appStore;
    makeObservable(this, {
      tree: observable,
      isReady: observable,
      savedLayoutSlots: observable,
      activeSavedLayoutId: observable,
      viewport: observable,
      isDragging: observable,
      dragType: observable,
      draggingPanelId: observable,
      draggingExternalPanelKind: observable,
      draggingTab: observable,
      dragX: observable,
      dragY: observable,
      dropTargetPanelId: observable,
      dropDirection: observable,
      dropPreviewRect: observable,
      tabReorderTarget: observable,
      panelOrder: computed,
      panelSizes: computed,
      panelNodes: computed,
      panelCount: computed,
      geometry: computed,
      canUseSavedLayoutSlots: computed,
      canSaveCurrentLayoutSlot: computed,
      bootstrap: action,
      saveCurrentLayoutSlot: action,
      applySavedLayoutSlot: action,
      deleteSavedLayoutSlot: action,
      pinPanelsAsRestorePlaceholder: action,
      syncPanelBindings: action,
      setViewport: action,
      setSplitSizes: action,
      splitPanel: action,
      removePanel: action,
      ensurePrimaryPanelForKind: action,
      focusPrimaryPanel: action,
      attachTabToPanel: action,
      attachTabToPrimaryPanel: action,
      splitTabToDirection: action,
      detachTabsFromLayout: action,
      detachTabFromLayout: action,
      importPanelFromExternal: action,
      setTabReorderTarget: action,
      clearTabReorderTarget: action,
      setFocusedPanel: action,
      setPanelActiveTab: action,
      startPanelDragging: action,
      startExternalPanelDragging: action,
      startTabDragging: action,
      setDragPointer: action,
      setDropTarget: action,
      clearDragging: action,
      commitDragging: action,
      swapPanels: action,
    });
  }

  get panelNodes() {
    return listPanels(this.tree);
  }

  get panelCount(): number {
    return this.panelNodes.length;
  }

  get geometry() {
    return computeLayoutGeometry(this.tree, this.viewport);
  }

  /**
   * Compatibility projection for legacy code paths.
   */
  get panelOrder(): PanelKind[] {
    return this.panelNodes.map((node) => node.panel.kind);
  }

  /**
   * Compatibility projection for legacy code paths.
   */
  get panelSizes(): number[] {
    return deriveLegacyLayoutSnapshot(this.tree).panelSizes;
  }

  get panelTabs(): Record<string, LayoutPanelTabBinding> {
    return this.tree.panelTabs || {};
  }

  get canSaveCurrentLayoutSlot(): boolean {
    return (
      this.savedLayoutSlots.length < MAX_SAVED_LAYOUT_SLOTS &&
      this.shouldPersistLayout()
    );
  }

  get canUseSavedLayoutSlots(): boolean {
    return this.shouldPersistLayout();
  }

  bootstrap() {
    const settings = this.appStore.settings;
    const savedLayoutState = normalizeSavedLayoutState(settings?.layout);
    const tree = buildLayoutTree(settings?.layout);
    this.tree = tree;
    this.savedLayoutSlots = savedLayoutState.slots;
    this.activeSavedLayoutId = savedLayoutState.activeSavedLayoutId;
    this.pinnedEmptyPanelIds.clear();
    this.pinRestoredEmptyTabPanels(this.tree);

    if (!this.tree.focusedPanelId) {
      this.tree.focusedPanelId = getFirstPanelId(this.tree) ?? undefined;
    }
    this.syncPanelBindings({ persist: false });
    this.isReady = true;
  }

  async saveCurrentLayoutSlot(): Promise<SavedLayoutSlot | null> {
    if (!this.canSaveCurrentLayoutSlot) {
      return null;
    }

    this.clearPersistTimer();
    const result = addSavedLayoutSlot(this.savedLayoutSlots, toJS(this.tree));
    if (!result.slot) {
      return null;
    }

    this.savedLayoutSlots = result.slots;
    this.activeSavedLayoutId = result.slot.id;
    await this.saveLayout();
    return result.slot;
  }

  async applySavedLayoutSlot(slotId: string): Promise<boolean> {
    let slot = findSavedLayoutSlot(this.savedLayoutSlots, slotId);
    if (!slot || !this.shouldPersistLayout()) {
      return false;
    }

    this.clearPersistTimer();
    this.updateActiveSavedLayoutSnapshot();
    slot = findSavedLayoutSlot(this.savedLayoutSlots, slotId) || slot;

    const nextTree = buildLayoutTree({
      panelOrder: slot.snapshot.panelOrder,
      panelSizes: slot.snapshot.panelSizes,
      v2: slot.snapshot.v2,
    });
    if (!this.canApplyRestoredTree(nextTree)) {
      return false;
    }

    this.pinnedEmptyPanelIds.clear();
    this.tree = nextTree;
    this.pinRestoredEmptyTabPanels(this.tree);
    if (!this.tree.focusedPanelId) {
      this.tree.focusedPanelId = getFirstPanelId(this.tree) ?? undefined;
    }
    this.activeSavedLayoutId = slot.id;
    this.pinMissingRestoredTabPanels();
    this.syncGlobalActiveFromRestoredPanelTabs(this.tree);
    this.syncPanelBindings({
      persist: false,
      preservePanelActiveTabs: true,
    });
    await this.saveLayout();
    return true;
  }

  async deleteSavedLayoutSlot(slotId: string): Promise<boolean> {
    const previousLength = this.savedLayoutSlots.length;
    const nextSlots = deleteSavedLayoutSlot(this.savedLayoutSlots, slotId);
    if (nextSlots.length === previousLength) {
      return false;
    }

    this.clearPersistTimer();
    this.savedLayoutSlots = nextSlots;
    if (this.activeSavedLayoutId === slotId) {
      this.activeSavedLayoutId = null;
    }
    await this.saveLayout();
    return true;
  }

  getPanelsWithMissingTabBindings(
    kind: PanelKind,
    ownerTabIds: Iterable<string>,
  ): string[] {
    if (!getPanelKindAdapter(kind).supportsTabs) {
      return [];
    }
    const ownerSet = new Set<string>(ownerTabIds);
    const panels = this.panelNodes.filter((node) => node.panel.kind === kind);
    const missingPanels: string[] = [];

    panels.forEach((panel) => {
      const panelId = panel.panel.id;
      const persistedTabIds = this.tree.panelTabs?.[panelId]?.tabIds || [];
      if (!persistedTabIds.length) return;
      const hasMissingTabId = persistedTabIds.some(
        (tabId) => !ownerSet.has(tabId),
      );
      if (!hasMissingTabId) return;
      missingPanels.push(panelId);
    });

    return missingPanels;
  }

  pinPanelsAsRestorePlaceholder(panelIds: string[]): void {
    if (!Array.isArray(panelIds) || panelIds.length === 0) return;
    const panelIdSet = new Set(this.panelNodes.map((node) => node.panel.id));
    panelIds.forEach((panelId) => {
      if (!panelIdSet.has(panelId)) return;
      this.pinnedEmptyPanelIds.add(panelId);
    });
  }

  syncPanelBindings(options?: SyncPanelBindingOptions) {
    const persist = options?.persist !== false;
    const currentPanelIds = new Set(
      this.panelNodes.map((node) => node.panel.id),
    );
    Array.from(this.pinnedEmptyPanelIds).forEach((panelId) => {
      if (!currentPanelIds.has(panelId)) {
        this.pinnedEmptyPanelIds.delete(panelId);
      }
    });

    let nextTree = this.tree;
    let pass = 0;
    while (pass < MAX_LAYOUT_PANELS + 2) {
      pass += 1;
      nextTree = this.enforcePanelKindLimits(nextTree);
      const panelTabs = this.computeBindingsForTree(nextTree, {
        preservePanelActiveTabs: options?.preservePanelActiveTabs,
      });
      const { managerPanels: _legacyManagerPanels, ...treeWithoutManager } =
        nextTree as LayoutTree & {
          managerPanels?: Partial<Record<PanelKind, string>>;
        };
      nextTree = {
        ...treeWithoutManager,
        panelTabs,
      };
      Object.entries(panelTabs).forEach(([panelId, binding]) => {
        if ((binding.tabIds || []).length > 0) {
          this.pinnedEmptyPanelIds.delete(panelId);
        }
      });
      const removableEmptyPanelId = this.findAutoRemovableEmptyPanelId(
        nextTree,
        panelTabs,
      );
      if (!removableEmptyPanelId) {
        break;
      }
      const pruned = removePanel(nextTree, removableEmptyPanelId);
      if (pruned === nextTree) {
        break;
      }
      nextTree = pruned;
    }

    this.tree = nextTree;
    const nextPanelIds = new Set(
      listPanels(nextTree).map((panel) => panel.panel.id),
    );
    Array.from(this.pinnedEmptyPanelIds).forEach((panelId) => {
      if (!nextPanelIds.has(panelId)) {
        this.pinnedEmptyPanelIds.delete(panelId);
      }
    });
    if (this.isDragging) {
      this.dropPreviewRect = this.computeDropPreviewRect();
    }

    if (persist) {
      this.saveLayoutDebounced();
    }
  }

  setViewport(width: number, height: number) {
    this.viewport = {
      width: Number.isFinite(width) ? Math.max(0, width) : 0,
      height: Number.isFinite(height) ? Math.max(0, height) : 0,
    };
    if (this.isDragging) {
      this.dropPreviewRect = this.computeDropPreviewRect();
    }
  }

  setSplitSizes(splitNodeId: string, sizes: number[]) {
    const splitNode = findSplitNodeById(this.tree.root, splitNodeId);
    const nextSizes = (() => {
      if (!splitNode) return sizes;
      const parentRect =
        this.geometry.nodeRects[splitNode.id] || getViewportRect(this.viewport);
      const minPercentages = computeChildMinSizePercentages(
        splitNode,
        parentRect,
        this.viewport.height,
      );
      return clampSplitSizesToChildMinSizePercentages(sizes, minPercentages);
    })();
    const nextTree = setSplitSizes(this.tree, splitNodeId, nextSizes);
    this.applyTree(nextTree);
  }

  splitPanel(
    targetPanelId: string,
    kind: PanelKind,
    direction: "horizontal" | "vertical",
    position: "before" | "after",
  ) {
    if (!this.canSplitPanel(targetPanelId, kind, direction, position)) {
      return;
    }
    const nextTree = splitPanel(
      this.tree,
      targetPanelId,
      kind,
      direction,
      position,
    );
    if (nextTree !== this.tree && nextTree.focusedPanelId) {
      this.pinnedEmptyPanelIds.add(nextTree.focusedPanelId);
    }
    this.applyTree(nextTree);
  }

  removePanel(panelId: string) {
    if (!this.canRemovePanel(panelId)) return;
    this.pinnedEmptyPanelIds.delete(panelId);
    const nextTree = removePanel(this.tree, panelId);
    this.applyTree(nextTree);
  }

  swapPanels(panelAId: string, panelBId: string) {
    const nextTree = swapPanels(this.tree, panelAId, panelBId);
    this.applyTree(nextTree);
  }

  canRemovePanel(panelId: string): boolean {
    // Moving a panel to another window and closing a panel both remove that panel
    // from the current layout tree. The window must never be left without any panel.
    // Keep this rule window-scoped rather than kind-scoped: a panel may still be
    // moved out even when it is the only panel of its kind, as long as some
    // other panel remains in the same window.
    if (this.panelCount <= 1) return false;
    return this.panelNodes.some((node) => node.panel.id === panelId);
  }

  setFocusedPanel(panelId: string) {
    this.tree = {
      ...this.tree,
      focusedPanelId: panelId,
    };
    this.saveLayoutDebounced();
  }

  getPanelIdsByKind(kind: PanelKind): string[] {
    return this.panelNodes
      .filter((node) => node.panel.kind === kind)
      .map((node) => node.panel.id);
  }

  getPrimaryPanelId(kind: PanelKind): string | null {
    return this.getPanelIdsByKind(kind)[0] || null;
  }

  canSplitPanel(
    targetPanelId: string,
    kind: PanelKind,
    direction: SplitDirection,
    position: "before" | "after",
  ): boolean {
    if (!this.panelNodes.some((node) => node.panel.id === targetPanelId)) {
      return false;
    }
    if (this.panelCount >= MAX_LAYOUT_PANELS) {
      return false;
    }

    const adapter = getPanelKindAdapter(kind);
    const maxPanels = adapter.maxPanels;
    if (
      Number.isFinite(maxPanels) &&
      this.getPanelIdsByKind(kind).length >= maxPanels!
    ) {
      return false;
    }

    const projectedTree = splitPanelWithPanelId(
      this.tree,
      targetPanelId,
      {
        kind,
        panelId: PREVIEW_PANEL_ID,
      },
      direction,
      position,
    );
    return validateLayoutTree(projectedTree, this.viewport).valid;
  }

  getPanelTabIds(panelId: string): string[] {
    return this.tree.panelTabs?.[panelId]?.tabIds || [];
  }

  getPanelActiveTabId(panelId: string): string | null {
    const binding = this.tree.panelTabs?.[panelId];
    if (!binding) return null;
    if (binding.activeTabId && binding.tabIds.includes(binding.activeTabId)) {
      return binding.activeTabId;
    }
    return binding.tabIds[0] || null;
  }

  setPanelActiveTab(panelId: string, tabId: string) {
    const kind = this.getPanelKindById(panelId);
    if (!kind) return;
    const adapter = getPanelKindAdapter(kind);
    if (!adapter.supportsTabs) return;
    const current = this.tree.panelTabs?.[panelId];
    if (!current || !current.tabIds.includes(tabId)) return;

    this.tree = {
      ...this.tree,
      panelTabs: {
        ...this.tree.panelTabs,
        [panelId]: {
          ...current,
          activeTabId: tabId,
        },
      },
      focusedPanelId: panelId,
    };
    this.saveLayoutDebounced();
    this.syncGlobalActiveFromPanel(kind, tabId);
  }

  ensurePrimaryPanelForKind(kind: PanelKind): string | null {
    const existing = this.getPrimaryPanelId(kind);
    if (existing) {
      return existing;
    }
    if (this.panelCount >= MAX_LAYOUT_PANELS) {
      return null;
    }

    const splitPosition = kind === "listPanel" ? "before" : "after";
    const focusedPanel = this.tree.focusedPanelId
      ? this.panelNodes.find(
          (node) => node.panel.id === this.tree.focusedPanelId,
        )
      : undefined;
    const targetPanelId =
      kind === "listPanel"
        ? this.panelNodes[0]?.panel.id || null
        : focusedPanel && focusedPanel.panel.kind !== "listPanel"
          ? focusedPanel.panel.id
          : this.panelNodes.find((node) => node.panel.kind !== "listPanel")
              ?.panel.id ||
            this.panelNodes[0]?.panel.id ||
            null;
    if (!targetPanelId) {
      return null;
    }

    const createdPanelId = makeLayoutId(`panel-${kind}`);
    if (!this.canSplitPanel(targetPanelId, kind, "horizontal", splitPosition)) {
      return null;
    }
    const nextTree = splitPanelWithPanelId(
      this.tree,
      targetPanelId,
      {
        kind,
        panelId: createdPanelId,
      },
      "horizontal",
      splitPosition,
    );
    if (nextTree === this.tree) {
      return null;
    }
    this.pinnedEmptyPanelIds.add(createdPanelId);
    this.applyTree(nextTree);
    return this.getPrimaryPanelId(kind);
  }

  focusPrimaryPanel(kind: PanelKind): string | null {
    const panelId = this.getPrimaryPanelId(kind);
    if (!panelId) return null;
    this.setFocusedPanel(panelId);
    return panelId;
  }

  attachTabToPanel(kind: PanelKind, tabId: string, targetPanelId: string) {
    this.moveTabBinding(kind, tabId, targetPanelId);
  }

  attachTabToPrimaryPanel(kind: PanelKind, tabId: string) {
    const panelId = this.getPrimaryPanelId(kind);
    if (!panelId) return;
    this.moveTabBinding(kind, tabId, panelId);
  }

  splitTabToDirection(
    payload: TabDragPayload,
    targetPanelId: string,
    direction: Exclude<DropDirection, "center">,
  ) {
    if (!getPanelKindAdapter(payload.kind).supportsTabs) {
      return;
    }
    this.commitTabDrop(payload, targetPanelId, direction);
  }

  detachTabsFromLayout(kind: PanelKind, tabIds: string[]): void {
    if (!getPanelKindAdapter(kind).supportsTabs) {
      return;
    }
    if (!Array.isArray(tabIds) || tabIds.length === 0) return;
    const detachSet = new Set(
      tabIds
        .map((tabId) => String(tabId || "").trim())
        .filter((tabId) => tabId.length > 0),
    );
    if (detachSet.size === 0) return;

    const panelIds = this.panelNodes
      .filter((node) => node.panel.kind === kind)
      .map((node) => node.panel.id);
    if (panelIds.length === 0) return;

    const nextPanelTabs: Record<string, LayoutPanelTabBinding> = {
      ...(this.tree.panelTabs || {}),
    };
    let changed = false;

    panelIds.forEach((panelId) => {
      const current = nextPanelTabs[panelId];
      if (!current) {
        return;
      }
      const tabIds = current.tabIds.filter((id) => !detachSet.has(id));
      if (tabIds.length === current.tabIds.length) {
        return;
      }
      const activeTabId =
        current.activeTabId && tabIds.includes(current.activeTabId)
          ? current.activeTabId
          : tabIds[0];
      nextPanelTabs[panelId] = {
        tabIds,
        ...(activeTabId ? { activeTabId } : {}),
      };
      changed = true;
    });

    if (!changed) {
      return;
    }

    this.tree = {
      ...this.tree,
      panelTabs: nextPanelTabs,
    };
    this.syncPanelBindings({ persist: false });
    this.saveLayoutDebounced();
  }

  detachTabFromLayout(kind: PanelKind, tabId: string): void {
    this.detachTabsFromLayout(kind, [tabId]);
  }

  importPanelFromExternal(
    kind: PanelKind,
    tabBinding?: LayoutPanelTabBinding,
    dropTarget?: { panelId: string; direction: DropDirection },
  ): string | null {
    // The workspace resolves drag hover semantics before calling into the store.
    // This method owns only the tree mutation: choose an anchor, split in the
    // imported panel, and rebind any transferred tabs to the new panel node.
    if (this.panelCount >= MAX_LAYOUT_PANELS) {
      return null;
    }

    let targetPanelId: string;
    let splitDirection: SplitDirection = "horizontal";
    let splitPosition: "before" | "after" = "after";

    if (dropTarget && dropTarget.direction !== "center") {
      const placement = toSplitPlacement(dropTarget.direction);
      if (
        placement &&
        this.panelNodes.some((node) => node.panel.id === dropTarget.panelId)
      ) {
        targetPanelId = dropTarget.panelId;
        splitDirection = placement.direction;
        splitPosition = placement.position;
      } else {
        const fallback =
          (this.tree.focusedPanelId &&
          this.panelNodes.some(
            (node) => node.panel.id === this.tree.focusedPanelId,
          )
            ? this.tree.focusedPanelId
            : this.panelNodes[0]?.panel.id) || null;
        if (!fallback) return null;
        targetPanelId = fallback;
      }
    } else {
      const anchorPanelId =
        (this.tree.focusedPanelId &&
        this.panelNodes.some(
          (node) => node.panel.id === this.tree.focusedPanelId,
        )
          ? this.tree.focusedPanelId
          : this.panelNodes[0]?.panel.id) || null;
      if (!anchorPanelId) return null;
      targetPanelId = anchorPanelId;
    }

    const normalizedTabBinding = (() => {
      if (!getPanelKindAdapter(kind).supportsTabs || !tabBinding) {
        return undefined;
      }
      const tabIds = unique(
        (tabBinding.tabIds || []).filter(
          (tabId): tabId is string =>
            typeof tabId === "string" && tabId.length > 0,
        ),
      );
      const activeTabId =
        typeof tabBinding.activeTabId === "string" &&
        tabIds.includes(tabBinding.activeTabId)
          ? tabBinding.activeTabId
          : tabIds[0];
      return {
        tabIds,
        ...(activeTabId ? { activeTabId } : {}),
      };
    })();

    const baseTree =
      normalizedTabBinding && normalizedTabBinding.tabIds.length > 0
        ? this.createTreeWithoutTabs(
            this.tree,
            kind,
            normalizedTabBinding.tabIds,
          )
        : this.tree;

    const panelId = makeLayoutId(`panel-${kind}`);
    if (
      !this.canSplitPanel(targetPanelId, kind, splitDirection, splitPosition)
    ) {
      return null;
    }
    const splitTree = splitPanelWithPanelId(
      baseTree,
      targetPanelId,
      {
        kind,
        panelId,
      },
      splitDirection,
      splitPosition,
    );
    if (splitTree === this.tree) {
      return null;
    }

    let nextTree = splitTree;
    if (normalizedTabBinding) {
      nextTree = {
        ...splitTree,
        panelTabs: {
          ...(splitTree.panelTabs || {}),
          [panelId]: {
            tabIds: normalizedTabBinding.tabIds,
            ...(normalizedTabBinding.activeTabId
              ? { activeTabId: normalizedTabBinding.activeTabId }
              : {}),
          },
        },
        focusedPanelId: panelId,
      };
    }

    const treeBefore = this.tree;
    this.applyTree(nextTree);
    if (this.tree === treeBefore) {
      return null;
    }
    if (getPanelKindAdapter(kind).supportsTabs) {
      const importedActiveTabId = nextTree.panelTabs?.[panelId]?.activeTabId;
      if (importedActiveTabId) {
        this.syncGlobalActiveFromPanel(kind, importedActiveTabId);
      }
    }
    return panelId;
  }

  setTabReorderTarget(
    panelId: string,
    anchorTabId: string | null,
    position: "before" | "after",
  ) {
    this.tabReorderTarget = {
      panelId,
      anchorTabId,
      position,
    };
    this.dropPreviewRect = this.computeDropPreviewRect();
  }

  clearTabReorderTarget() {
    this.tabReorderTarget = null;
    this.dropPreviewRect = this.computeDropPreviewRect();
  }

  startPanelDragging(panelId: string, x: number, y: number) {
    this.isDragging = true;
    this.dragType = "panel";
    this.draggingPanelId = panelId;
    this.draggingExternalPanelKind = null;
    this.draggingTab = null;
    this.dragX = x;
    this.dragY = y;
    this.dropTargetPanelId = null;
    this.dropDirection = null;
    this.dropPreviewRect = null;
    this.tabReorderTarget = null;
  }

  startExternalPanelDragging(kind: PanelKind, x: number, y: number) {
    this.isDragging = true;
    this.dragType = "panel";
    this.draggingPanelId = null;
    this.draggingExternalPanelKind = kind;
    this.draggingTab = null;
    this.dragX = x;
    this.dragY = y;
    this.dropTargetPanelId = null;
    this.dropDirection = null;
    this.dropPreviewRect = null;
    this.tabReorderTarget = null;
  }

  startTabDragging(payload: TabDragPayload, x: number, y: number) {
    this.isDragging = true;
    this.dragType = "tab";
    this.draggingPanelId = null;
    this.draggingExternalPanelKind = null;
    this.draggingTab = payload;
    this.dragX = x;
    this.dragY = y;
    this.dropTargetPanelId = null;
    this.dropDirection = null;
    this.dropPreviewRect = null;
    this.tabReorderTarget = null;
  }

  setDragPointer(x: number, y: number) {
    this.dragX = x;
    this.dragY = y;
  }

  setDropTarget(panelId: string | null, direction: DropDirection | null) {
    this.dropTargetPanelId = panelId;
    this.dropDirection = direction;
    if (direction !== "center") {
      this.tabReorderTarget = null;
    }
    this.dropPreviewRect = this.computeDropPreviewRect();
  }

  clearDragging() {
    this.isDragging = false;
    this.dragType = null;
    this.draggingPanelId = null;
    this.draggingExternalPanelKind = null;
    this.draggingTab = null;
    this.dropTargetPanelId = null;
    this.dropDirection = null;
    this.dropPreviewRect = null;
    this.tabReorderTarget = null;
  }

  commitDragging() {
    if (!this.isDragging || !this.dropTargetPanelId || !this.dropDirection) {
      this.clearDragging();
      return;
    }

    if (this.dragType === "panel" && this.draggingPanelId) {
      const nextTree = movePanel(
        this.tree,
        this.draggingPanelId,
        this.dropTargetPanelId,
        this.dropDirection,
      );
      this.clearDragging();
      this.applyTree(nextTree);
      return;
    }

    if (this.dragType === "panel" && this.draggingExternalPanelKind) {
      this.clearDragging();
      return;
    }

    if (this.dragType === "tab" && this.draggingTab) {
      const payload = this.draggingTab;
      const targetPanelId = this.dropTargetPanelId;
      const dropDirection = this.dropDirection;
      const reorderTarget = this.tabReorderTarget;
      this.clearDragging();
      this.commitTabDrop(
        payload,
        targetPanelId,
        dropDirection,
        reorderTarget || undefined,
      );
      return;
    }

    this.clearDragging();
  }

  getPanelRect(panelId: string): LayoutRect | null {
    return this.geometry.panelRects[panelId] || null;
  }

  private commitTabDrop(
    payload: TabDragPayload,
    targetPanelId: string,
    direction: DropDirection,
    reorderTarget?: Exclude<TabReorderTarget, null>,
  ) {
    if (!getPanelKindAdapter(payload.kind).supportsTabs) {
      return;
    }
    if (!this.canAcceptTabDrop(payload, targetPanelId, direction)) {
      return;
    }
    this.showTabsInLayout(payload.kind, [payload.tabId]);

    if (direction === "center") {
      this.moveTabBinding(
        payload.kind,
        payload.tabId,
        targetPanelId,
        reorderTarget
          ? {
              anchorTabId: reorderTarget.anchorTabId,
              position: reorderTarget.position,
            }
          : undefined,
      );
      this.setPanelActiveTab(targetPanelId, payload.tabId);
      return;
    }

    const splitPlacement = toSplitPlacement(direction);
    if (!splitPlacement) {
      return;
    }

    const newPanelId = makeLayoutId(`panel-${payload.kind}`);
    const nextTree = splitPanelWithPanelId(
      this.tree,
      targetPanelId,
      {
        kind: payload.kind,
        panelId: newPanelId,
      },
      splitPlacement.direction,
      splitPlacement.position,
    );
    const nextWithBinding = this.createTreeWithMovedTab(
      nextTree,
      payload.kind,
      payload.tabId,
      newPanelId,
    );
    if (!nextWithBinding) {
      return;
    }
    this.applyTree(nextWithBinding);
    this.syncGlobalActiveFromPanel(payload.kind, payload.tabId);
  }

  private computeDropPreviewRect(): LayoutRect | null {
    if (!this.isDragging || !this.dropTargetPanelId || !this.dropDirection) {
      return null;
    }

    if (this.dragType === "panel" && this.draggingPanelId) {
      const projectedTree = movePanel(
        this.tree,
        this.draggingPanelId,
        this.dropTargetPanelId,
        this.dropDirection,
      );
      if (projectedTree === this.tree) return null;
      if (!validateLayoutTree(projectedTree, this.viewport).valid) return null;
      const projectedGeometry = computeLayoutGeometry(
        projectedTree,
        this.viewport,
      );
      return projectedGeometry.panelRects[this.draggingPanelId] || null;
    }

    if (this.dragType === "panel" && this.draggingExternalPanelKind) {
      if (
        !this.canAcceptExternalPanelDrop(
          this.draggingExternalPanelKind,
          this.dropTargetPanelId,
          this.dropDirection,
        )
      ) {
        return null;
      }
      const splitPlacement = toSplitPlacement(this.dropDirection);
      if (!splitPlacement) return null;
      const projectedTree = splitPanelWithPanelId(
        this.tree,
        this.dropTargetPanelId,
        {
          kind: this.draggingExternalPanelKind,
          panelId: PREVIEW_PANEL_ID,
        },
        splitPlacement.direction,
        splitPlacement.position,
      );
      if (!validateLayoutTree(projectedTree, this.viewport).valid) return null;
      const projectedGeometry = computeLayoutGeometry(
        projectedTree,
        this.viewport,
      );
      return projectedGeometry.panelRects[PREVIEW_PANEL_ID] || null;
    }

    if (this.dragType === "tab" && this.draggingTab) {
      if (
        !this.canAcceptTabDrop(
          this.draggingTab,
          this.dropTargetPanelId,
          this.dropDirection,
        )
      ) {
        return null;
      }
      if (this.dropDirection === "center") {
        if (
          this.tabReorderTarget &&
          this.tabReorderTarget.panelId === this.dropTargetPanelId
        ) {
          return null;
        }
        return this.geometry.panelRects[this.dropTargetPanelId] || null;
      }
      const splitPlacement = toSplitPlacement(this.dropDirection);
      if (!splitPlacement) return null;
      const projectedTree = splitPanelWithPanelId(
        this.tree,
        this.dropTargetPanelId,
        {
          kind: this.draggingTab.kind,
          panelId: PREVIEW_PANEL_ID,
        },
        splitPlacement.direction,
        splitPlacement.position,
      );
      if (!validateLayoutTree(projectedTree, this.viewport).valid) return null;
      const projectedGeometry = computeLayoutGeometry(
        projectedTree,
        this.viewport,
      );
      return projectedGeometry.panelRects[PREVIEW_PANEL_ID] || null;
    }

    return null;
  }

  private canAcceptTabDrop(
    payload: TabDragPayload,
    targetPanelId: string,
    direction: DropDirection,
  ): boolean {
    if (!getPanelKindAdapter(payload.kind).supportsTabs) {
      return false;
    }
    const targetKind = this.getPanelKindById(targetPanelId);
    if (!targetKind) return false;

    if (direction === "center") {
      return targetKind === payload.kind;
    }

    if (this.panelCount >= MAX_LAYOUT_PANELS) {
      return false;
    }

    const splitPlacement = toSplitPlacement(direction);
    if (!splitPlacement) {
      return false;
    }

    return this.canSplitPanel(
      targetPanelId,
      payload.kind,
      splitPlacement.direction,
      splitPlacement.position,
    );
  }

  private canAcceptExternalPanelDrop(
    kind: PanelKind,
    targetPanelId: string,
    direction: DropDirection,
  ): boolean {
    if (direction === "center") {
      return false;
    }

    if (this.panelCount >= MAX_LAYOUT_PANELS) {
      return false;
    }

    const adapter = getPanelKindAdapter(kind);
    const maxPanels = adapter.maxPanels;
    if (
      Number.isFinite(maxPanels) &&
      this.getPanelIdsByKind(kind).length >= maxPanels!
    ) {
      return false;
    }

    const splitPlacement = toSplitPlacement(direction);
    if (!splitPlacement) {
      return false;
    }

    return this.canSplitPanel(
      targetPanelId,
      kind,
      splitPlacement.direction,
      splitPlacement.position,
    );
  }

  getPanelKindById(panelId: string): PanelKind | null {
    return (
      this.panelNodes.find((node) => node.panel.id === panelId)?.panel.kind ||
      null
    );
  }

  private computeBindingsForTree(
    tree: LayoutTree,
    options?: { preservePanelActiveTabs?: boolean },
  ): Record<string, LayoutPanelTabBinding> {
    const panelNodes = listPanels(tree);
    const panelTabs: Record<string, LayoutPanelTabBinding> = {};

    PANEL_KIND_LIST.forEach((kind) => {
      const adapter = getPanelKindAdapter(kind);
      const inventoryHydrated = adapter.isOwnerInventoryHydrated(this.appStore);
      const panelIds = panelNodes
        .filter((node) => node.panel.kind === kind)
        .map((node) => node.panel.id);
      if (panelIds.length === 0) {
        return;
      }

      if (!adapter.supportsTabs) {
        return;
      }

      if (!inventoryHydrated) {
        panelIds.forEach((panelId) => {
          const existing = tree.panelTabs?.[panelId];
          const tabIds = unique(existing?.tabIds || []);
          const activeTabId =
            existing?.activeTabId && tabIds.includes(existing.activeTabId)
              ? existing.activeTabId
              : tabIds[0];
          panelTabs[panelId] = {
            tabIds,
            ...(activeTabId ? { activeTabId } : {}),
          };
        });
        return;
      }

      const ownerTabIds = adapter.getOwnerTabIds(this.appStore);
      const ownerSet = new Set(ownerTabIds);
      const consumed = new Set<string>();

      panelIds.forEach((panelId) => {
        const existing = tree.panelTabs?.[panelId];
        const tabIds = unique(
          (existing?.tabIds || []).filter(
            (id) => ownerSet.has(id) && !consumed.has(id),
          ),
        );
        tabIds.forEach((id) => consumed.add(id));
        panelTabs[panelId] = {
          tabIds,
          ...(existing?.activeTabId
            ? { activeTabId: existing.activeTabId }
            : {}),
        };
      });

      const missing = ownerTabIds.filter((tabId) => !consumed.has(tabId));
      if (missing.length > 0) {
        const primaryPanelId = panelIds[0];
        panelTabs[primaryPanelId] = {
          ...panelTabs[primaryPanelId],
          tabIds: unique([
            ...(panelTabs[primaryPanelId]?.tabIds || []),
            ...missing,
          ]),
        };
      }

      panelIds.forEach((panelId) => {
        const binding = panelTabs[panelId];
        if (!binding) return;
        const activeTabId = binding.activeTabId;
        if (!activeTabId || !binding.tabIds.includes(activeTabId)) {
          panelTabs[panelId] = {
            ...binding,
            ...(binding.tabIds[0] ? { activeTabId: binding.tabIds[0] } : {}),
          };
          if (binding.tabIds.length === 0) {
            delete panelTabs[panelId].activeTabId;
          }
        }
      });

      const globalActiveTabId = options?.preservePanelActiveTabs
        ? null
        : adapter.getGlobalActiveTabId(this.appStore);
      if (globalActiveTabId) {
        const activeOwnerPanelId = panelIds.find((panelId) =>
          panelTabs[panelId]?.tabIds.includes(globalActiveTabId),
        );
        if (activeOwnerPanelId) {
          panelTabs[activeOwnerPanelId] = {
            ...panelTabs[activeOwnerPanelId],
            activeTabId: globalActiveTabId,
          };
        }
      }
    });

    return panelTabs;
  }

  private findAutoRemovableEmptyPanelId(
    tree: LayoutTree,
    panelTabs: Record<string, LayoutPanelTabBinding>,
  ): string | null {
    const panels = listPanels(tree);
    const eligible = panels.filter((panel) => {
      const adapter = getPanelKindAdapter(panel.panel.kind);
      if (!adapter.supportsTabs) {
        return false;
      }
      if (!adapter.isOwnerInventoryHydrated(this.appStore)) {
        return false;
      }
      if (this.pinnedEmptyPanelIds.has(panel.panel.id)) {
        return false;
      }
      const tabIds = panelTabs[panel.panel.id]?.tabIds || [];
      if (tabIds.length > 0) return false;
      // Auto-pruning is allowed only when another panel still exists in the window.
      return panels.length > 1;
    });
    if (eligible.length === 0) return null;

    return eligible[0]?.panel.id || null;
  }

  private moveTabBinding(
    kind: PanelKind,
    tabId: string,
    targetPanelId: string,
    options?: {
      anchorTabId?: string | null;
      position?: "before" | "after";
    },
  ) {
    if (!getPanelKindAdapter(kind).supportsTabs) {
      return;
    }
    this.showTabsInLayout(kind, [tabId]);
    const nextTree = this.createTreeWithMovedTab(
      this.tree,
      kind,
      tabId,
      targetPanelId,
      options,
    );
    if (!nextTree) return;
    this.tree = nextTree;
    this.syncGlobalActiveFromPanel(kind, tabId);
    this.syncPanelBindings({ persist: false });
    this.saveLayoutDebounced();
  }

  private showTabsInLayout(kind: PanelKind, tabIds: string[]): void {
    const runtime = this.appStore as AppStore & {
      showTabsInLayout?: (panelKind: PanelKind, tabIds: string[]) => void;
    };
    runtime.showTabsInLayout?.(kind, tabIds);
  }

  private createTreeWithoutTabs(
    tree: LayoutTree,
    kind: PanelKind,
    tabIdsToRemove: string[],
  ): LayoutTree {
    if (!getPanelKindAdapter(kind).supportsTabs) {
      return tree;
    }
    const removalSet = new Set(
      tabIdsToRemove
        .map((tabId) => String(tabId || "").trim())
        .filter((tabId) => tabId.length > 0),
    );
    if (removalSet.size === 0) {
      return tree;
    }

    const panelIds = listPanels(tree)
      .filter((node) => node.panel.kind === kind)
      .map((node) => node.panel.id);
    if (panelIds.length === 0) {
      return tree;
    }

    const nextPanelTabs: Record<string, LayoutPanelTabBinding> = {
      ...(tree.panelTabs || {}),
    };
    let changed = false;

    panelIds.forEach((panelId) => {
      const current = nextPanelTabs[panelId];
      if (!current) {
        return;
      }
      const nextTabIds = current.tabIds.filter(
        (tabId) => !removalSet.has(tabId),
      );
      if (nextTabIds.length === current.tabIds.length) {
        return;
      }
      const activeTabId =
        current.activeTabId && nextTabIds.includes(current.activeTabId)
          ? current.activeTabId
          : nextTabIds[0];
      nextPanelTabs[panelId] = {
        tabIds: nextTabIds,
        ...(activeTabId ? { activeTabId } : {}),
      };
      changed = true;
    });

    if (!changed) {
      return tree;
    }

    return {
      ...tree,
      panelTabs: nextPanelTabs,
    };
  }

  private createTreeWithMovedTab(
    tree: LayoutTree,
    kind: PanelKind,
    tabId: string,
    targetPanelId: string,
    options?: {
      anchorTabId?: string | null;
      position?: "before" | "after";
    },
  ): LayoutTree | null {
    if (!getPanelKindAdapter(kind).supportsTabs) {
      return null;
    }
    const panelIds = listPanels(tree)
      .filter((node) => node.panel.kind === kind)
      .map((node) => node.panel.id);
    if (!panelIds.includes(targetPanelId)) return null;

    const nextPanelTabs: Record<string, LayoutPanelTabBinding> = {
      ...(tree.panelTabs || {}),
    };

    panelIds.forEach((panelId) => {
      const current = nextPanelTabs[panelId] || { tabIds: [] };
      const tabIds = current.tabIds.filter((id) => id !== tabId);
      const nextBinding: LayoutPanelTabBinding = {
        tabIds,
        ...(current.activeTabId ? { activeTabId: current.activeTabId } : {}),
      };
      if (
        !nextBinding.activeTabId ||
        !tabIds.includes(nextBinding.activeTabId)
      ) {
        if (tabIds[0]) {
          nextBinding.activeTabId = tabIds[0];
        } else {
          delete nextBinding.activeTabId;
        }
      }
      nextPanelTabs[panelId] = nextBinding;
    });

    const target = nextPanelTabs[targetPanelId] || { tabIds: [] };
    const targetTabIds = unique(target.tabIds);
    const anchorTabId = options?.anchorTabId || null;
    const targetAnchorIndex = anchorTabId
      ? targetTabIds.indexOf(anchorTabId)
      : -1;
    const insertionIndex = (() => {
      if (targetAnchorIndex < 0) return targetTabIds.length;
      if (options?.position === "before") return targetAnchorIndex;
      return targetAnchorIndex + 1;
    })();
    targetTabIds.splice(
      Math.max(0, Math.min(targetTabIds.length, insertionIndex)),
      0,
      tabId,
    );
    nextPanelTabs[targetPanelId] = {
      ...target,
      tabIds: targetTabIds,
      activeTabId: tabId,
    };

    return {
      ...tree,
      panelTabs: nextPanelTabs,
      focusedPanelId: targetPanelId,
    };
  }

  private syncGlobalActiveFromPanel(kind: PanelKind, tabId: string) {
    const adapter = getPanelKindAdapter(kind);
    if (!adapter.supportsTabs) {
      return;
    }
    adapter.setGlobalActiveTab(this.appStore, tabId);
  }

  private syncGlobalActiveFromRestoredPanelTabs(tree: LayoutTree): void {
    const panels = listPanels(tree);
    const syncPanel = (panelId: string): void => {
      const panel = panels.find((node) => node.panel.id === panelId);
      if (!panel) return;
      const adapter = getPanelKindAdapter(panel.panel.kind);
      if (!adapter.supportsTabs) return;
      const binding = tree.panelTabs?.[panelId];
      const activeTabId = binding?.activeTabId;
      if (!activeTabId || !binding.tabIds.includes(activeTabId)) return;
      if (adapter.isOwnerInventoryHydrated(this.appStore)) {
        const ownerIds = new Set(adapter.getOwnerTabIds(this.appStore));
        if (!ownerIds.has(activeTabId)) return;
      }
      this.syncGlobalActiveFromPanel(panel.panel.kind, activeTabId);
    };

    panels.forEach((panel) => syncPanel(panel.panel.id));
    if (tree.focusedPanelId) {
      syncPanel(tree.focusedPanelId);
    }
  }

  private enforcePanelKindLimits(tree: LayoutTree): LayoutTree {
    let nextTree = tree;
    PANEL_KIND_LIST.forEach((kind) => {
      const adapter = getPanelKindAdapter(kind);
      const maxPanels = adapter.maxPanels;
      if (!Number.isFinite(maxPanels) || !maxPanels || maxPanels <= 0) {
        return;
      }
      let panelIds = listPanels(nextTree)
        .filter((node) => node.panel.kind === kind)
        .map((node) => node.panel.id);
      while (panelIds.length > maxPanels) {
        const panelIdToRemove = panelIds[panelIds.length - 1];
        if (!panelIdToRemove) break;
        const pruned = removePanel(nextTree, panelIdToRemove);
        if (pruned === nextTree) {
          break;
        }
        this.pinnedEmptyPanelIds.delete(panelIdToRemove);
        nextTree = pruned;
        this.appStore.onPanelRemoved(kind);
        panelIds = listPanels(nextTree)
          .filter((node) => node.panel.kind === kind)
          .map((node) => node.panel.id);
      }
    });
    return nextTree;
  }

  private applyTree(nextTree: LayoutTree) {
    if (nextTree === this.tree) return;

    if (getPanelCount(nextTree) <= 0) {
      return;
    }

    const validation = validateLayoutTree(nextTree, this.viewport);
    if (!validation.valid) {
      return;
    }

    const focused = nextTree.focusedPanelId;
    if (!focused || !nextTree.root) {
      nextTree.focusedPanelId = getFirstPanelId(nextTree) ?? undefined;
    }

    this.tree = nextTree;
    this.syncPanelBindings({ persist: false });
    this.saveLayoutDebounced();
  }

  private pinMissingRestoredTabPanels(): void {
    PANEL_KIND_LIST.forEach((kind) => {
      const adapter = getPanelKindAdapter(kind);
      if (
        !adapter.supportsTabs ||
        !adapter.isOwnerInventoryHydrated(this.appStore)
      ) {
        return;
      }
      const missingPanelIds = this.getPanelsWithMissingTabBindings(
        kind,
        adapter.getOwnerTabIds(this.appStore),
      );
      this.pinPanelsAsRestorePlaceholder(missingPanelIds);
    });
  }

  private pinRestoredEmptyTabPanels(tree: LayoutTree): void {
    listPanels(tree).forEach((panel) => {
      if (!getPanelKindAdapter(panel.panel.kind).supportsTabs) {
        return;
      }
      const tabIds = tree.panelTabs?.[panel.panel.id]?.tabIds || [];
      if (tabIds.length > 0) {
        return;
      }
      this.pinnedEmptyPanelIds.add(panel.panel.id);
    });
  }

  private canApplyRestoredTree(tree: LayoutTree): boolean {
    if (getPanelCount(tree) <= 0) {
      return false;
    }
    const validation = validateLayoutTree(tree, this.viewport);
    if (validation.valid) {
      return true;
    }
    const reason = validation.reason || "";
    return (
      reason.startsWith("panel-width-limit:") ||
      reason.startsWith("panel-height-limit:") ||
      reason.startsWith("chat-height-limit:")
    );
  }

  private clearPersistTimer(): void {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
  }

  private updateActiveSavedLayoutSnapshot(): void {
    if (!this.activeSavedLayoutId) {
      return;
    }

    const result = overwriteSavedLayoutSlot(
      this.savedLayoutSlots,
      this.activeSavedLayoutId,
      toJS(this.tree),
    );
    if (!result.slot) {
      this.activeSavedLayoutId = null;
      return;
    }
    this.savedLayoutSlots = result.slots;
  }

  private saveLayoutDebounced() {
    this.updateActiveSavedLayoutSnapshot();
    this.clearPersistTimer();

    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      void this.saveLayout();
    }, 120);
  }

  flushPendingSaveSync(): void {
    this.clearPersistTimer();

    if (!this.shouldPersistLayout()) {
      return;
    }

    this.updateActiveSavedLayoutSnapshot();
    const payload = this.buildLayoutSettingsPayload();
    this.layoutSaveRequestId += 1;
    try {
      const setSync = window.gyshell.settings.setSync;
      if (typeof setSync === "function") {
        setSync(payload);
      } else {
        void window.gyshell.settings.set(payload);
      }
      this.applyLayoutSettingsPayload(payload.layout);
    } catch (error) {
      console.error("Failed to flush layout before window unload", error);
    }
  }

  private async saveLayout() {
    if (!this.shouldPersistLayout()) {
      return;
    }

    this.updateActiveSavedLayoutSnapshot();
    const payload = this.buildLayoutSettingsPayload();
    const requestId = ++this.layoutSaveRequestId;
    await window.gyshell.settings.set(payload);
    if (requestId !== this.layoutSaveRequestId) {
      return;
    }
    this.applyLayoutSettingsPayload(payload.layout);
  }

  private shouldPersistLayout(): boolean {
    if (typeof (this.appStore as any).shouldPersistLayout !== "function") {
      return true;
    }
    return (this.appStore as any).shouldPersistLayout() !== false;
  }

  private buildLayoutSettingsPayload() {
    const legacy = deriveLegacyLayoutSnapshot(this.tree);
    const treeSnapshot = toJS(this.tree);
    const savedLayoutSlots = toJS(this.savedLayoutSlots);

    return {
      layout: {
        panelOrder: legacy.panelOrder,
        panelSizes: legacy.panelSizes,
        v2: treeSnapshot,
        savedLayouts: savedLayoutSlots,
        activeSavedLayoutId: this.activeSavedLayoutId,
      },
    };
  }

  private applyLayoutSettingsPayload(payload: {
    panelOrder?: string[];
    panelSizes?: number[];
    v2?: unknown;
    savedLayouts?: unknown;
    activeSavedLayoutId?: unknown;
  }) {
    runInAction(() => {
      const savedLayoutState = normalizeSavedLayoutState(payload);
      if (this.appStore.settings) {
        this.appStore.settings = {
          ...this.appStore.settings,
          layout: {
            ...this.appStore.settings.layout,
            panelOrder: payload.panelOrder,
            panelSizes: payload.panelSizes,
            v2: payload.v2,
            savedLayouts: savedLayoutState.slots,
            activeSavedLayoutId: savedLayoutState.activeSavedLayoutId,
          },
        };
      }
      this.savedLayoutSlots = savedLayoutState.slots;
      this.activeSavedLayoutId = savedLayoutState.activeSavedLayoutId;
    });
  }
}
