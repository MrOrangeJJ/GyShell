import React from 'react'
import { Laptop, Plus, Server, X } from 'lucide-react'
import { observer } from 'mobx-react-lite'
import type { AppStore } from '../../stores/AppStore'
import './terminal.scss'
import { XTermView } from './XTermView'
import { ConfirmDialog } from '../Common/ConfirmDialog'

export const TerminalPanel: React.FC<{ store: AppStore }> = observer(({ store }) => {
  const [menuOpen, setMenuOpen] = React.useState(false)
  const [confirmCloseId, setConfirmCloseId] = React.useState<string | null>(null)
  const rootRef = React.useRef<HTMLDivElement | null>(null)
  const menuRef = React.useRef<HTMLDivElement | null>(null)
  const t = store.i18n.t

  // Dismiss menu on outside click / Escape
  React.useEffect(() => {
    if (!menuOpen) return

    const onMouseDown = (e: MouseEvent) => {
      const target = e.target as Node | null
      if (!target) return
      if (menuRef.current?.contains(target)) return
      // clicking the + itself is inside root; we still want to close if click elsewhere
      if (rootRef.current?.contains(target) && (target as HTMLElement).closest('.tab-add-btn')) return
      setMenuOpen(false)
    }

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenuOpen(false)
    }

    window.addEventListener('mousedown', onMouseDown)
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('mousedown', onMouseDown)
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [menuOpen])

  return (
    <div className="panel panel-terminal" ref={rootRef}>
      <ConfirmDialog
        open={!!confirmCloseId}
        title={t.terminal.confirmCloseTitle}
        message={t.terminal.confirmCloseMessage}
        confirmText={t.common.close}
        cancelText={t.common.cancel}
        danger
        onConfirm={() => {
          if (confirmCloseId) {
            void store.closeTab(confirmCloseId)
            setConfirmCloseId(null)
          }
        }}
        onCancel={() => setConfirmCloseId(null)}
      />
      <div className="terminal-tabs-container">
        <div className="terminal-tabs-bar">
          {store.terminalTabs.map((tab) => {
            const isActive = tab.id === store.activeTerminalId
            const Icon = tab.config.type === 'ssh' ? Server : Laptop
            return (
              <div
                key={tab.id}
                className={isActive ? 'tab is-active' : 'tab'}
                onClick={() => store.setActiveTerminal(tab.id)}
                role="button"
                tabIndex={0}
              >
                <span className="tab-icon">
                  <Icon size={14} strokeWidth={2} />
                </span>
                <span className="tab-title">{tab.title}</span>
                <button
                  className="tab-close"
                  title={t.common.close}
                  onClick={(e) => {
                    e.stopPropagation()
                    setConfirmCloseId(tab.id)
                  }}
                >
                  <X size={14} strokeWidth={2} />
                </button>
              </div>
            )
          })}
        </div>
        <button className="icon-btn-sm tab-add-btn" title={t.terminal.newTab} onClick={() => setMenuOpen((v) => !v)}>
          <Plus size={14} strokeWidth={2} />
        </button>

        {menuOpen ? (
          <div className="tab-menu" role="menu" ref={menuRef}>
            <button
              className="tab-menu-item"
              onClick={() => {
                store.createLocalTab()
                setMenuOpen(false)
              }}
            >
              <Laptop size={14} strokeWidth={2} />
              <span>{t.terminal.local}</span>
            </button>

            {store.settings?.connections?.ssh?.length ? (
              <div className="tab-menu-sep" />
            ) : null}

            {store.settings?.connections?.ssh?.map((e) => (
              <button
                key={e.id}
                className="tab-menu-item"
                onClick={() => {
                  store.createSshTab(e.id)
                  setMenuOpen(false)
                }}
              >
                <Server size={14} strokeWidth={2} />
                <span>{e.name || `${e.username}@${e.host}`}</span>
              </button>
            ))}

            <div className="tab-menu-sep" />
            <button
              className="tab-menu-item"
              onClick={() => {
                store.openConnections()
                setMenuOpen(false)
              }}
            >
              <Server size={14} strokeWidth={2} />
              <span>{t.connections.manage}</span>
            </button>
          </div>
        ) : null}
      </div>
      
      <div className="panel-body">
        {store.terminalTabs.length ? (
          <div className="terminal-stack">
            {store.terminalTabs.map((tab) => {
              const isActive = tab.id === store.activeTerminalId
              return (
                <div
                  key={tab.id}
                  className={isActive ? 'terminal-layer is-active' : 'terminal-layer'}
                >
                  <XTermView
                    config={tab.config}
                    theme={store.xtermTheme}
                    terminalSettings={store.settings?.terminal}
                    isActive={isActive}
                    onSelectionChange={(text) => store.setTerminalSelection(tab.id, text)}
                  />
                </div>
              )
            })}
          </div>
        ) : (
          <div className="placeholder">No Terminal</div>
        )}
      </div>
    </div>
  )
})


