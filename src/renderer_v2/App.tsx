import React from 'react'
import { observer } from 'mobx-react-lite'
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels'
import { AppStore } from './stores/AppStore'
import { TopBar } from './components/TopBar/TopBar'
import { ChatPanel } from './components/Chat/ChatPanel'
import { TerminalPanel } from './components/Terminal/TerminalPanel'
import { SettingsView } from './components/Settings/SettingsView'
import { ConnectionsView } from './components/Connections/ConnectionsView'
import { ConfirmDialog } from './components/Common/ConfirmDialog'
import './styles/app.scss'

const store = new AppStore()

export const App: React.FC = observer(() => {
  React.useEffect(() => {
    store.bootstrap()
  }, [])

  const platform = (window as any)?.gyshell?.system?.platform
  const t = store.i18n.t
  const versionInfo = store.versionInfo
  const panelGroupRef = React.useRef<any>(null)
  const applyingLayoutRef = React.useRef(false)
  const platformClass =
    platform === 'win32'
      ? 'platform-windows'
      : platform === 'darwin'
      ? 'platform-darwin'
      : platform === 'linux'
      ? 'platform-linux'
      : navigator.userAgent.toLowerCase().includes('windows')
      ? 'platform-windows'
      : 'platform-darwin'

  React.useEffect(() => {
    if (!store.layout.isReady) return
    const group = panelGroupRef.current
    if (!group?.setLayout) return
    applyingLayoutRef.current = true
    group.setLayout(store.layout.panelSizes)
    requestAnimationFrame(() => {
      applyingLayoutRef.current = false
    })
  }, [store.layout.isReady, store.layout.panelOrder.join(','), store.layout.panelSizes.join(',')])

  return (
    <div className={`gyshell ${platformClass}`}>
      <ConfirmDialog
        open={store.showVersionUpdateDialog && !!versionInfo && versionInfo.status === 'update-available'}
        title={t.settings.versionUpdateTitle}
        message={`${t.settings.versionUpdateMessage(versionInfo?.currentVersion || '-', versionInfo?.latestVersion || '-')}\n\n${t.settings.versionCheckNote}`}
        confirmText={t.settings.goToDownload}
        cancelText={t.common.close}
        onCancel={() => store.closeVersionUpdateDialog()}
        onConfirm={() => {
          void store.openVersionDownload()
          store.closeVersionUpdateDialog()
        }}
      />

      <TopBar store={store} />

      <div className="gyshell-body">
        <div className={store.view === 'settings' ? 'gyshell-main is-dimmed' : 'gyshell-main'}>
          <PanelGroup
            ref={panelGroupRef}
            direction="horizontal"
            className="gyshell-panels"
            onLayout={(sizes) => {
              if (!store.layout.isReady) return
              if (applyingLayoutRef.current) {
                applyingLayoutRef.current = false
                return
              }
              // Store sizes in the current visual order (panelOrder).
              store.layout.setPanelSizes(sizes)
            }}
          >
            {store.layout.panelOrder.map((panelId, index) => {
              const size = store.layout.panelSizes[index] ?? (index === 0 ? 30 : 70)
              
              return (
                <React.Fragment key={panelId}>
                  <Panel id={panelId} order={index} defaultSize={size} minSize={20}>
                    {panelId === 'chat' ? (
                      <ChatPanel store={store} />
                    ) : (
                      <TerminalPanel store={store} />
                    )}
                  </Panel>
                  {index < store.layout.panelOrder.length - 1 && (
                    <PanelResizeHandle className="gyshell-resize-handle" />
                  )}
                </React.Fragment>
              )
            })}
          </PanelGroup>
        </div>

        {/* Drag Overlay / Drop Indicators */}
        {store.layout.isDragging && (
          <div className="gyshell-drag-overlay">
            {(() => {
              const chatIndex = store.layout.panelOrder.indexOf('chat')
              const chatSize = store.layout.panelSizes[chatIndex] ?? store.layout.panelSizes[0] ?? 30
              const leftFlex = store.layout.dropIndicator === 'left' ? `0 0 ${chatSize}%` : '0 0 0%'
              const rightFlex = store.layout.dropIndicator === 'right' ? `0 0 ${chatSize}%` : '0 0 0%'
              
              return (
                <>
                  <div
                    className={`gyshell-drop-indicator left${store.layout.dropIndicator === 'left' ? ' is-active' : ''}`}
                    style={{ flex: leftFlex }}
                  />
                  <div className="gyshell-drop-indicator center">
                    <div className="drag-hint">{t.chat.dragHint}</div>
                  </div>
                  <div
                    className={`gyshell-drop-indicator right${store.layout.dropIndicator === 'right' ? ' is-active' : ''}`}
                    style={{ flex: rightFlex }}
                  />
                </>
              )
            })()}
          </div>
        )}

        {/* Settings is an overlay so we don't unmount terminals (xterm state stays alive) */}
        <div
          className={`gyshell-overlay settings-overlay${store.view === 'settings' ? ' is-open' : ''}`}
        >
          <SettingsView store={store} />
        </div>

        <div
          className={`gyshell-overlay connections-overlay${store.view === 'connections' ? ' is-open' : ''}`}
        >
          <ConnectionsView store={store} />
        </div>
      </div>
    </div>
  )
})
