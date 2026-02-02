import { makeObservable, observable, action, toJS } from 'mobx'
import type { AppStore } from './AppStore'

export type PanelId = 'chat' | 'terminal'

export class LayoutStore {
  panelSizes: number[] = [30, 70]
  panelOrder: PanelId[] = ['chat', 'terminal']
  isReady = false
  
  // Drag and drop state
  isDragging = false
  dragX = 0
  dropIndicator: 'left' | 'right' | null = null
  
  private appStore: AppStore

  constructor(appStore: AppStore) {
    this.appStore = appStore
    makeObservable(this, {
      panelSizes: observable,
      panelOrder: observable,
      isReady: observable,
      isDragging: observable,
      dragX: observable,
      dropIndicator: observable,
      setPanelSizes: action,
      setPanelOrder: action,
      setDragging: action,
      setDragX: action,
      setDropIndicator: action,
      swapPanels: action,
      bootstrap: action
    })
  }

  bootstrap() {
    const settings = this.appStore.settings
    if (settings?.layout) {
      if (settings.layout.panelSizes) {
        this.panelSizes = [...settings.layout.panelSizes]
      }
      if (settings.layout.panelOrder) {
        this.panelOrder = [...settings.layout.panelOrder] as PanelId[]
      }
    }
    this.isReady = true
  }

  setPanelSizes(sizes: number[]) {
    this.panelSizes = sizes
    this.saveLayout()
  }

  setPanelOrder(order: PanelId[]) {
    this.panelOrder = order
    this.saveLayout()
  }

  setDragging(dragging: boolean) {
    this.isDragging = dragging
    if (!dragging) {
      this.dropIndicator = null
    }
  }

  setDragX(x: number) {
    this.dragX = x
  }

  setDropIndicator(indicator: 'left' | 'right' | null) {
    this.dropIndicator = indicator
  }

  swapPanels() {
    this.panelOrder = [...this.panelOrder].reverse()
    this.panelSizes = [...this.panelSizes].reverse()
    this.saveLayout()
  }

  private async saveLayout() {
    await window.gyshell.settings.set({
      layout: {
        panelSizes: toJS(this.panelSizes),
        panelOrder: toJS(this.panelOrder)
      }
    })
  }
}
