import { readOpaqueNonBlankWellFormedString } from '@gyshell/shared'
import {
  LAYOUT_V2_SCHEMA_VERSION,
  MAX_LAYOUT_PANELS,
  MAX_LAYOUT_SPLIT_CHILDREN,
  type DropDirection,
  type LayoutNode,
  type LayoutPanelTabBinding,
  type LayoutPanelNode,
  type LayoutSplitNode,
  type LayoutTree,
  type PanelKind,
  type SplitDirection
} from './types'
import { getPanelKindMeta, isPanelKind } from './panelKindMeta'
import {
  isTabbedPanelKind,
  normalizePanelTabBinding,
  readWindowingTabId
} from './tabIdentity'

interface LegacyLayoutSnapshot {
  panelOrder?: string[]
  panelSizes?: number[]
  v2?: unknown
}

interface PanelLocation {
  path: number[]
  parentPath: number[] | null
  indexInParent: number
  node: LayoutPanelNode
}

const cloneValue = <T>(value: T): T => {
  if (typeof globalThis.structuredClone === 'function') {
    try {
      return globalThis.structuredClone(value)
    } catch {
      // Observable proxies and non-cloneable payloads can fail structuredClone.
      // Fall back to JSON cloning for layout state.
    }
  }
  return JSON.parse(JSON.stringify(value)) as T
}

export const makeLayoutId = (prefix: string): string => {
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    return `${prefix}-${globalThis.crypto.randomUUID()}`
  }
  return `${prefix}-${Math.random().toString(16).slice(2)}-${Date.now().toString(16)}`
}

export const createPanelNode = (kind: PanelKind, id?: string): LayoutPanelNode => ({
  type: 'panel',
  id: makeLayoutId('node'),
  panel: {
    id: id ?? makeLayoutId(`panel-${kind}`),
    kind
  }
})

export const normalizeSizes = (sizes: number[] | undefined, count: number): number[] => {
  if (count <= 0) return []
  if (!Array.isArray(sizes) || sizes.length !== count) {
    return Array.from({ length: count }, () => 100 / count)
  }

  const sanitized = sizes.map((size) => {
    if (!Number.isFinite(size) || size <= 0) return 0
    return size
  })
  const total = sanitized.reduce((sum, size) => sum + size, 0)
  if (total <= 0) {
    return Array.from({ length: count }, () => 100 / count)
  }
  return sanitized.map((size) => (size / total) * 100)
}

const ensureNodeShape = (node: LayoutNode | null | undefined): LayoutNode | null => {
  if (!node || typeof node !== 'object') return null
  if ((node as LayoutPanelNode).type === 'panel') {
    const panelNode = node as LayoutPanelNode
    const kind = panelNode.panel?.kind
    if (!panelNode.panel || !isPanelKind(kind)) {
      return null
    }
    if (!panelNode.panel.id) {
      panelNode.panel.id = makeLayoutId(`panel-${panelNode.panel.kind}`)
    }
    if (!panelNode.id) {
      panelNode.id = makeLayoutId('node')
    }
    return panelNode
  }

  const splitNode = node as LayoutSplitNode
  if (splitNode.type !== 'split') return null
  if (splitNode.direction !== 'horizontal' && splitNode.direction !== 'vertical') return null
  if (!splitNode.id) {
    splitNode.id = makeLayoutId('node')
  }

  const validChildren = (splitNode.children || [])
    .map((child) => ensureNodeShape(child))
    .filter((child): child is LayoutNode => !!child)

  if (validChildren.length === 0) return null
  if (validChildren.length === 1) return validChildren[0]

  splitNode.children = validChildren
  splitNode.sizes = normalizeSizes(splitNode.sizes, validChildren.length)
  return splitNode
}

const isPlainRecord = (value: unknown): value is Record<string, unknown> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false
  }
  try {
    const prototype = Object.getPrototypeOf(value)
    return prototype === Object.prototype || prototype === null
  } catch {
    return false
  }
}

const hasOnlyKeys = (
  value: Record<string, unknown>,
  allowedKeys: readonly string[]
): boolean => {
  const allowed = new Set(allowedKeys)
  return Object.keys(value).every((key) => allowed.has(key))
}

const hasOwn = (value: Record<string, unknown>, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(value, key)

const hasOwnKeys = (
  value: Record<string, unknown>,
  requiredKeys: readonly string[]
): boolean => requiredKeys.every((key) => hasOwn(value, key))

const MAX_STRICT_LAYOUT_NODES = MAX_LAYOUT_PANELS * 2 - 1

interface StrictLayoutParseState {
  nodeIds: Set<string>
  panelIds: Set<string>
  panelKindById: Map<string, PanelKind>
  panelCountByKind: Map<PanelKind, number>
  panelCount: number
  nodeCount: number
}

const parseStrictLayoutNode = (
  value: unknown,
  state: StrictLayoutParseState
): LayoutNode | null => {
  if (!isPlainRecord(value)) return null
  state.nodeCount += 1
  if (state.nodeCount > MAX_STRICT_LAYOUT_NODES) return null

  if (!hasOwnKeys(value, ['type', 'id'])) return null
  const id = readOpaqueNonBlankWellFormedString(value.id)
  if (!id || state.nodeIds.has(id)) return null
  state.nodeIds.add(id)

  if (value.type === 'panel') {
    if (
      !hasOnlyKeys(value, ['type', 'id', 'panel']) ||
      !hasOwn(value, 'panel') ||
      !isPlainRecord(value.panel)
    ) {
      return null
    }
    const panel = value.panel
    if (
      !hasOnlyKeys(panel, ['id', 'kind']) ||
      !hasOwnKeys(panel, ['id', 'kind']) ||
      !isPanelKind(panel.kind)
    ) {
      return null
    }
    const panelId = readOpaqueNonBlankWellFormedString(panel.id)
    if (!panelId || state.panelIds.has(panelId)) return null
    const panelKindCount = (state.panelCountByKind.get(panel.kind) || 0) + 1
    const maxPanelsForKind = getPanelKindMeta(panel.kind).maxPanels
    if (
      maxPanelsForKind !== undefined &&
      panelKindCount > maxPanelsForKind
    ) {
      return null
    }
    state.panelIds.add(panelId)
    state.panelKindById.set(panelId, panel.kind)
    state.panelCountByKind.set(panel.kind, panelKindCount)
    state.panelCount += 1
    if (state.panelCount > MAX_LAYOUT_PANELS) return null
    return {
      type: 'panel',
      id,
      panel: {
        id: panelId,
        kind: panel.kind
      }
    }
  }

  if (
    value.type !== 'split' ||
    !hasOnlyKeys(value, ['type', 'id', 'direction', 'children', 'sizes']) ||
    !hasOwnKeys(value, ['direction', 'children', 'sizes']) ||
    (value.direction !== 'horizontal' && value.direction !== 'vertical') ||
    !Array.isArray(value.children) ||
    value.children.length < 2 ||
    value.children.length > MAX_LAYOUT_SPLIT_CHILDREN ||
    !Array.isArray(value.sizes) ||
    value.sizes.length !== value.children.length ||
    value.sizes.some(
      (size) => typeof size !== 'number' || !Number.isFinite(size) || size < 0
    ) ||
    !(() => {
      const total = (value.sizes as number[]).reduce(
        (sum: number, size: number) => sum + size,
        0,
      )
      return Number.isFinite(total) && total > 0
    })()
  ) {
    return null
  }

  const children: LayoutNode[] = []
  for (const child of value.children) {
    const parsedChild = parseStrictLayoutNode(child, state)
    if (!parsedChild) return null
    children.push(parsedChild)
  }
  return {
    type: 'split',
    id,
    direction: value.direction,
    children,
    sizes: [...value.sizes]
  }
}

/**
 * Parses renderer-owned detached layout state without repairing malformed
 * structure. Persisted user settings retain their compatibility normalizer;
 * cross-window detached state is an untrusted ingress and must fail closed as
 * one payload.
 */
export const parseStrictLayoutTree = (raw: unknown): LayoutTree | null => {
  if (
    !isPlainRecord(raw) ||
    !hasOwnKeys(raw, ['schemaVersion', 'root']) ||
    raw.schemaVersion !== LAYOUT_V2_SCHEMA_VERSION
  ) {
    return null
  }
  if (!hasOnlyKeys(raw, ['schemaVersion', 'root', 'focusedPanelId', 'panelTabs', 'managerPanels'])) {
    return null
  }

  const state: StrictLayoutParseState = {
    nodeIds: new Set<string>(),
    panelIds: new Set<string>(),
    panelKindById: new Map<string, PanelKind>(),
    panelCountByKind: new Map<PanelKind, number>(),
    panelCount: 0,
    nodeCount: 0
  }
  const root = parseStrictLayoutNode(raw.root, state)
  if (!root || state.panelCount === 0) return null

  let focusedPanelId: string | undefined
  if (Object.prototype.hasOwnProperty.call(raw, 'focusedPanelId')) {
    focusedPanelId = readOpaqueNonBlankWellFormedString(raw.focusedPanelId)
    if (!focusedPanelId || !state.panelIds.has(focusedPanelId)) return null
  }

  let panelTabs: Record<string, LayoutPanelTabBinding> | undefined
  if (Object.prototype.hasOwnProperty.call(raw, 'panelTabs')) {
    if (!isPlainRecord(raw.panelTabs)) return null
    const nextPanelTabs = Object.create(null) as Record<
      string,
      LayoutPanelTabBinding
    >
    for (const [panelId, candidate] of Object.entries(raw.panelTabs)) {
      const kind = state.panelKindById.get(panelId)
      if (
        !kind ||
        !isTabbedPanelKind(kind) ||
        !isPlainRecord(candidate) ||
        !hasOnlyKeys(candidate, ['tabIds', 'activeTabId']) ||
        !hasOwn(candidate, 'tabIds') ||
        !Array.isArray(candidate.tabIds)
      ) {
        return null
      }
      const normalized = normalizePanelTabBinding(kind, candidate)
      if (
        !normalized ||
        candidate.tabIds.some(
          (tabId) => readWindowingTabId(kind, tabId) === undefined
        )
      ) {
        return null
      }
      if (Object.prototype.hasOwnProperty.call(candidate, 'activeTabId')) {
        const activeTabId = readWindowingTabId(kind, candidate.activeTabId)
        if (!activeTabId || !normalized.tabIds.includes(activeTabId)) {
          return null
        }
      }
      nextPanelTabs[panelId] = normalized
    }
    panelTabs = nextPanelTabs
  }

  let managerPanels: Partial<Record<PanelKind, string>> | undefined
  if (Object.prototype.hasOwnProperty.call(raw, 'managerPanels')) {
    if (!isPlainRecord(raw.managerPanels)) return null
    const nextManagerPanels: Partial<Record<PanelKind, string>> = Object.create(null)
    for (const [kind, candidate] of Object.entries(raw.managerPanels)) {
      if (!isPanelKind(kind)) return null
      const panelId = readOpaqueNonBlankWellFormedString(candidate)
      if (!panelId || state.panelKindById.get(panelId) !== kind) return null
      nextManagerPanels[kind] = panelId
    }
    managerPanels = nextManagerPanels
  }

  return {
    schemaVersion: LAYOUT_V2_SCHEMA_VERSION,
    root,
    ...(focusedPanelId ? { focusedPanelId } : {}),
    ...(panelTabs ? { panelTabs } : {}),
    ...(managerPanels ? { managerPanels } : {})
  }
}

export const parsePersistedLayoutV2 = (raw: unknown): LayoutTree | null => {
  if (!raw || typeof raw !== 'object') return null
  const payload = raw as Partial<LayoutTree>
  const root = ensureNodeShape(cloneValue(payload.root as LayoutNode))
  if (!root) return null

  const panelTabs = (() => {
    const source = payload.panelTabs
    if (!source || typeof source !== 'object') return undefined
    const panelKindById = new Map<string, PanelKind>()
    const pendingNodes: LayoutNode[] = [root]
    while (pendingNodes.length > 0) {
      const node = pendingNodes.pop()
      if (!node) continue
      if (node.type === 'panel') {
        panelKindById.set(node.panel.id, node.panel.kind)
      } else {
        pendingNodes.push(...node.children)
      }
    }

    const entries = Object.entries(source as Record<string, unknown>)
      .map(([panelId, value]) => {
        const kind = panelKindById.get(panelId)
        if (!kind) return null
        const binding = normalizePanelTabBinding(kind, value)
        return binding ? ([panelId, binding] as const) : null
      })
      .filter((entry): entry is readonly [string, LayoutPanelTabBinding] => !!entry)
    if (entries.length === 0) return undefined
    return Object.fromEntries(entries)
  })()

  const managerPanels = (() => {
    const source = payload.managerPanels
    if (!source || typeof source !== 'object') return undefined
    const manager = source as Partial<Record<PanelKind, unknown>>
    const next: Partial<Record<PanelKind, string>> = {}
    if (typeof manager.chat === 'string' && manager.chat.length > 0) {
      next.chat = manager.chat
    }
    if (typeof manager.terminal === 'string' && manager.terminal.length > 0) {
      next.terminal = manager.terminal
    }
    if (typeof manager.filesystem === 'string' && manager.filesystem.length > 0) {
      next.filesystem = manager.filesystem
    }
    if (typeof manager.listPanel === 'string' && manager.listPanel.length > 0) {
      next.listPanel = manager.listPanel
    }
    return Object.keys(next).length > 0 ? next : undefined
  })()

  return {
    schemaVersion: LAYOUT_V2_SCHEMA_VERSION,
    root,
    focusedPanelId: typeof payload.focusedPanelId === 'string' ? payload.focusedPanelId : undefined,
    ...(panelTabs ? { panelTabs } : {}),
    ...(managerPanels ? { managerPanels } : {})
  }
}

const DEFAULT_PANEL_ORDER: readonly PanelKind[] = ['listPanel', 'chat', 'terminal']
const DEFAULT_PANEL_SIZES = [18, 41, 41]

const normalizeLegacyPanelKind = (panelName: string): PanelKind => {
  if (panelName === 'chat') return 'chat'
  if (panelName === 'filesystem') return 'filesystem'
  if (panelName === 'fileEditor') return 'fileEditor'
  if (panelName === 'listPanel') return 'listPanel'
  return 'terminal'
}

const createLegacyRoot = (order: string[] | undefined, sizes: number[] | undefined): LayoutNode => {
  const hasExplicitOrder = Array.isArray(order) && order.length > 0
  const panelOrder = hasExplicitOrder ? order!.map(normalizeLegacyPanelKind) : DEFAULT_PANEL_ORDER
  const nodes = panelOrder.map((panelName) => {
    return createPanelNode(panelName)
  })

  if (nodes.length === 1) {
    return nodes[0]
  }

  return {
    type: 'split',
    id: makeLayoutId('node'),
    direction: 'horizontal',
    children: nodes,
    sizes: normalizeSizes(hasExplicitOrder ? sizes : DEFAULT_PANEL_SIZES, nodes.length)
  }
}

export const buildLayoutTree = (layout: LegacyLayoutSnapshot | undefined): LayoutTree => {
  const parsedV2 = parsePersistedLayoutV2(layout?.v2)
  if (parsedV2) {
    return parsedV2
  }

  return {
    schemaVersion: LAYOUT_V2_SCHEMA_VERSION,
    root: createLegacyRoot(layout?.panelOrder, layout?.panelSizes),
    focusedPanelId: undefined
  }
}

const walkPanels = (node: LayoutNode, collector: LayoutPanelNode[]): void => {
  if (node.type === 'panel') {
    collector.push(node)
    return
  }
  node.children.forEach((child) => walkPanels(child, collector))
}

export const listPanels = (tree: LayoutTree): LayoutPanelNode[] => {
  const panels: LayoutPanelNode[] = []
  walkPanels(tree.root, panels)
  return panels
}

export const getPanelCount = (tree: LayoutTree): number => listPanels(tree).length

const findPanelLocation = (node: LayoutNode, panelId: string, path: number[] = []): PanelLocation | null => {
  if (node.type === 'panel') {
    if (node.panel.id !== panelId) return null
    if (path.length === 0) {
      return {
        path,
        parentPath: null,
        indexInParent: -1,
        node
      }
    }
    return {
      path,
      parentPath: path.slice(0, -1),
      indexInParent: path[path.length - 1],
      node
    }
  }

  for (let index = 0; index < node.children.length; index += 1) {
    const next = findPanelLocation(node.children[index], panelId, [...path, index])
    if (next) return next
  }
  return null
}

const findSplitPathById = (node: LayoutNode, splitId: string, path: number[] = []): number[] | null => {
  if (node.type === 'split') {
    if (node.id === splitId) return path
    for (let index = 0; index < node.children.length; index += 1) {
      const childPath = findSplitPathById(node.children[index], splitId, [...path, index])
      if (childPath) return childPath
    }
  }
  return null
}

const getNodeAtPath = (root: LayoutNode, path: number[]): LayoutNode | null => {
  let current: LayoutNode = root
  for (const index of path) {
    if (current.type !== 'split') return null
    if (index < 0 || index >= current.children.length) return null
    current = current.children[index]
  }
  return current
}

const replaceNodeAtPath = (root: LayoutNode, path: number[], replacement: LayoutNode): LayoutNode => {
  if (path.length === 0) {
    return replacement
  }

  const parentPath = path.slice(0, -1)
  const index = path[path.length - 1]
  const parent = getNodeAtPath(root, parentPath)
  if (!parent || parent.type !== 'split') {
    return root
  }
  parent.children[index] = replacement
  return root
}

const rebalanceTreeNode = (node: LayoutNode | null): LayoutNode | null => {
  if (!node) return null
  if (node.type === 'panel') return node

  const children = node.children
    .map((child) => rebalanceTreeNode(child))
    .filter((child): child is LayoutNode => !!child)

  if (children.length === 0) return null
  if (children.length === 1) return children[0]

  node.children = children
  node.sizes = normalizeSizes(node.sizes, children.length)
  return node
}

const detachPanelNode = (root: LayoutNode, panelId: string): { root: LayoutNode; detached: LayoutPanelNode | null } => {
  const location = findPanelLocation(root, panelId)
  if (!location || !location.parentPath) {
    return { root, detached: null }
  }

  const parent = getNodeAtPath(root, location.parentPath)
  if (!parent || parent.type !== 'split') {
    return { root, detached: null }
  }

  const [removed] = parent.children.splice(location.indexInParent, 1)
  parent.sizes.splice(location.indexInParent, 1)
  parent.sizes = normalizeSizes(parent.sizes, parent.children.length)

  const balanced = rebalanceTreeNode(root)
  return {
    root: balanced || root,
    detached: removed && removed.type === 'panel' ? removed : null
  }
}

const insertRelativeToPanel = (
  root: LayoutNode,
  targetPanelId: string,
  nodeToInsert: LayoutPanelNode,
  direction: SplitDirection,
  position: 'before' | 'after'
): LayoutNode => {
  const location = findPanelLocation(root, targetPanelId)
  if (!location) return root

  const parent = location.parentPath ? getNodeAtPath(root, location.parentPath) : null
  if (parent && parent.type === 'split' && parent.direction === direction) {
    if (parent.children.length >= MAX_LAYOUT_SPLIT_CHILDREN) {
      const targetNode = parent.children[location.indexInParent]
      if (targetNode?.type !== 'panel') {
        return root
      }
      const wrappedSplit: LayoutSplitNode = {
        type: 'split',
        id: makeLayoutId('node'),
        direction,
        children: position === 'before' ? [nodeToInsert, targetNode] : [targetNode, nodeToInsert],
        sizes: [50, 50]
      }
      parent.children[location.indexInParent] = wrappedSplit
      parent.sizes = normalizeSizes(parent.sizes, parent.children.length)
      return root
    }

    const insertIndex = position === 'before' ? location.indexInParent : location.indexInParent + 1
    const targetSize = parent.sizes[location.indexInParent] ?? 100 / Math.max(1, parent.children.length)
    const insertedSize = targetSize / 2

    parent.children.splice(insertIndex, 0, nodeToInsert)
    parent.sizes[location.indexInParent] = targetSize - insertedSize
    parent.sizes.splice(insertIndex, 0, insertedSize)
    parent.sizes = normalizeSizes(parent.sizes, parent.children.length)
    return root
  }

  const targetNode = getNodeAtPath(root, location.path)
  if (!targetNode || targetNode.type !== 'panel') {
    return root
  }

  const wrappedSplit: LayoutSplitNode = {
    type: 'split',
    id: makeLayoutId('node'),
    direction,
    children: position === 'before' ? [nodeToInsert, targetNode] : [targetNode, nodeToInsert],
    sizes: [50, 50]
  }

  return replaceNodeAtPath(root, location.path, wrappedSplit)
}

const movePanelToTarget = (
  root: LayoutNode,
  panelId: string,
  targetPanelId: string,
  direction: SplitDirection,
  position: 'before' | 'after'
): LayoutNode => {
  const detachResult = detachPanelNode(root, panelId)
  if (!detachResult.detached) {
    return root
  }
  return insertRelativeToPanel(detachResult.root, targetPanelId, detachResult.detached, direction, position)
}

export const setSplitSizes = (tree: LayoutTree, splitId: string, sizes: number[]): LayoutTree => {
  const next = cloneValue(tree)
  const splitPath = findSplitPathById(next.root, splitId)
  if (!splitPath) return tree

  const node = getNodeAtPath(next.root, splitPath)
  if (!node || node.type !== 'split') return tree

  node.sizes = normalizeSizes(sizes, node.children.length)
  return {
    ...next,
    root: next.root
  }
}

export const splitPanel = (
  tree: LayoutTree,
  targetPanelId: string,
  kind: PanelKind,
  direction: SplitDirection,
  position: 'before' | 'after'
): LayoutTree => {
  const panelId = makeLayoutId(`panel-${kind}`)
  return splitPanelWithPanelId(tree, targetPanelId, { kind, panelId }, direction, position)
}

export const splitPanelWithPanelId = (
  tree: LayoutTree,
  targetPanelId: string,
  panel: { kind: PanelKind; panelId: string },
  direction: SplitDirection,
  position: 'before' | 'after'
): LayoutTree => {
  if (getPanelCount(tree) >= MAX_LAYOUT_PANELS) {
    return tree
  }

  const next = cloneValue(tree)
  const newPanelNode = createPanelNode(panel.kind, panel.panelId)
  next.root = insertRelativeToPanel(next.root, targetPanelId, newPanelNode, direction, position)
  next.root = rebalanceTreeNode(next.root) || next.root
  next.focusedPanelId = newPanelNode.panel.id
  next.schemaVersion = LAYOUT_V2_SCHEMA_VERSION
  return next
}

export const removePanel = (tree: LayoutTree, panelId: string): LayoutTree => {
  if (getPanelCount(tree) <= 1) return tree

  const next = cloneValue(tree)
  const detached = detachPanelNode(next.root, panelId)
  if (!detached.detached) {
    return tree
  }

  next.root = rebalanceTreeNode(detached.root) || detached.root
  if (next.focusedPanelId === panelId) {
    const firstPanel = listPanels(next)[0]
    next.focusedPanelId = firstPanel?.panel.id
  }
  next.schemaVersion = LAYOUT_V2_SCHEMA_VERSION
  return next
}

export const swapPanels = (tree: LayoutTree, panelAId: string, panelBId: string): LayoutTree => {
  if (panelAId === panelBId) return tree

  const next = cloneValue(tree)
  const nodeA = findPanelLocation(next.root, panelAId)?.node
  const nodeB = findPanelLocation(next.root, panelBId)?.node
  if (!nodeA || !nodeB) {
    return tree
  }

  const panelA = nodeA.panel
  nodeA.panel = nodeB.panel
  nodeB.panel = panelA
  next.focusedPanelId = panelAId
  next.schemaVersion = LAYOUT_V2_SCHEMA_VERSION
  return next
}

export const movePanel = (tree: LayoutTree, panelId: string, targetPanelId: string, direction: DropDirection): LayoutTree => {
  if (panelId === targetPanelId) return tree

  if (direction === 'center') {
    return swapPanels(tree, panelId, targetPanelId)
  }

  const next = cloneValue(tree)
  if (direction === 'left') {
    next.root = movePanelToTarget(next.root, panelId, targetPanelId, 'horizontal', 'before')
  } else if (direction === 'right') {
    next.root = movePanelToTarget(next.root, panelId, targetPanelId, 'horizontal', 'after')
  } else if (direction === 'top') {
    next.root = movePanelToTarget(next.root, panelId, targetPanelId, 'vertical', 'before')
  } else if (direction === 'bottom') {
    next.root = movePanelToTarget(next.root, panelId, targetPanelId, 'vertical', 'after')
  }

  next.root = rebalanceTreeNode(next.root) || next.root
  next.focusedPanelId = panelId
  next.schemaVersion = LAYOUT_V2_SCHEMA_VERSION
  return next
}

export const getFirstPanelId = (tree: LayoutTree): string | null => {
  const panels = listPanels(tree)
  return panels[0]?.panel.id || null
}

export const getPanelKinds = (tree: LayoutTree): PanelKind[] => listPanels(tree).map((leaf) => leaf.panel.kind)

export const deriveLegacyLayoutSnapshot = (tree: LayoutTree): { panelOrder: string[]; panelSizes: number[] } => {
  const leaves = listPanels(tree)
  const panelOrder = leaves.slice(0, 2).map((leaf) => leaf.panel.kind)

  const panelSizes = (() => {
    if (tree.root.type !== 'split' || tree.root.direction !== 'horizontal') {
      return [50, 50]
    }

    const children = tree.root.children.slice(0, 2)
    const sizes = normalizeSizes(tree.root.sizes, tree.root.children.length)
    if (children.length < 2) {
      return [50, 50]
    }
    const first = sizes[0] ?? 50
    const second = sizes[1] ?? 50
    return normalizeSizes([first, second], 2)
  })()

  if (panelOrder.length < 2) {
    panelOrder.push(panelOrder[0] === 'chat' ? 'terminal' : 'chat')
  }

  return {
    panelOrder,
    panelSizes
  }
}
