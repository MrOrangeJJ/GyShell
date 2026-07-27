import { LayoutStore } from './LayoutStore'
import {
  computeLayoutGeometry,
  createSavedLayoutSnapshot,
  getPanelMinHeightPx,
  getSavedLayoutSlotId,
  listPanels,
  validateLayoutTree,
  type LayoutTree
} from '../layout'

const assertCondition = (condition: unknown, message: string): void => {
  if (!condition) {
    throw new Error(message)
  }
}

const assertEqual = <T>(actual: T, expected: T, message: string): void => {
  if (actual !== expected) {
    throw new Error(`${message}. expected=${String(expected)} actual=${String(actual)}`)
  }
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms)
  })

interface SettingsSetPayload {
  layout?: {
    panelOrder?: string[]
    panelSizes?: number[]
    v2?: unknown
    savedLayouts?: unknown
    activeSavedLayoutId?: string | null
  }
}

interface SettingsSetSpy {
  calls: SettingsSetPayload[]
  syncCalls?: SettingsSetPayload[]
}

const installWindowMock = (spy: SettingsSetSpy): void => {
  const syncCalls = spy.syncCalls ?? []
  spy.syncCalls = syncCalls
  ;(globalThis as unknown as { window: unknown }).window = {
    gyshell: {
      settings: {
        set: async (payload: SettingsSetPayload) => {
          spy.calls.push(payload)
        },
        setSync: (payload: SettingsSetPayload) => {
          syncCalls.push(payload)
          spy.calls.push(payload)
        }
      }
    }
  }
}

const createStore = (options?: {
  settings?: { layout?: unknown }
  terminalIds?: string[]
  chatIds?: string[]
  terminalInventoryHydrated?: boolean
  chatInventoryHydrated?: boolean
  activeTerminalId?: string | null
  shouldPersistLayout?: boolean
}): LayoutStore => {
  const terminalIds = options?.terminalIds || ['term-1']
  const chatIds = options?.chatIds || ['chat-1']
  const activeTerminalId = options?.activeTerminalId === undefined ? terminalIds[0] || null : options.activeTerminalId
  const appStore = {
    settings: options?.settings ? (options.settings as any) : null,
    terminalTabs: terminalIds.map((id) => ({
      id,
      title: id,
      config: {
        type: 'local',
        id,
        title: id,
        cols: 80,
        rows: 24
      }
    })),
    fileSystemTabs: [],
    monitorTabs: [],
    terminalTabsHydrated: options?.terminalInventoryHydrated ?? true,
    activeTerminalId,
    setActiveTerminal(id: string) {
      this.activeTerminalId = id
    },
    shouldPersistLayout() {
      return options?.shouldPersistLayout !== false
    },
    onPanelRemoved(_kind: string) {},
    chat: {
      sessionInventoryHydrated: options?.chatInventoryHydrated ?? true,
      sessions: chatIds.map((id) => ({
        id,
        title: id,
        messagesById: new Map(),
        messageIds: [],
        isThinking: false,
        isSessionBusy: false,
        lockedProfileId: null
      })),
      activeSessionId: chatIds[0] || null,
      setActiveSession(id: string) {
        this.activeSessionId = id
      }
    }
  }
  return new LayoutStore(appStore as any)
}

const runCase = async (name: string, fn: () => Promise<void> | void): Promise<void> => {
  await fn()
  console.log(`PASS ${name}`)
}

const countTerminalPanelsInSlot = (store: LayoutStore, slotId: string): number => {
  const slot = store.savedLayoutSlots.find((entry) => entry.id === slotId)
  if (!slot) return 0
  return listPanels(slot.snapshot.v2).filter((node) => node.panel.kind === 'terminal').length
}

const findSavedPanelActiveTab = (store: LayoutStore, slotId: string, panelId: string): string | null => {
  const slot = store.savedLayoutSlots.find((entry) => entry.id === slotId)
  if (!slot) return null
  return slot.snapshot.v2.panelTabs?.[panelId]?.activeTabId || null
}

const run = async (): Promise<void> => {
  await runCase('bootstrap loads v2 tree, sets focus, and assigns chat bindings', async () => {
    const persistedTree: LayoutTree = {
      schemaVersion: 2,
      root: {
        type: 'panel',
        id: 'node-chat',
        panel: {
          id: 'panel-chat',
          kind: 'chat'
        }
      }
    }
    const store = createStore({
      settings: {
        layout: {
          v2: persistedTree
        }
      },
      chatIds: ['chat-a', 'chat-b'],
      terminalIds: ['term-a']
    })
    store.bootstrap()

    assertEqual(store.panelCount, 1, 'bootstrap should restore panel count')
    assertEqual(store.tree.root.type, 'panel', 'bootstrap should preserve persisted root')
    assertEqual(store.tree.focusedPanelId, 'panel-chat', 'bootstrap should set focused panel when missing')
    assertCondition(
      JSON.stringify(store.getPanelTabIds('panel-chat')) === JSON.stringify(['chat-a', 'chat-b']),
      'chat tabs should be assigned to the only chat panel on bootstrap'
    )
  })

  await runCase('bootstrap does not prune terminal panels before terminal inventory is hydrated', async () => {
    const persistedTree: LayoutTree = {
      schemaVersion: 2,
      root: {
        type: 'split',
        id: 'root',
        direction: 'horizontal',
        children: [
          {
            type: 'panel',
            id: 'node-chat',
            panel: { id: 'panel-chat', kind: 'chat' }
          },
          {
            type: 'split',
            id: 'node-term-root',
            direction: 'vertical',
            children: [
              {
                type: 'panel',
                id: 'node-term-a',
                panel: { id: 'panel-term-a', kind: 'terminal' }
              },
              {
                type: 'panel',
                id: 'node-term-b',
                panel: { id: 'panel-term-b', kind: 'terminal' }
              }
            ],
            sizes: [50, 50]
          }
        ],
        sizes: [35, 65]
      },
      managerPanels: {
        chat: 'panel-chat',
        terminal: 'panel-term-a'
      },
      panelTabs: {
        'panel-chat': { tabIds: ['chat-1'], activeTabId: 'chat-1' },
        'panel-term-a': { tabIds: ['term-a'], activeTabId: 'term-a' },
        'panel-term-b': { tabIds: ['term-b'], activeTabId: 'term-b' }
      }
    }

    const store = createStore({
      settings: {
        layout: {
          v2: persistedTree
        }
      },
      terminalIds: [],
      chatIds: ['chat-1'],
      terminalInventoryHydrated: false
    })

    store.bootstrap()
    const terminalPanels = store.panelNodes.filter((node) => node.panel.kind === 'terminal')
    assertEqual(terminalPanels.length, 2, 'terminal panels must be preserved before inventory hydration')
    assertEqual(
      JSON.stringify(store.getPanelTabIds('panel-term-b')),
      JSON.stringify(['term-b']),
      'persisted tab bindings should be preserved before inventory hydration'
    )

    const internal = store as any
    internal.appStore.terminalTabs = [{ id: 'term-a' }, { id: 'term-b' }]
    internal.appStore.terminalTabsHydrated = true
    store.syncPanelBindings({ persist: false })
    const hydratedTerminalPanels = store.panelNodes.filter((node) => node.panel.kind === 'terminal')
    assertEqual(hydratedTerminalPanels.length, 2, 'terminal panels should remain after hydration sync')
  })

  await runCase('missing restored terminal tabs keep placeholder panel when pinned', async () => {
    const persistedTree: LayoutTree = {
      schemaVersion: 2,
      root: {
        type: 'split',
        id: 'root',
        direction: 'horizontal',
        children: [
          {
            type: 'panel',
            id: 'node-chat',
            panel: { id: 'panel-chat', kind: 'chat' }
          },
          {
            type: 'panel',
            id: 'node-term-a',
            panel: { id: 'panel-term-a', kind: 'terminal' }
          },
          {
            type: 'panel',
            id: 'node-term-b',
            panel: { id: 'panel-term-b', kind: 'terminal' }
          }
        ],
        sizes: [34, 33, 33]
      },
      panelTabs: {
        'panel-chat': { tabIds: ['chat-1'], activeTabId: 'chat-1' },
        'panel-term-a': { tabIds: ['term-a'], activeTabId: 'term-a' },
        'panel-term-b': {
          tabIds: ['term-missing'],
          activeTabId: 'term-missing'
        }
      }
    }

    const store = createStore({
      settings: {
        layout: {
          v2: persistedTree
        }
      },
      terminalIds: [],
      chatIds: ['chat-1'],
      terminalInventoryHydrated: false
    })

    store.bootstrap()
    const unresolvedPanelIds = store.getPanelsWithMissingTabBindings('terminal', ['term-a'])
    assertEqual(
      JSON.stringify(unresolvedPanelIds),
      JSON.stringify(['panel-term-b']),
      'missing terminal ids should map to their original panel'
    )
    store.pinPanelsAsRestorePlaceholder(unresolvedPanelIds)

    const internal = store as any
    internal.appStore.terminalTabs = [{ id: 'term-a' }]
    internal.appStore.activeTerminalId = 'term-a'
    internal.appStore.terminalTabsHydrated = true
    store.syncPanelBindings({ persist: false })

    const terminalPanels = store.panelNodes.filter((node) => node.panel.kind === 'terminal')
    assertEqual(terminalPanels.length, 2, 'pinned placeholder panel should not be auto-pruned')
    assertEqual(
      JSON.stringify(store.getPanelTabIds('panel-term-b')),
      JSON.stringify([]),
      'placeholder panel should become empty after unresolved tab ids are removed'
    )
  })

  await runCase('syncPanelBindings aligns panel active tab with global active terminal', async () => {
    const store = createStore({
      terminalIds: ['term-a', 'term-b'],
      activeTerminalId: 'term-b',
      terminalInventoryHydrated: true
    })
    store.bootstrap()

    const primaryPanelId = store.getPrimaryPanelId('terminal')
    assertCondition(Boolean(primaryPanelId), 'terminal primary panel should exist')
    assertEqual(
      store.getPanelActiveTabId(primaryPanelId!),
      'term-b',
      'primary panel active tab should align to global active terminal'
    )
  })

  await runCase('splitPanel keeps newly created empty panel instead of pruning immediately', async () => {
    const store = createStore({
      terminalIds: ['term-a'],
      chatIds: ['chat-a'],
      terminalInventoryHydrated: true
    })
    store.bootstrap()

    const terminalPrimaryId = store.getPrimaryPanelId('terminal')
    assertCondition(Boolean(terminalPrimaryId), 'terminal primary panel should exist before split')
    store.splitPanel(terminalPrimaryId!, 'terminal', 'horizontal', 'after')

    const terminalPanels = store.panelNodes.filter((node) => node.panel.kind === 'terminal')
    assertEqual(terminalPanels.length, 2, 'split should retain two terminal panels')
    assertEqual(store.panelCount, 4, 'split should increase total panel count including the list panel')

    const newPanelId = store.tree.focusedPanelId
    assertCondition(Boolean(newPanelId), 'new split panel should become focused')
    assertEqual(
      store.getPanelTabIds(newPanelId!).length,
      0,
      'new split panel can be empty without being auto-pruned in same update'
    )
  })

  await runCase('splitPanel rejects projected layouts that violate minimum panel sizes', async () => {
    const store = createStore({
      terminalIds: ['term-a'],
      chatIds: ['chat-a'],
      terminalInventoryHydrated: true
    })
    store.bootstrap()
    store.setViewport(620, 700)

    const terminalPrimaryId = store.getPrimaryPanelId('terminal')
    assertCondition(Boolean(terminalPrimaryId), 'terminal primary panel should exist before split')
    assertEqual(
      store.canSplitPanel(terminalPrimaryId!, 'terminal', 'horizontal', 'after'),
      false,
      'horizontal terminal split should be rejected when it would undersize both panels'
    )

    store.splitPanel(terminalPrimaryId!, 'terminal', 'horizontal', 'after')

    const terminalPanels = store.panelNodes.filter((node) => node.panel.kind === 'terminal')
    assertEqual(terminalPanels.length, 1, 'rejected split should not create a second terminal panel')
    assertEqual(store.panelCount, 3, 'layout should remain unchanged after rejected split')
  })

  await runCase('file editor special panel stays without tabs and remains singleton', async () => {
    const store = createStore({
      terminalIds: ['term-a'],
      chatIds: ['chat-a'],
      terminalInventoryHydrated: true
    })
    store.bootstrap()
    store.setViewport(1400, 900)

    const terminalPrimaryId = store.getPrimaryPanelId('terminal')
    assertCondition(Boolean(terminalPrimaryId), 'terminal primary panel should exist before creating file editor panel')
    store.splitPanel(terminalPrimaryId!, 'fileEditor', 'horizontal', 'after')

    let fileEditorPanels = store.panelNodes.filter((node) => node.panel.kind === 'fileEditor')
    assertEqual(fileEditorPanels.length, 1, 'file editor panel should be created from split')
    assertEqual(
      store.getPanelTabIds(fileEditorPanels[0].panel.id).length,
      0,
      'file editor panel should not maintain tab bindings'
    )

    store.splitPanel(fileEditorPanels[0].panel.id, 'fileEditor', 'horizontal', 'after')
    fileEditorPanels = store.panelNodes.filter((node) => node.panel.kind === 'fileEditor')
    assertEqual(
      fileEditorPanels.length,
      1,
      'file editor panel should remain singleton after repeated creation attempts'
    )
  })

  await runCase('chat bindings are preserved while chat inventory is not hydrated', async () => {
    const persistedTree: LayoutTree = {
      schemaVersion: 2,
      root: {
        type: 'split',
        id: 'root-chat',
        direction: 'horizontal',
        children: [
          {
            type: 'panel',
            id: 'node-chat-a',
            panel: { id: 'panel-chat-a', kind: 'chat' }
          },
          {
            type: 'panel',
            id: 'node-chat-b',
            panel: { id: 'panel-chat-b', kind: 'chat' }
          },
          {
            type: 'panel',
            id: 'node-terminal',
            panel: { id: 'panel-terminal', kind: 'terminal' }
          }
        ],
        sizes: [33, 33, 34]
      },
      managerPanels: {
        chat: 'panel-chat-a',
        terminal: 'panel-terminal'
      },
      panelTabs: {
        'panel-chat-a': { tabIds: ['old-chat-1'], activeTabId: 'old-chat-1' },
        'panel-chat-b': { tabIds: ['old-chat-2'], activeTabId: 'old-chat-2' },
        'panel-terminal': { tabIds: ['term-a'], activeTabId: 'term-a' }
      }
    }

    const store = createStore({
      settings: { layout: { v2: persistedTree } },
      terminalIds: ['term-a'],
      chatIds: ['new-default-chat'],
      terminalInventoryHydrated: true,
      chatInventoryHydrated: false
    })
    store.bootstrap()

    const chatPanelsBeforeHydration = store.panelNodes.filter((node) => node.panel.kind === 'chat')
    assertEqual(chatPanelsBeforeHydration.length, 2, 'chat panels must not be pruned before chat inventory hydration')
    assertEqual(
      JSON.stringify(store.getPanelTabIds('panel-chat-b')),
      JSON.stringify(['old-chat-2']),
      'persisted chat tab bindings should stay intact before hydration'
    )

    const internal = store as any
    internal.appStore.chat.sessions = [
      {
        id: 'old-chat-1',
        title: 'old-chat-1',
        messagesById: new Map(),
        messageIds: [],
        isThinking: false,
        isSessionBusy: false,
        lockedProfileId: null
      },
      {
        id: 'old-chat-2',
        title: 'old-chat-2',
        messagesById: new Map(),
        messageIds: [],
        isThinking: false,
        isSessionBusy: false,
        lockedProfileId: null
      }
    ]
    internal.appStore.chat.activeSessionId = 'old-chat-1'
    internal.appStore.chat.sessionInventoryHydrated = true
    store.syncPanelBindings({ persist: false })

    const chatPanelsAfterHydration = store.panelNodes.filter((node) => node.panel.kind === 'chat')
    assertEqual(chatPanelsAfterHydration.length, 2, 'hydrated inventory should keep the two persisted chat panels')
    assertEqual(
      store.getPanelActiveTabId('panel-chat-a'),
      'old-chat-1',
      'chat panel active tab should align after hydration'
    )
  })

  await runCase('splitPanel persists v2 tree and legacy projection', async () => {
    const spy: SettingsSetSpy = { calls: [] }
    installWindowMock(spy)

    const store = createStore()
    store.bootstrap()
    store.setViewport(1440, 900)
    const sourcePanelId = store.panelNodes[0]?.panel.id
    assertCondition(Boolean(sourcePanelId), 'source panel should exist')

    store.splitPanel(sourcePanelId!, 'terminal', 'horizontal', 'after')
    await sleep(220)

    assertCondition(spy.calls.length > 0, 'settings.set should be called after split')
    const lastPayload = spy.calls[spy.calls.length - 1]
    assertCondition(Boolean(lastPayload.layout?.v2), 'persisted payload should contain layout.v2')
    assertCondition(Array.isArray(lastPayload.layout?.panelOrder), 'persisted payload should include legacy panelOrder')
    assertCondition(Array.isArray(lastPayload.layout?.panelSizes), 'persisted payload should include legacy panelSizes')
  })

  await runCase('flushPendingSaveSync immediately persists pending layout changes', async () => {
    const spy: SettingsSetSpy = { calls: [], syncCalls: [] }
    installWindowMock(spy)

    const store = createStore()
    store.bootstrap()
    store.setViewport(1440, 900)
    const sourcePanelId = store.panelNodes[0]?.panel.id
    assertCondition(Boolean(sourcePanelId), 'source panel should exist')

    store.splitPanel(sourcePanelId!, 'terminal', 'horizontal', 'after')
    store.flushPendingSaveSync()

    assertEqual(spy.syncCalls?.length || 0, 1, 'sync settings.set should be used for unload flush')
    const flushedPayload = spy.syncCalls?.[0]
    assertCondition(Boolean(flushedPayload?.layout?.v2), 'flushed payload should contain layout.v2')

    await sleep(220)
    assertEqual(spy.syncCalls?.length || 0, 1, 'flush should clear the pending debounce timer')
    assertEqual(spy.calls.length, 1, 'pending async save should not run after sync flush')
  })

  await runCase('saveCurrentLayoutSlot persists current layout and caps saved slots at three', async () => {
    const spy: SettingsSetSpy = { calls: [] }
    installWindowMock(spy)

    const store = createStore({
      terminalIds: ['term-a', 'term-b'],
      chatIds: ['chat-a']
    })
    store.bootstrap()
    store.setViewport(1440, 900)

    const first = await store.saveCurrentLayoutSlot()
    const second = await store.saveCurrentLayoutSlot()
    const third = await store.saveCurrentLayoutSlot()
    const fourth = await store.saveCurrentLayoutSlot()

    assertEqual(first?.slotNumber, 1, 'first saved layout should use slot 1')
    assertEqual(second?.slotNumber, 2, 'second saved layout should use slot 2')
    assertEqual(third?.slotNumber, 3, 'third saved layout should use slot 3')
    assertEqual(fourth, null, 'fourth saved layout should be rejected')
    assertEqual(store.savedLayoutSlots.length, 3, 'store should expose exactly three saved slots')
    assertEqual(store.canSaveCurrentLayoutSlot, false, 'plus affordance should hide after three slots')

    const lastPayload = spy.calls[spy.calls.length - 1]
    assertEqual(lastPayload.layout?.activeSavedLayoutId, getSavedLayoutSlotId(3), 'latest saved slot should be active')
    assertEqual(
      Array.isArray(lastPayload.layout?.savedLayouts) ? lastPayload.layout?.savedLayouts.length : 0,
      3,
      'persisted payload should include all saved slots'
    )
  })

  await runCase('stale async layout save completion does not restore older saved layout payload', async () => {
    const spy: SettingsSetSpy = { calls: [] }
    const pendingSaves: Array<() => void> = []
    ;(globalThis as unknown as { window: unknown }).window = {
      gyshell: {
        settings: {
          set: async (payload: SettingsSetPayload) => {
            spy.calls.push(payload)
            await new Promise<void>((resolve) => {
              pendingSaves.push(resolve)
            })
          }
        }
      }
    }

    const store = createStore({
      terminalIds: ['term-a', 'term-b'],
      chatIds: ['chat-a']
    })
    store.bootstrap()
    store.setViewport(1440, 900)

    const firstSave = store.saveCurrentLayoutSlot()
    const secondSave = store.saveCurrentLayoutSlot()
    assertEqual(pendingSaves.length, 2, 'two async layout saves should be in flight')

    pendingSaves[1]()
    const secondSlot = await secondSave
    assertEqual(secondSlot?.id, getSavedLayoutSlotId(2), 'second save should create slot 2')
    assertEqual(store.savedLayoutSlots.length, 2, 'newer payload should expose both saved slots')
    assertEqual(store.activeSavedLayoutId, getSavedLayoutSlotId(2), 'newer payload should be active')

    pendingSaves[0]()
    const firstSlot = await firstSave
    assertEqual(firstSlot?.id, getSavedLayoutSlotId(1), 'first save should still resolve with slot 1')
    assertEqual(store.savedLayoutSlots.length, 2, 'stale payload should not remove newer saved slots')
    assertEqual(store.activeSavedLayoutId, getSavedLayoutSlotId(2), 'stale payload should not replace active slot')
  })

  await runCase('non-persistent layouts expose no saved layout slot controls', async () => {
    const tree: LayoutTree = {
      schemaVersion: 2,
      root: {
        type: 'panel',
        id: 'node-terminal',
        panel: {
          id: 'panel-terminal',
          kind: 'terminal'
        }
      },
      focusedPanelId: 'panel-terminal'
    }
    const store = createStore({
      shouldPersistLayout: false,
      settings: {
        layout: {
          v2: tree,
          savedLayouts: [
            {
              slotNumber: 1,
              createdAt: 1,
              updatedAt: 1,
              snapshot: createSavedLayoutSnapshot(tree)
            }
          ],
          activeSavedLayoutId: getSavedLayoutSlotId(1)
        }
      }
    })
    store.bootstrap()

    assertEqual(store.savedLayoutSlots.length, 1, 'persisted saved slot should still normalize into store state')
    assertEqual(store.canUseSavedLayoutSlots, false, 'non-persistent layout should hide saved slot controls')
    assertEqual(store.canSaveCurrentLayoutSlot, false, 'non-persistent layout should hide the save affordance')
    assertEqual(await store.saveCurrentLayoutSlot(), null, 'non-persistent layout should not save a new slot')
    assertEqual(
      await store.applySavedLayoutSlot(getSavedLayoutSlotId(1)),
      false,
      'non-persistent layout should not apply saved slots'
    )
  })

  await runCase('user layout mutation auto-updates the active saved layout slot', async () => {
    const spy: SettingsSetSpy = { calls: [] }
    installWindowMock(spy)

    const store = createStore()
    store.bootstrap()
    store.setViewport(1440, 900)
    const saved = await store.saveCurrentLayoutSlot()
    assertCondition(Boolean(saved), 'saved slot should be created')
    assertEqual(store.activeSavedLayoutId, saved?.id || null, 'newly saved layout should be active')

    const terminalPanelId = store.getPrimaryPanelId('terminal')
    assertCondition(Boolean(terminalPanelId), 'terminal panel should exist')
    store.splitPanel(terminalPanelId!, 'terminal', 'horizontal', 'after')
    assertEqual(store.activeSavedLayoutId, saved!.id, 'mutating layout should keep the active saved layout marker')
    assertEqual(
      countTerminalPanelsInSlot(store, saved!.id),
      2,
      'active saved layout snapshot should update immediately after mutation'
    )

    await sleep(220)
    const lastPayload = spy.calls[spy.calls.length - 1]
    const persistedSlots = Array.isArray(lastPayload.layout?.savedLayouts) ? (lastPayload.layout?.savedLayouts as any[]) : []
    const persistedSlot = persistedSlots.find((slot) => slot.id === saved!.id)
    assertCondition(Boolean(persistedSlot?.snapshot?.v2), 'persisted active saved layout slot should exist')
    assertEqual(lastPayload.layout?.activeSavedLayoutId, saved!.id, 'persisted active saved layout should be preserved')
    assertEqual(
      listPanels(persistedSlot!.snapshot.v2 as LayoutTree).filter((node) => node.panel.kind === 'terminal').length,
      2,
      'persisted active saved layout snapshot should include the mutation'
    )
  })

  await runCase(
    'applying a saved layout first saves the previously active dynamic slot',
    async () => {
      const spy: SettingsSetSpy = { calls: [] }
      installWindowMock(spy)

      const store = createStore({
        terminalIds: ['term-a', 'term-b'],
        chatIds: ['chat-a'],
        activeTerminalId: 'term-b'
      })
      store.bootstrap()
      store.setViewport(1600, 900)

      const sourcePanelId = store.getPrimaryPanelId('terminal')
      assertCondition(Boolean(sourcePanelId), 'terminal source panel should exist')
      store.startTabDragging(
        {
          tabId: 'term-b',
          kind: 'terminal',
          sourcePanelId: sourcePanelId!
        },
        200,
        200
      )
      store.setDropTarget(sourcePanelId!, 'right')
      store.commitDragging()

      const firstSaved = await store.saveCurrentLayoutSlot()
      assertCondition(Boolean(firstSaved), 'first dynamic saved layout should be created')
      const savedTerminalPanelCount = store.panelNodes.filter((node) => node.panel.kind === 'terminal').length
      assertEqual(savedTerminalPanelCount, 2, 'first saved layout should have two terminal panels')

      const secondSaved = await store.saveCurrentLayoutSlot()
      assertCondition(Boolean(secondSaved), 'second dynamic saved layout should be created')
      assertEqual(store.activeSavedLayoutId, secondSaved!.id, 'second saved layout should become active')

      const secondTerminalPanelId = store.panelNodes
        .filter((node) => node.panel.kind === 'terminal')
        .map((node) => node.panel.id)
        .find((panelId) => panelId !== sourcePanelId)
      assertCondition(Boolean(secondTerminalPanelId), 'second terminal panel should exist')

      store.startTabDragging(
        {
          tabId: 'term-b',
          kind: 'terminal',
          sourcePanelId: secondTerminalPanelId!
        },
        240,
        240
      )
      store.setDropTarget(sourcePanelId!, 'center')
      store.commitDragging()

      assertEqual(store.activeSavedLayoutId, secondSaved!.id, 'editing the second slot should keep it active')
      assertEqual(
        store.panelNodes.filter((node) => node.panel.kind === 'terminal').length,
        1,
        'current second saved layout should merge back to one terminal panel'
      )
      assertEqual(
        countTerminalPanelsInSlot(store, secondSaved!.id),
        1,
        'second saved layout snapshot should update before switching away'
      )

      const appliedFirst = await store.applySavedLayoutSlot(firstSaved!.id)
      assertEqual(appliedFirst, true, 'first saved layout should apply successfully')
      assertEqual(store.activeSavedLayoutId, firstSaved!.id, 'first saved layout should become active')

      const terminalPanels = store.panelNodes.filter((node) => node.panel.kind === 'terminal')
      assertEqual(terminalPanels.length, 2, 'first saved layout should restore its split terminal panels')

      const appliedSecond = await store.applySavedLayoutSlot(secondSaved!.id)
      assertEqual(appliedSecond, true, 'second saved layout should apply successfully')
      assertEqual(store.activeSavedLayoutId, secondSaved!.id, 'second saved layout should become active again')
      assertEqual(
        store.panelNodes.filter((node) => node.panel.kind === 'terminal').length,
        1,
        'switching back should restore the second slot edits saved before switching away'
      )

      await sleep(220)
      const activePayloadCalls = spy.calls.filter((call) => call.layout?.activeSavedLayoutId === secondSaved!.id)
      assertCondition(activePayloadCalls.length > 0, 'applying saved layout should persist the active slot id')
      assertEqual(
        countTerminalPanelsInSlot(store, secondSaved!.id),
        1,
        'second dynamic saved layout should remain updated after switching'
      )
    }
  )

  await runCase('applying saved layout auto-hosts previously unhosted terminal tabs', async () => {
    const spy: SettingsSetSpy = { calls: [] }
    installWindowMock(spy)

    const currentTree: LayoutTree = {
      schemaVersion: 2,
      root: {
        type: 'split',
        id: 'root-current',
        direction: 'horizontal',
        children: [
          {
            type: 'panel',
            id: 'node-list',
            panel: { id: 'panel-list', kind: 'listPanel' }
          },
          {
            type: 'panel',
            id: 'node-chat',
            panel: { id: 'panel-chat', kind: 'chat' }
          }
        ],
        sizes: [34, 66]
      },
      managerPanels: {
        listPanel: 'panel-list',
        chat: 'panel-chat'
      },
      panelTabs: {
        'panel-chat': { tabIds: ['chat-a'], activeTabId: 'chat-a' }
      },
      focusedPanelId: 'panel-list'
    }
    const savedTree: LayoutTree = {
      schemaVersion: 2,
      root: {
        type: 'split',
        id: 'root-saved',
        direction: 'horizontal',
        children: [
          {
            type: 'panel',
            id: 'node-saved-list',
            panel: { id: 'panel-saved-list', kind: 'listPanel' }
          },
          {
            type: 'panel',
            id: 'node-saved-chat',
            panel: { id: 'panel-saved-chat', kind: 'chat' }
          },
          {
            type: 'panel',
            id: 'node-saved-terminal',
            panel: { id: 'panel-saved-terminal', kind: 'terminal' }
          }
        ],
        sizes: [24, 46, 30]
      },
      managerPanels: {
        listPanel: 'panel-saved-list',
        chat: 'panel-saved-chat',
        terminal: 'panel-saved-terminal'
      },
      panelTabs: {
        'panel-saved-chat': { tabIds: ['chat-a'], activeTabId: 'chat-a' },
        'panel-saved-terminal': { tabIds: [] }
      },
      focusedPanelId: 'panel-saved-terminal'
    }

    const store = createStore({
      settings: {
        layout: {
          v2: currentTree,
          savedLayouts: [
            {
              slotNumber: 1,
              createdAt: 1,
              updatedAt: 1,
              snapshot: createSavedLayoutSnapshot(savedTree)
            }
          ]
        }
      },
      terminalIds: ['term-a'],
      chatIds: ['chat-a'],
      activeTerminalId: 'term-a'
    })
    store.bootstrap()
    store.setViewport(1440, 900)
    let detachedCleanupCalls = 0
    ;(store as any).appStore.prepareForLayoutSwitch = async () => {
      detachedCleanupCalls += 1
      assertEqual(
        store.getPrimaryPanelId('terminal'),
        null,
        'detached windows should be closed before the saved tree replaces the current layout'
      )
      return true
    }

    assertEqual(store.getPrimaryPanelId('terminal'), null, 'current layout should start without terminal panel')
    assertEqual(
      JSON.stringify(store.getPanelIdsByKind('terminal')),
      JSON.stringify([]),
      'terminal tab should be unhosted while no terminal panel exists'
    )

    const applied = await store.applySavedLayoutSlot(getSavedLayoutSlotId(1))
    assertEqual(applied, true, 'saved layout containing a terminal panel should apply')
    assertEqual(
      detachedCleanupCalls,
      1,
      'applying a saved layout should close all detached windows exactly once'
    )

    const terminalPanelId = store.getPrimaryPanelId('terminal')
    assertCondition(Boolean(terminalPanelId), 'applied saved layout should restore a terminal panel')
    assertEqual(
      JSON.stringify(store.getPanelTabIds(terminalPanelId!)),
      JSON.stringify(['term-a']),
      'restored terminal panel should automatically host the previously unhosted tab'
    )
    assertEqual(store.getPanelActiveTabId(terminalPanelId!), 'term-a', 'restored terminal panel should activate the tab')
  })

  await runCase('saved layout switching filters closed tabs without materializing inventory', async () => {
    const spy: SettingsSetSpy = { calls: [] }
    installWindowMock(spy)

    const currentTree: LayoutTree = {
      schemaVersion: 2,
      root: {
        type: 'split',
        id: 'root-current-live-tabs',
        direction: 'horizontal',
        children: [
          {
            type: 'panel',
            id: 'node-current-chat',
            panel: { id: 'panel-current-chat', kind: 'chat' }
          },
          {
            type: 'panel',
            id: 'node-current-terminal',
            panel: { id: 'panel-current-terminal', kind: 'terminal' }
          }
        ],
        sizes: [50, 50]
      },
      panelTabs: {
        'panel-current-chat': {
          tabIds: ['chat-live'],
          activeTabId: 'chat-live'
        },
        'panel-current-terminal': {
          tabIds: ['term-live'],
          activeTabId: 'term-live'
        }
      },
      focusedPanelId: 'panel-current-chat'
    }
    const savedTree: LayoutTree = {
      schemaVersion: 2,
      root: {
        type: 'split',
        id: 'root-saved-stale-tabs',
        direction: 'horizontal',
        children: [
          {
            type: 'panel',
            id: 'node-saved-chat',
            panel: { id: 'panel-saved-chat', kind: 'chat' }
          },
          {
            type: 'panel',
            id: 'node-saved-terminal',
            panel: { id: 'panel-saved-terminal', kind: 'terminal' }
          }
        ],
        sizes: [50, 50]
      },
      panelTabs: {
        'panel-saved-chat': {
          tabIds: ['chat-live', 'chat-closed-a', 'chat-closed-b'],
          activeTabId: 'chat-closed-b'
        },
        'panel-saved-terminal': {
          tabIds: ['term-live', 'term-closed'],
          activeTabId: 'term-closed'
        }
      },
      focusedPanelId: 'panel-saved-chat'
    }
    const store = createStore({
      settings: {
        layout: {
          v2: currentTree,
          savedLayouts: [
            {
              slotNumber: 1,
              createdAt: 1,
              updatedAt: 1,
              snapshot: createSavedLayoutSnapshot(currentTree)
            },
            {
              slotNumber: 2,
              createdAt: 2,
              updatedAt: 2,
              snapshot: createSavedLayoutSnapshot(savedTree)
            }
          ],
          activeSavedLayoutId: getSavedLayoutSlotId(1)
        }
      },
      terminalIds: ['term-live'],
      chatIds: ['chat-live'],
      activeTerminalId: 'term-live'
    })
    store.bootstrap()
    store.setViewport(1440, 900)

    const materializeCalls: Array<{ kind: string; tabIds: string[] }> = []
    const hydrateCalls: Array<{ kind: string; tabIds: string[] }> = []
    const internal = store as any
    internal.appStore.materializeTransferredTabs = (kind: string, tabIds: string[]) => {
      materializeCalls.push({ kind, tabIds: [...tabIds] })
      if (kind === 'chat') {
        tabIds.forEach((id) => {
          if (internal.appStore.chat.sessions.some((session: { id: string }) => session.id === id)) return
          internal.appStore.chat.sessions.push({ id })
        })
      }
      return tabIds
    }
    internal.appStore.hydrateTransferredTabs = (kind: string, tabIds: string[]) => {
      hydrateCalls.push({ kind, tabIds: [...tabIds] })
      return tabIds
    }

    const applied = await store.applySavedLayoutSlot(getSavedLayoutSlotId(2))
    assertEqual(applied, true, 'saved layout with stale bindings should still apply')
    assertEqual(materializeCalls.length, 0, 'saved layout apply must not materialize closed chat inventory')
    assertEqual(hydrateCalls.length, 0, 'saved layout apply must not hydrate transfer-only chat inventory')
    assertEqual(
      JSON.stringify(internal.appStore.chat.sessions.map((session: { id: string }) => session.id)),
      JSON.stringify(['chat-live']),
      'closed chat ids must remain absent from global inventory'
    )
    assertEqual(
      JSON.stringify(store.getPanelTabIds('panel-saved-chat')),
      JSON.stringify(['chat-live']),
      'saved chat placement should retain only live chat ids'
    )
    assertEqual(
      JSON.stringify(store.getPanelTabIds('panel-saved-terminal')),
      JSON.stringify(['term-live']),
      'saved terminal placement should retain only live terminal ids'
    )

    const healedSlot = store.savedLayoutSlots.find((slot) => slot.id === getSavedLayoutSlotId(2))
    assertCondition(Boolean(healedSlot), 'applied saved slot should remain available')
    assertEqual(
      JSON.stringify(healedSlot!.snapshot.v2.panelTabs?.['panel-saved-chat']?.tabIds),
      JSON.stringify(['chat-live']),
      'dynamic saved snapshot should persist the filtered chat binding'
    )
    assertEqual(
      JSON.stringify(healedSlot!.snapshot.v2.panelTabs?.['panel-saved-terminal']?.tabIds),
      JSON.stringify(['term-live']),
      'dynamic saved snapshot should persist the filtered terminal binding'
    )

    const switchedBack = await store.applySavedLayoutSlot(getSavedLayoutSlotId(1))
    assertEqual(switchedBack, true, 'switching back to the source saved layout should succeed')
    assertEqual(
      JSON.stringify(store.getPanelTabIds('panel-current-chat')),
      JSON.stringify(['chat-live']),
      'switching back must not restore closed chat ids into the source layout'
    )
    assertEqual(
      JSON.stringify(store.getPanelTabIds('panel-current-terminal')),
      JSON.stringify(['term-live']),
      'switching back must not restore closed terminal ids into the source layout'
    )
  })

  await runCase('active tab changes update the active saved layout slot', async () => {
    const spy: SettingsSetSpy = { calls: [] }
    installWindowMock(spy)

    const store = createStore({
      terminalIds: ['term-a', 'term-b'],
      chatIds: ['chat-a'],
      activeTerminalId: 'term-b'
    })
    store.bootstrap()
    store.setViewport(1440, 900)

    const terminalPanelId = store.getPrimaryPanelId('terminal')
    assertCondition(Boolean(terminalPanelId), 'terminal panel should exist')
    assertEqual(store.getPanelActiveTabId(terminalPanelId!), 'term-b', 'saved source layout should have term-b active')

    const saved = await store.saveCurrentLayoutSlot()
    assertCondition(Boolean(saved), 'saved slot should be created with term-b active')

    store.setPanelActiveTab(terminalPanelId!, 'term-a')
    assertEqual(store.getPanelActiveTabId(terminalPanelId!), 'term-a', 'current layout should move to term-a')
    assertEqual(
      findSavedPanelActiveTab(store, saved!.id, terminalPanelId!),
      'term-a',
      'active saved layout snapshot should track panel active tab changes'
    )

    const applied = await store.applySavedLayoutSlot(saved!.id)
    assertEqual(applied, true, 'saved layout should apply successfully')
    assertEqual(store.activeSavedLayoutId, saved!.id, 'applied saved layout should become active')
    const internal = store as any
    assertEqual(
      internal.appStore.activeTerminalId,
      'term-a',
      'app global active terminal should follow the dynamically saved active tab'
    )
    assertEqual(
      store.getPanelActiveTabId(terminalPanelId!),
      'term-a',
      'applying saved layout should use the dynamically saved active tab'
    )

    store.syncPanelBindings({ persist: false })
    assertEqual(
      store.getPanelActiveTabId(terminalPanelId!),
      'term-a',
      'a later layout sync should preserve the dynamically saved active tab'
    )
  })

  await runCase('deleteSavedLayoutSlot clears active slot without changing current tree', async () => {
    const spy: SettingsSetSpy = { calls: [] }
    installWindowMock(spy)

    const store = createStore()
    store.bootstrap()
    store.setViewport(1440, 900)
    const saved = await store.saveCurrentLayoutSlot()
    assertCondition(Boolean(saved), 'saved layout slot should exist before delete')

    const beforeTree = JSON.stringify(store.tree)
    const deleted = await store.deleteSavedLayoutSlot(saved!.id)
    const afterTree = JSON.stringify(store.tree)

    assertEqual(deleted, true, 'saved layout slot should be deleted')
    assertEqual(store.savedLayoutSlots.length, 0, 'slot list should be empty after delete')
    assertEqual(store.activeSavedLayoutId, null, 'deleting active slot should clear active marker')
    assertEqual(afterTree, beforeTree, 'deleting saved slot should not change current layout tree')

    const lastPayload = spy.calls[spy.calls.length - 1]
    assertEqual(
      lastPayload.layout?.activeSavedLayoutId,
      null,
      'deleted active slot should be cleared in persisted payload'
    )
    assertEqual(
      Array.isArray(lastPayload.layout?.savedLayouts) ? lastPayload.layout?.savedLayouts.length : -1,
      0,
      'persisted saved layout list should be empty after delete'
    )
  })

  await runCase('setSplitSizes clamps invalid chat height changes', async () => {
    const spy: SettingsSetSpy = { calls: [] }
    installWindowMock(spy)

    const store = createStore({
      settings: {
        layout: {
          v2: {
            schemaVersion: 2,
            root: {
              type: 'panel',
              id: 'node-terminal',
              panel: {
                id: 'panel-terminal',
                kind: 'terminal'
              }
            }
          }
        }
      }
    })

    store.bootstrap()
    store.setViewport(1200, 1200)
    store.splitPanel('panel-terminal', 'chat', 'vertical', 'before')
    const root = store.tree.root
    assertEqual(root.type, 'split', 'split should create vertical root')
    if (root.type !== 'split') return

    const before = root.sizes.join(',')
    store.setSplitSizes(root.id, [1, 99])
    const afterRoot = store.tree.root
    assertEqual(afterRoot.type, 'split', 'root should remain split')
    if (afterRoot.type !== 'split') return
    const after = afterRoot.sizes.join(',')

    assertCondition(after !== before, 'invalid chat-min-height resize should be clamped instead of reverted')
    assertCondition(
      afterRoot.sizes[0] >= (getPanelMinHeightPx('chat', 1200) / 1200) * 100 - 0.001,
      'chat resize should land at or above its minimum percentage'
    )

    const validation = validateLayoutTree(store.tree, store.viewport)
    assertEqual(validation.valid, true, 'clamped resize should keep the layout valid')

    const chatPanelId = store.panelNodes.find((node) => node.panel.kind === 'chat')?.panel.id
    assertCondition(Boolean(chatPanelId), 'chat panel should exist after split')
    const geometry = computeLayoutGeometry(store.tree, store.viewport)
    const chatRect = geometry.panelRects[chatPanelId!]
    assertCondition(Boolean(chatRect), 'chat panel rect should be computed')
    assertCondition(
      chatRect.height >= getPanelMinHeightPx('chat', 1200) - 0.5,
      'chat panel height should not fall below the minimum'
    )
  })

  await runCase('commitDragging center swaps panel payloads', async () => {
    const spy: SettingsSetSpy = { calls: [] }
    installWindowMock(spy)

    const store = createStore({
      settings: {
        layout: {
          v2: {
            schemaVersion: 2,
            root: {
              type: 'split',
              id: 'root',
              direction: 'horizontal',
              children: [
                {
                  type: 'panel',
                  id: 'node-chat',
                  panel: { id: 'panel-chat', kind: 'chat' }
                },
                {
                  type: 'panel',
                  id: 'node-terminal',
                  panel: { id: 'panel-terminal', kind: 'terminal' }
                }
              ],
              sizes: [50, 50]
            }
          }
        }
      }
    })

    store.bootstrap()
    store.setViewport(1200, 700)
    store.startPanelDragging('panel-chat', 100, 100)
    store.setDropTarget('panel-terminal', 'center')
    store.commitDragging()

    const panelKinds = store.panelNodes.map((node) => node.panel.kind)
    assertEqual(panelKinds[0], 'terminal', 'center drop should swap first panel kind')
    assertEqual(panelKinds[1], 'chat', 'center drop should swap second panel kind')
  })

  await runCase('external panel drag to edge computes a preview rect', async () => {
    const store = createStore({
      terminalIds: ['term-a'],
      chatIds: ['chat-a']
    })
    store.bootstrap()
    store.setViewport(1400, 700)

    const terminalPanelId = store.getPrimaryPanelId('terminal')
    assertCondition(Boolean(terminalPanelId), 'terminal panel should exist')

    store.startExternalPanelDragging('filesystem', 120, 120)
    store.setDropTarget(terminalPanelId!, 'right')

    assertCondition(store.dropPreviewRect !== null, 'external panel edge drag should compute a preview rect')
    assertEqual(store.draggingExternalPanelKind, 'filesystem', 'external panel kind should be tracked')
  })

  await runCase('tab drag to edge splits a new panel and moves only that tab', async () => {
    const store = createStore({
      terminalIds: ['term-a', 'term-b'],
      chatIds: ['chat-a']
    })
    store.bootstrap()
    store.setViewport(1400, 900)

    const terminalPanelId = store.panelNodes.find((node) => node.panel.kind === 'terminal')?.panel.id
    assertCondition(Boolean(terminalPanelId), 'terminal panel should exist')
    assertEqual(store.panelCount, 3, 'default layout should contain the list panel plus chat and terminal')

    store.startTabDragging(
      {
        tabId: 'term-b',
        kind: 'terminal',
        sourcePanelId: terminalPanelId!
      },
      200,
      200
    )
    store.setDropTarget(terminalPanelId!, 'right')
    store.commitDragging()

    assertEqual(store.panelCount, 4, 'tab edge drop should create an additional terminal panel')
    const panelsWithTermB = store.panelNodes.filter((node) => store.getPanelTabIds(node.panel.id).includes('term-b'))
    assertEqual(panelsWithTermB.length, 1, 'dragged tab should belong to exactly one panel')
    assertCondition(
      panelsWithTermB[0].panel.id !== terminalPanelId,
      'dragged tab should be moved out of source panel into new panel'
    )
    assertCondition(
      !store.getPanelTabIds(terminalPanelId!).includes('term-b'),
      'source panel should no longer contain dragged tab'
    )
  })

  await runCase('tab center move prunes source panel immediately when it becomes empty', async () => {
    const store = createStore({
      terminalIds: ['term-a', 'term-b'],
      chatIds: ['chat-a']
    })
    store.bootstrap()
    store.setViewport(1400, 900)

    const primaryPanelId = store.getPrimaryPanelId('terminal')
    assertCondition(Boolean(primaryPanelId), 'terminal primary panel should exist')

    store.startTabDragging(
      {
        tabId: 'term-b',
        kind: 'terminal',
        sourcePanelId: primaryPanelId!
      },
      220,
      220
    )
    store.setDropTarget(primaryPanelId!, 'right')
    store.commitDragging()
    assertEqual(store.panelCount, 4, 'should create an extra terminal panel after edge split')

    const detachedPanelId = store.panelNodes
      .filter((node) => node.panel.kind === 'terminal')
      .map((node) => node.panel.id)
      .find((id) => id !== primaryPanelId)
    assertCondition(Boolean(detachedPanelId), 'detached terminal panel should exist')
    assertEqual(
      JSON.stringify(store.getPanelTabIds(detachedPanelId!)),
      JSON.stringify(['term-b']),
      'detached panel should own term-b before center merge'
    )

    store.startTabDragging(
      {
        tabId: 'term-b',
        kind: 'terminal',
        sourcePanelId: detachedPanelId!
      },
      320,
      320
    )
    store.setDropTarget(primaryPanelId!, 'center')
    store.commitDragging()

    assertEqual(store.panelCount, 3, 'empty source panel should be pruned immediately after center move')
    const terminalPanels = store.panelNodes.filter((node) => node.panel.kind === 'terminal')
    assertEqual(terminalPanels.length, 1, 'only one terminal panel should remain after prune')
    assertEqual(
      JSON.stringify(store.getPanelTabIds(terminalPanels[0].panel.id).sort()),
      JSON.stringify(['term-a', 'term-b']),
      'remaining terminal panel should include both tabs'
    )
  })

  await runCase('syncPanelBindings auto-removes empty panels', async () => {
    const store = createStore({
      terminalIds: ['term-a', 'term-b'],
      chatIds: ['chat-a']
    })
    store.bootstrap()
    store.setViewport(1400, 900)

    const primaryPanelId = store.getPrimaryPanelId('terminal')
    assertCondition(Boolean(primaryPanelId), 'terminal primary panel should exist')
    store.startTabDragging(
      {
        tabId: 'term-b',
        kind: 'terminal',
        sourcePanelId: primaryPanelId!
      },
      300,
      300
    )
    store.setDropTarget(primaryPanelId!, 'right')
    store.commitDragging()
    assertEqual(store.panelCount, 4, 'layout should include list panel, chat, and two terminal panels before cleanup')

    const terminalPanels = store.panelNodes
      .filter((node) => node.panel.kind === 'terminal')
      .map((node) => node.panel.id)
    assertEqual(terminalPanels.length, 2, 'should have two terminal panels after tab split')
    const detachedPanelId = terminalPanels.find((id) => id !== primaryPanelId)
    assertCondition(Boolean(detachedPanelId), 'detached terminal panel should exist')
    assertEqual(
      JSON.stringify(store.getPanelTabIds(detachedPanelId!)),
      JSON.stringify(['term-b']),
      'detached terminal panel should own dragged tab before cleanup'
    )

    const internal = store as any
    internal.appStore.terminalTabs = internal.appStore.terminalTabs.filter((tab: { id: string }) => tab.id !== 'term-b')
    if (internal.appStore.activeTerminalId === 'term-b') {
      internal.appStore.activeTerminalId = 'term-a'
    }
    store.syncPanelBindings({ persist: false })

    assertEqual(store.panelCount, 3, 'empty terminal panel should be removed automatically')
    const remainingTerminalPanels = store.panelNodes.filter((node) => node.panel.kind === 'terminal')
    assertEqual(remainingTerminalPanels.length, 1, 'only one terminal panel should remain after cleanup')
    const remainingTabIds = store.getPanelTabIds(remainingTerminalPanels[0].panel.id)
    assertEqual(
      JSON.stringify(remainingTabIds),
      JSON.stringify(['term-a']),
      'remaining terminal panel should keep valid tab ids'
    )
  })

  await runCase('removing primary panel keeps terminal tab bindings valid', async () => {
    const store = createStore({
      terminalIds: ['term-a', 'term-b']
    })
    store.bootstrap()
    store.setViewport(1400, 900)

    const originalPrimary = store.getPrimaryPanelId('terminal')
    assertCondition(Boolean(originalPrimary), 'terminal primary panel should exist')
    store.startTabDragging(
      {
        tabId: 'term-b',
        kind: 'terminal',
        sourcePanelId: originalPrimary!
      },
      240,
      240
    )
    store.setDropTarget(originalPrimary!, 'right')
    store.commitDragging()
    const terminalPanels = store.panelNodes
      .filter((node) => node.panel.kind === 'terminal')
      .map((node) => node.panel.id)
    assertEqual(terminalPanels.length, 2, 'should have two terminal panels after tab split')
    assertCondition(store.canRemovePanel(originalPrimary!), 'original primary panel should be removable after split')

    store.removePanel(originalPrimary!)
    const nextPrimary = store.getPrimaryPanelId('terminal')
    assertCondition(Boolean(nextPrimary), 'next primary panel should exist')
    assertCondition(nextPrimary !== originalPrimary, 'primary panel should switch after removing original panel')
    const assigned = store.panelNodes
      .filter((node) => node.panel.kind === 'terminal')
      .flatMap((node) => store.getPanelTabIds(node.panel.id))
      .sort()
    assertEqual(
      JSON.stringify(assigned),
      JSON.stringify(['term-a', 'term-b']),
      'all terminal tabs should remain assigned'
    )
  })

  await runCase('tab center drop supports in-panel visual reorder before target tab', async () => {
    const store = createStore({
      terminalIds: ['term-a', 'term-b', 'term-c'],
      chatIds: ['chat-a']
    })
    store.bootstrap()
    store.setViewport(1400, 900)

    const primaryPanelId = store.getPrimaryPanelId('terminal')
    assertCondition(Boolean(primaryPanelId), 'terminal primary panel should exist')
    assertEqual(
      JSON.stringify(store.getPanelTabIds(primaryPanelId!)),
      JSON.stringify(['term-a', 'term-b', 'term-c']),
      'precondition: terminal tabs should be in owner order'
    )

    store.startTabDragging(
      {
        tabId: 'term-c',
        kind: 'terminal',
        sourcePanelId: primaryPanelId!
      },
      200,
      200
    )
    store.setTabReorderTarget(primaryPanelId!, 'term-a', 'before')
    store.setDropTarget(primaryPanelId!, 'center')
    store.commitDragging()

    assertEqual(
      JSON.stringify(store.getPanelTabIds(primaryPanelId!)),
      JSON.stringify(['term-c', 'term-a', 'term-b']),
      'center drop reorder should move dragged tab before target tab'
    )
  })

  await runCase('tab center drop supports cross-panel insertion position', async () => {
    const store = createStore({
      terminalIds: ['term-a', 'term-b', 'term-c'],
      chatIds: ['chat-a']
    })
    store.bootstrap()
    store.setViewport(1400, 900)

    const primaryPanelId = store.getPrimaryPanelId('terminal')
    assertCondition(Boolean(primaryPanelId), 'terminal primary panel should exist')

    store.startTabDragging(
      {
        tabId: 'term-c',
        kind: 'terminal',
        sourcePanelId: primaryPanelId!
      },
      220,
      220
    )
    store.setDropTarget(primaryPanelId!, 'right')
    store.commitDragging()

    const targetPanelId = store.panelNodes
      .filter((node) => node.panel.kind === 'terminal')
      .map((node) => node.panel.id)
      .find((id) => id !== primaryPanelId)
    assertCondition(Boolean(targetPanelId), 'target terminal panel should exist after split')
    assertEqual(
      JSON.stringify(store.getPanelTabIds(targetPanelId!)),
      JSON.stringify(['term-c']),
      'target panel should contain dragged tab after split'
    )

    store.startTabDragging(
      {
        tabId: 'term-a',
        kind: 'terminal',
        sourcePanelId: primaryPanelId!
      },
      260,
      260
    )
    store.setTabReorderTarget(targetPanelId!, 'term-c', 'before')
    store.setDropTarget(targetPanelId!, 'center')
    store.commitDragging()

    assertEqual(
      JSON.stringify(store.getPanelTabIds(targetPanelId!)),
      JSON.stringify(['term-a', 'term-c']),
      'center drop with target tab should insert dragged tab before target in destination panel'
    )
  })

  await runCase('splitTabToDirection moves selected tab instead of creating an empty panel', async () => {
    const store = createStore({
      terminalIds: ['term-a'],
      chatIds: ['chat-a']
    })
    store.bootstrap()
    store.setViewport(1400, 900)

    const primaryPanelId = store.getPrimaryPanelId('terminal')
    assertCondition(Boolean(primaryPanelId), 'terminal primary panel should exist before split')
    assertEqual(store.panelCount, 3, 'precondition: layout should contain list panel, chat, and terminal panels')

    store.splitTabToDirection(
      {
        tabId: 'term-a',
        kind: 'terminal',
        sourcePanelId: primaryPanelId!
      },
      primaryPanelId!,
      'right'
    )

    const terminalPanels = store.panelNodes.filter((node) => node.panel.kind === 'terminal')
    assertEqual(terminalPanels.length, 1, 'single-tab split should not leave an extra empty terminal panel')
    assertEqual(store.panelCount, 3, 'single-tab split should keep total panel count stable')
    assertEqual(
      JSON.stringify(store.getPanelTabIds(terminalPanels[0].panel.id)),
      JSON.stringify(['term-a']),
      'the selected tab should remain alive and attached to the resulting terminal panel'
    )
  })

  await runCase('tab center drop accepts null anchor reorder target for empty destination tab bar', async () => {
    const store = createStore({
      terminalIds: ['term-a', 'term-b'],
      chatIds: ['chat-a']
    })
    store.bootstrap()
    store.setViewport(1400, 900)

    const primaryPanelId = store.getPrimaryPanelId('terminal')
    assertCondition(Boolean(primaryPanelId), 'terminal primary panel should exist')
    store.splitPanel(primaryPanelId!, 'terminal', 'horizontal', 'after')
    const destinationPanelId = store.tree.focusedPanelId
    assertCondition(Boolean(destinationPanelId), 'split should create a focused empty destination panel')
    assertEqual(
      store.getPanelTabIds(destinationPanelId!).length,
      0,
      'destination panel should be empty before insertion'
    )

    store.startTabDragging(
      {
        tabId: 'term-b',
        kind: 'terminal',
        sourcePanelId: primaryPanelId!
      },
      260,
      260
    )
    store.setTabReorderTarget(destinationPanelId!, null, 'after')
    store.setDropTarget(destinationPanelId!, 'center')
    store.commitDragging()

    assertEqual(
      JSON.stringify(store.getPanelTabIds(destinationPanelId!)),
      JSON.stringify(['term-b']),
      'null-anchor reorder target should insert dragged tab into empty destination panel'
    )
  })

  await runCase('importPanelFromExternal reassigns imported tabs away from existing panels', async () => {
    const store = createStore({
      terminalIds: ['term-a', 'term-b', 'term-c'],
      chatIds: ['chat-a']
    })
    store.bootstrap()
    store.setViewport(1400, 900)

    const primaryPanelId = store.getPrimaryPanelId('terminal')
    assertCondition(Boolean(primaryPanelId), 'terminal primary panel should exist')
    assertEqual(
      JSON.stringify(store.getPanelTabIds(primaryPanelId!)),
      JSON.stringify(['term-a', 'term-b', 'term-c']),
      'precondition: source terminal panel should initially own all terminal tabs'
    )

    const importedPanelId = store.importPanelFromExternal(
      'terminal',
      {
        tabIds: ['term-b', 'term-c'],
        activeTabId: 'term-c'
      },
      { panelId: primaryPanelId!, direction: 'right' }
    )

    assertCondition(Boolean(importedPanelId), 'importPanelFromExternal should create a target panel')
    assertEqual(
      JSON.stringify(store.getPanelTabIds(primaryPanelId!)),
      JSON.stringify(['term-a']),
      'existing panel should relinquish imported tabs'
    )
    assertEqual(
      JSON.stringify(store.getPanelTabIds(importedPanelId!)),
      JSON.stringify(['term-b', 'term-c']),
      'imported panel should own the transferred tabs'
    )
    assertEqual(store.getPanelActiveTabId(importedPanelId!), 'term-c', 'imported panel should preserve its active tab')
  })

  await runCase('can remove the last panel of a kind when other kinds still exist', async () => {
    const store = createStore({
      terminalIds: ['term-a'],
      chatIds: ['chat-a']
    })
    const internal = store as any
    store.bootstrap()
    store.setViewport(1400, 900)

    const terminalPanelId = store.getPrimaryPanelId('terminal')
    const chatPanelId = store.getPrimaryPanelId('chat')
    assertCondition(Boolean(terminalPanelId), 'terminal panel should exist')
    assertCondition(Boolean(chatPanelId), 'chat panel should exist')
    assertCondition(store.canRemovePanel(terminalPanelId!), 'terminal panel should be removable')

    store.removePanel(terminalPanelId!)
    assertEqual(store.getPrimaryPanelId('terminal'), null, 'terminal panels can all be closed from layout')
    assertEqual(store.panelCount, 2, 'layout should keep list and chat panels after terminal removal')
    assertEqual(store.getPrimaryPanelId('chat'), chatPanelId, 'chat panel should remain intact')
    assertEqual(
      JSON.stringify(internal.appStore.terminalTabs.map((tab: { id: string }) => tab.id)),
      JSON.stringify(['term-a']),
      'removing a panel must not close owner terminal tabs'
    )
  })

  await runCase('can remove the final chat panel when other kinds still exist', async () => {
    const store = createStore({
      terminalIds: ['term-a'],
      chatIds: ['chat-a']
    })
    store.bootstrap()
    store.setViewport(1400, 900)

    const chatPanelId = store.getPrimaryPanelId('chat')
    const terminalPanelId = store.getPrimaryPanelId('terminal')
    assertCondition(Boolean(chatPanelId), 'chat panel should exist')
    assertCondition(Boolean(terminalPanelId), 'terminal panel should exist')
    assertEqual(store.panelCount, 3, 'default layout should start with list panel, chat, and terminal panel')
    assertEqual(store.canRemovePanel(chatPanelId!), true, 'chat panel should be removable when another panel exists')

    store.removePanel(chatPanelId!)
    assertEqual(store.panelCount, 2, 'removing chat panel should leave list panel and terminal panel')
    assertEqual(store.getPrimaryPanelId('chat'), null, 'chat panel should be removable from layout')
    assertEqual(store.getPrimaryPanelId('terminal'), terminalPanelId, 'terminal panel should remain after chat removal')
  })

  await runCase('list panel stays outside tab bindings and is limited to one instance', async () => {
    const store = createStore({
      terminalIds: ['term-a', 'term-b'],
      chatIds: ['chat-a']
    })
    store.bootstrap()
    store.setViewport(1400, 900)

    const terminalPanelId = store.getPrimaryPanelId('terminal')
    assertCondition(Boolean(terminalPanelId), 'terminal panel should exist')

    store.splitPanel(terminalPanelId!, 'listPanel', 'horizontal', 'after')
    const listPanelId = store.getPrimaryPanelId('listPanel')
    assertCondition(Boolean(listPanelId), 'list panel should be created')
    assertEqual(store.getPanelTabIds(listPanelId!).length, 0, 'list panel should expose no hosted tab ids')
    assertEqual(Boolean(store.tree.panelTabs?.[listPanelId!]), false, 'list panel should not receive panelTabs binding')

    store.splitPanel(listPanelId!, 'listPanel', 'horizontal', 'after')
    assertEqual(
      store.getPanelIdsByKind('listPanel').length,
      1,
      'layout should enforce one list panel instance'
    )
  })

  await runCase('ensurePrimaryPanelForKind inserts list panel on the left for legacy layouts', async () => {
    const store = createStore({
      settings: {
        layout: {
          panelOrder: ['chat', 'terminal'],
          panelSizes: [50, 50]
        }
      },
      terminalIds: ['term-a'],
      chatIds: ['chat-a']
    })
    store.bootstrap()
    store.setViewport(1400, 900)

    assertEqual(store.getPrimaryPanelId('listPanel'), null, 'legacy layout should start without list panel')
    const listPanelId = store.ensurePrimaryPanelForKind('listPanel')
    assertCondition(Boolean(listPanelId), 'list panel should be inserted')
    assertEqual(
      listPanels(store.tree)[0].panel.kind,
      'listPanel',
      'list panel should be inserted at the far left'
    )
  })

  await runCase('shadow tab edge drop creates its own kind panel from a different target kind', async () => {
    const store = createStore({
      terminalIds: ['term-a', 'term-b'],
      chatIds: ['chat-a']
    })
    store.bootstrap()
    store.setViewport(1800, 900)

    const chatPanelId = store.getPrimaryPanelId('chat')
    assertCondition(Boolean(chatPanelId), 'chat panel should exist')

    store.startTabDragging(
      {
        tabId: 'term-b',
        kind: 'terminal',
        sourcePanelId: 'panel-list-shadow'
      },
      260,
      260
    )
    store.setDropTarget(chatPanelId!, 'left')
    store.commitDragging()

    const terminalPanels = store.panelNodes.filter((node) => node.panel.kind === 'terminal')
    const panelsWithTermB = terminalPanels.filter((node) => store.getPanelTabIds(node.panel.id).includes('term-b'))
    assertEqual(terminalPanels.length, 2, 'edge drop onto chat should create a second terminal panel')
    assertEqual(panelsWithTermB.length, 1, 'shadow-dragged tab should belong to exactly one terminal panel')
    assertEqual(
      store.getPanelActiveTabId(panelsWithTermB[0].panel.id),
      'term-b',
      'new terminal panel should activate the dropped tab'
    )
  })

  await runCase('shadow tab center drop is rejected for a different target kind', async () => {
    const store = createStore({
      terminalIds: ['term-a', 'term-b'],
      chatIds: ['chat-a']
    })
    store.bootstrap()
    store.setViewport(1400, 900)

    const chatPanelId = store.getPrimaryPanelId('chat')
    assertCondition(Boolean(chatPanelId), 'chat panel should exist')

    store.startTabDragging(
      {
        tabId: 'term-b',
        kind: 'terminal',
        sourcePanelId: 'panel-list-shadow'
      },
      260,
      260
    )
    store.setDropTarget(chatPanelId!, 'center')
    store.commitDragging()

    const terminalPanels = store.panelNodes.filter((node) => node.panel.kind === 'terminal')
    assertEqual(terminalPanels.length, 1, 'center drop onto chat should not create a terminal panel')
    assertEqual(store.getPanelTabIds(chatPanelId!).includes('term-b'), false, 'chat panel should not receive terminal tab ids')
  })

  await runCase('unhosted tab auto-attaches after recreating its missing panel kind', async () => {
    const store = createStore({
      terminalIds: ['term-a'],
      chatIds: ['chat-a']
    })
    store.bootstrap()
    store.setViewport(1400, 900)

    const terminalPanelId = store.getPrimaryPanelId('terminal')
    const listPanelId = store.getPrimaryPanelId('listPanel')
    assertCondition(Boolean(terminalPanelId), 'terminal panel should exist before removal')
    assertCondition(Boolean(listPanelId), 'list panel should exist before removal')
    store.removePanel(terminalPanelId!)
    assertEqual(store.getPrimaryPanelId('terminal'), null, 'terminal panel should be absent before reattach')
    store.setFocusedPanel(listPanelId!)

    const recreatedPanelId = store.ensurePrimaryPanelForKind('terminal')
    assertCondition(Boolean(recreatedPanelId), 'missing terminal panel should be recreatable')

    assertEqual(
      JSON.stringify(store.getPanelTabIds(recreatedPanelId!)),
      JSON.stringify(['term-a']),
      'reattached terminal panel should host the previously unhosted tab'
    )
    assertEqual(store.getPanelActiveTabId(recreatedPanelId!), 'term-a', 'reattached tab should be active')
  })
}

void run()
  .then(() => {
    console.log('All LayoutStore extreme tests passed.')
  })
  .catch((error) => {
    console.error(error)
    throw error
  })
