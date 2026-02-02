import React from 'react'
import { observer } from 'mobx-react-lite'
import { Settings, SlidersHorizontal } from 'lucide-react'
import type { AppStore } from '../../stores/AppStore'
import './topbar.scss'

export const TopBar: React.FC<{ store: AppStore }> = observer(({ store }) => {
  return (
    <div className="topbar">
      <div className="topbar-left">
        <div className="topbar-title">GyShell</div>
      </div>
      <div className="topbar-right">
        {/* Connection manager entry: adding new remote connections should be in Connections SSH panel */}
        <button className="icon-btn" title={store.i18n.t.connections.title} onClick={() => store.openConnections()}>
          <SlidersHorizontal size={16} strokeWidth={2} />
        </button>

        <button className="icon-btn" onClick={() => store.toggleSettings()} title={store.i18n.t.settings.title}>
          <Settings size={16} strokeWidth={2} />
        </button>
      </div>
    </div>
  )
})


