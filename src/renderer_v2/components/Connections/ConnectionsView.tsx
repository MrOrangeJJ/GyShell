import React from 'react'
import { observer } from 'mobx-react-lite'
import { ArrowLeft, KeyRound, LockKeyhole, Pencil, Plus, Save, Server, Shield, Trash2, Waypoints } from 'lucide-react'
import type { AppStore } from '../../stores/AppStore'
import { PortForwardType, type TunnelEntry } from '../../lib/ipcTypes'
import './connections.scss'
import { ConfirmDialog } from '../Common/ConfirmDialog'

export type ConnectionsSection = 'ssh' | 'proxies' | 'tunnels'

export const ConnectionsView: React.FC<{ store: AppStore }> = observer(({ store }) => {
  const t = store.i18n.t
  const [section, setSection] = React.useState<ConnectionsSection>('ssh')
  const ssh = store.settings?.connections?.ssh ?? []

  const proxies = store.settings?.connections?.proxies ?? []
  const tunnels = store.settings?.connections?.tunnels ?? []

  const [editingId, setEditingId] = React.useState<string | null>(null)

  const [draft, setDraft] = React.useState<any>(null)
  const [deleteConfirm, setDeleteConfirm] = React.useState<null | { section: ConnectionsSection; id: string }>(null)

  React.useEffect(() => {
    // reset editor when switching sections
    setEditingId(null)
    setDraft(null)
  }, [section])

  function startNewSsh() {
    const id = `ssh-${crypto.randomUUID?.() ?? Math.random().toString(16).slice(2)}`
    setEditingId(id)
    setDraft({
      id,
      name: '',
      host: '',
      port: 22,
      username: '',
      authMethod: 'password',
      password: '',
      privateKey: '',
      privateKeyPath: '',
      passphrase: ''
    })
  }

  function startNewProxy() {
    const id = `proxy-${crypto.randomUUID?.() ?? Date.now()}`
    setEditingId(id)
    setDraft({
      id,
      name: '',
      type: 'socks5',
      host: '',
      port: 1080,
      username: '',
      password: ''
    })
  }

  function startNewTunnel() {
    const id = `tunnel-${crypto.randomUUID?.() ?? Date.now()}`
    setEditingId(id)
    setDraft({
      id,
      name: '',
      type: PortForwardType.Local,
      host: '127.0.0.1',
      port: 8080,
      targetAddress: '127.0.0.1',
      targetPort: 80
    })
  }

  function startEdit(entry: any) {
    setEditingId(entry.id)
    setDraft({ ...entry })
  }

  async function saveDraft() {
    if (!draft) return
    if (section === 'ssh') {
      const next = {
        ...draft,
        port: Number(draft.port) || 22,
        authMethod: draft.authMethod === 'privateKey' ? 'privateKey' : 'password'
      }
      await store.saveSshConnection(next)
    } else if (section === 'proxies') {
      const next = {
        ...draft,
        port: Number(draft.port) || 1080
      }
      await store.saveProxy(next)
    } else if (section === 'tunnels') {
      const next = {
        ...draft,
        port: Number(draft.port) || 8080,
        targetPort: draft.type !== PortForwardType.Dynamic ? Number(draft.targetPort) || 80 : undefined
      }
      await store.saveTunnel(next)
    }
  }

  async function deleteCurrent() {
    if (!editingId) return
    setDeleteConfirm({ section, id: editingId })
  }

  return (
    <div className="connections">
      <ConfirmDialog
        open={!!deleteConfirm}
        title={t.common.confirmDeleteTitle}
        message={t.common.confirmDeleteConfig}
        confirmText={t.common.delete}
        cancelText={t.common.cancel}
        danger
        onCancel={() => setDeleteConfirm(null)}
        onConfirm={async () => {
          if (!deleteConfirm) return
          const { section: sec, id } = deleteConfirm
          if (sec === 'ssh') await store.deleteSshConnection(id)
          else if (sec === 'proxies') await store.deleteProxy(id)
          else if (sec === 'tunnels') await store.deleteTunnel(id)
          setDeleteConfirm(null)
          setEditingId(null)
          setDraft(null)
        }}
      />
      <div className="connections-sidebar">
        <button className="connections-back-btn" onClick={() => store.closeOverlay()} title={t.common.back}>
          <ArrowLeft size={16} strokeWidth={2} />
        </button>

        <div className="connections-nav">
          <div
            className={section === 'ssh' ? 'connections-nav-item is-active' : 'connections-nav-item'}
            onClick={() => setSection('ssh')}
            role="button"
            tabIndex={0}
          >
            <span className="icon">
              <Server size={16} strokeWidth={2} />
            </span>
            <span>{t.connections.ssh}</span>
          </div>
          <div
            className={section === 'proxies' ? 'connections-nav-item is-active' : 'connections-nav-item'}
            onClick={() => setSection('proxies')}
            role="button"
            tabIndex={0}
          >
            <span className="icon">
              <Shield size={16} strokeWidth={2} />
            </span>
            <span>{t.connections.proxy}</span>
          </div>
          <div
            className={section === 'tunnels' ? 'connections-nav-item is-active' : 'connections-nav-item'}
            onClick={() => setSection('tunnels')}
            role="button"
            tabIndex={0}
          >
            <span className="icon">
              <Waypoints size={16} strokeWidth={2} />
            </span>
            <span>{t.connections.tunnels}</span>
          </div>
        </div>
      </div>

      <div className="connections-content">
        {section === 'ssh' ? (
          <>
            <div className="connections-header">
              <div className="connections-title">{t.connections.ssh}</div>
              <div className="connections-actions">
                {/* Add new remote connection (as requested: + placed inside SSH panel) */}
                <button className="icon-btn-sm" title={t.common.add} onClick={startNewSsh}>
                  <Plus size={16} strokeWidth={2} />
                </button>
              </div>
            </div>

            <div className="connections-split">
              <div className="connections-table">
                <div className="connections-row header">
                  <div className="connections-row-main header-main">
                    <div>{t.common.name}</div>
                    <div>{t.common.host}</div>
                    <div>{t.common.port}</div>
                    <div>{t.common.user}</div>
                  </div>
                  <div className="row-icon header-icon" aria-hidden="true" />
                </div>
                {ssh.map((c) => (
                  <div key={c.id} className={editingId === c.id ? 'connections-row is-active' : 'connections-row'}>
                    <button
                      className="connections-row-main"
                      onClick={() => startEdit(c)}
                      title={t.common.edit}
                    >
                      <div>{c.name}</div>
                      <div>{c.host}</div>
                      <div>{c.port}</div>
                      <div>{c.username}</div>
                    </button>
                    <button className="row-icon" title={t.common.edit} onClick={() => startEdit(c)}>
                      <Pencil size={14} strokeWidth={2} />
                    </button>
                  </div>
                ))}
                {!ssh.length ? <div className="connections-empty">No SSH connections yet.</div> : null}
              </div>

              <div className="connections-editor">
                {!draft ? (
                  <div className="editor-empty">{t.common.selectOrCreate}</div>
                ) : (
                  <div className="editor-card">
                    <div className="editor-row">
                      <span className="editor-icon">
                        <Server size={16} strokeWidth={2} />
                      </span>
                      <input
                        className="editor-input"
                        placeholder={t.common.name}
                        value={draft.name ?? ''}
                        onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                      />
                    </div>

                    <div className="editor-row">
                      <span className="editor-icon">
                        <Server size={16} strokeWidth={2} />
                      </span>
                      <input
                        className="editor-input"
                        placeholder={t.common.host}
                        value={draft.host ?? ''}
                        onChange={(e) => setDraft({ ...draft, host: e.target.value })}
                      />
                    </div>

                    <div className="editor-row">
                      <span className="editor-icon">
                        <Server size={16} strokeWidth={2} />
                      </span>
                      <input
                        className="editor-input"
                        placeholder={t.common.port}
                        value={String(draft.port ?? 22)}
                        onChange={(e) => setDraft({ ...draft, port: e.target.value })}
                      />
                    </div>

                    <div className="editor-row">
                      <span className="editor-icon">
                        <Server size={16} strokeWidth={2} />
                      </span>
                      <input
                        className="editor-input"
                        placeholder={t.common.user}
                        value={draft.username ?? ''}
                        onChange={(e) => setDraft({ ...draft, username: e.target.value })}
                      />
                    </div>

                    <div className="editor-row">
                      <span className="editor-icon">
                        <KeyRound size={16} strokeWidth={2} />
                      </span>
                      <select
                        className="editor-select"
                        value={draft.authMethod ?? 'password'}
                        onChange={(e) => setDraft({ ...draft, authMethod: e.target.value })}
                      >
                        <option value="password">Password</option>
                        <option value="privateKey">Private Key</option>
                      </select>
                    </div>

                    {/* Default pwd, but all fields supported: show key/path/passphrase in key mode */}
                    {(draft.authMethod ?? 'password') === 'password' ? (
                      <div className="editor-row">
                        <span className="editor-icon">
                          <LockKeyhole size={16} strokeWidth={2} />
                        </span>
                        <input
                          type="password"
                          className="editor-input"
                          placeholder={t.common.password}
                          value={draft.password ?? ''}
                          onChange={(e) => setDraft({ ...draft, password: e.target.value })}
                        />
                      </div>
                    ) : (
                      <>
                        <div className="editor-row">
                          <span className="editor-icon">
                            <LockKeyhole size={16} strokeWidth={2} />
                          </span>
                          <input
                            className="editor-input"
                            placeholder={t.common.privateKeyPath}
                            value={draft.privateKeyPath ?? ''}
                            onChange={(e) => setDraft({ ...draft, privateKeyPath: e.target.value })}
                          />
                        </div>
                        <div className="editor-row">
                          <span className="editor-icon">
                            <LockKeyhole size={16} strokeWidth={2} />
                          </span>
                          <input
                            className="editor-input"
                            placeholder={t.common.privateKeyInline}
                            value={draft.privateKey ?? ''}
                            onChange={(e) => setDraft({ ...draft, privateKey: e.target.value })}
                          />
                        </div>
                        <div className="editor-row">
                          <span className="editor-icon">
                            <LockKeyhole size={16} strokeWidth={2} />
                          </span>
                          <input
                            className="editor-input"
                            placeholder={t.common.passphrase}
                            value={draft.passphrase ?? ''}
                            onChange={(e) => setDraft({ ...draft, passphrase: e.target.value })}
                          />
                        </div>
                      </>
                    )}

                    <div className="editor-row">
                      <span className="editor-icon">
                        <Shield size={16} strokeWidth={2} />
                      </span>
                      <select
                        className="editor-select"
                        value={draft.proxyId ?? ''}
                        onChange={(e) => setDraft({ ...draft, proxyId: e.target.value || undefined })}
                      >
                        <option value="">{t.connections.proxy}: None</option>
                        {proxies.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                      </select>
                    </div>

                    <div className="editor-row" style={{ height: 'auto', alignItems: 'flex-start', padding: '8px 0' }}>
                      <span className="editor-icon" style={{ marginTop: 6 }}>
                        <Waypoints size={16} strokeWidth={2} />
                      </span>
                      <div style={{ flex: 1, padding: '0 8px' }}>
                        <div style={{ fontSize: 12, color: 'var(--fg-muted)', marginBottom: 4 }}>{t.connections.tunnels}</div>
                        {tunnels.map(tu => (
                          <div key={tu.id} style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 4 }}>
                            <input
                              type="checkbox"
                              checked={(draft.tunnelIds ?? []).includes(tu.id)}
                              onChange={(e) => {
                                const current = draft.tunnelIds ?? []
                                if (e.target.checked) setDraft({ ...draft, tunnelIds: [...current, tu.id] })
                                else setDraft({ ...draft, tunnelIds: current.filter((x: string) => x !== tu.id) })
                              }}
                            />
                            <span style={{ fontSize: 13, color: 'var(--fg)' }}>{tu.name}</span>
                          </div>
                        ))}
                        {!tunnels.length && <div style={{ fontSize: 12, color: 'var(--fg-muted)', opacity: 0.5 }}>No tunnels defined</div>}
                      </div>
                    </div>

                    <div className="editor-actions">
                      <button className="icon-btn-sm" title={t.common.save} onClick={saveDraft}>
                        <Save size={16} strokeWidth={2} />
                      </button>
                      <button
                        className="icon-btn-sm danger"
                        title={t.common.delete}
                        onClick={deleteCurrent}
                      >
                        <Trash2 size={16} strokeWidth={2} />
                      </button>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </>
        ) : null}

        {section === 'proxies' ? (
          <>
            <div className="connections-header">
              <div className="connections-title">{t.connections.proxy}</div>
              <div className="connections-actions">
                <button className="icon-btn-sm" title={t.common.add} onClick={startNewProxy}>
                  <Plus size={16} strokeWidth={2} />
                </button>
              </div>
            </div>
            <div className="connections-split">
              <div className="connections-table">
                <div className="connections-row header">
                  <div className="connections-row-main header-main">
                    <div>{t.common.name}</div>
                    <div>{t.common.host}</div>
                    <div>{t.common.port}</div>
                    <div>{t.connections.type}</div>
                  </div>
                  <div className="row-icon header-icon" aria-hidden="true" />
                </div>
                {proxies.map((c) => (
                  <div key={c.id} className={editingId === c.id ? 'connections-row is-active' : 'connections-row'}>
                    <button className="connections-row-main" onClick={() => startEdit(c)} title={t.common.edit}>
                      <div>{c.name}</div>
                      <div>{c.host}</div>
                      <div>{c.port}</div>
                      <div>{c.type}</div>
                    </button>
                    <button className="row-icon" title={t.common.edit} onClick={() => startEdit(c)}>
                      <Pencil size={14} strokeWidth={2} />
                    </button>
                  </div>
                ))}
                {!proxies.length ? <div className="connections-empty">No Proxies defined.</div> : null}
              </div>
              <div className="connections-editor">
                {!draft ? (
                  <div className="editor-empty">{t.common.selectOrCreate}</div>
                ) : (
                  <div className="editor-card">
                    <div className="editor-row">
                      <span className="editor-icon"><Shield size={16} /></span>
                      <input
                        className="editor-input"
                        placeholder={t.common.name}
                        value={draft.name ?? ''}
                        onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                      />
                    </div>
                    <div className="editor-row">
                      <span className="editor-icon"><Server size={16} /></span>
                      <select
                        className="editor-select"
                        value={draft.type ?? 'socks5'}
                        onChange={(e) => setDraft({ ...draft, type: e.target.value })}
                      >
                        <option value="socks5">SOCKS5</option>
                        <option value="http">HTTP</option>
                      </select>
                    </div>
                    <div className="editor-row">
                      <span className="editor-icon"><Server size={16} /></span>
                      <input
                        className="editor-input"
                        placeholder={t.common.host}
                        value={draft.host ?? ''}
                        onChange={(e) => setDraft({ ...draft, host: e.target.value })}
                      />
                    </div>
                    <div className="editor-row">
                      <span className="editor-icon"><Server size={16} /></span>
                      <input
                        className="editor-input"
                        placeholder={t.common.port}
                        value={String(draft.port ?? 1080)}
                        onChange={(e) => setDraft({ ...draft, port: e.target.value })}
                      />
                    </div>
                    <div className="editor-row">
                      <span className="editor-icon"><Shield size={16} /></span>
                      <input
                        className="editor-input"
                        placeholder={t.connections.username}
                        value={draft.username ?? ''}
                        onChange={(e) => setDraft({ ...draft, username: e.target.value })}
                      />
                    </div>
                    <div className="editor-row">
                      <span className="editor-icon"><LockKeyhole size={16} /></span>
                      <input
                        type="password"
                        className="editor-input"
                        placeholder={t.common.password}
                        value={draft.password ?? ''}
                        onChange={(e) => setDraft({ ...draft, password: e.target.value })}
                      />
                    </div>
                    <div className="editor-actions">
                      <button className="icon-btn-sm" title={t.common.save} onClick={saveDraft}><Save size={16} /></button>
                      <button className="icon-btn-sm danger" title={t.common.delete} onClick={deleteCurrent}><Trash2 size={16} /></button>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </>
        ) : null}

        {section === 'tunnels' ? (
          <>
            <div className="connections-header">
              <div className="connections-title">{t.connections.tunnels}</div>
              <div className="connections-actions">
                <button className="icon-btn-sm" title={t.common.add} onClick={startNewTunnel}>
                  <Plus size={16} strokeWidth={2} />
                </button>
              </div>
            </div>
            <div className="connections-split">
              <div className="connections-table">
                <div className="connections-row header">
                  <div className="connections-row-main header-main is-tunnel">
                    <div>{t.common.name}</div>
                    <div>{t.connections.type}</div>
                    <div>{t.common.host}:{t.common.port}</div>
                    <div>{t.connections.targetHost}</div>
                  </div>
                  <div className="row-icon header-icon" aria-hidden="true" />
                </div>
                {tunnels.map((c: TunnelEntry) => (
                  <div key={c.id} className={editingId === c.id ? 'connections-row is-active' : 'connections-row'}>
                    <button className="connections-row-main is-tunnel" onClick={() => startEdit(c)} title={t.common.edit}>
                      <div>{c.name}</div>
                      <div>{c.type}</div>
                      <div>{c.host}:{c.port}</div>
                      <div>{c.type === PortForwardType.Dynamic ? 'SOCKS proxy' : `${c.targetAddress}:${c.targetPort}`}</div>
                    </button>
                    <button className="row-icon" title={t.common.edit} onClick={() => startEdit(c)}>
                      <Pencil size={14} strokeWidth={2} />
                    </button>
                  </div>
                ))}
                {!tunnels.length ? <div className="connections-empty">No Tunnels defined.</div> : null}
              </div>
              <div className="connections-editor">
                {!draft ? (
                  <div className="editor-empty">{t.common.selectOrCreate}</div>
                ) : (
                  <div className="editor-card">
                    <div className="editor-row">
                      <span className="editor-icon"><Waypoints size={16} /></span>
                      <input
                        className="editor-input"
                        placeholder={t.common.name}
                        value={draft.name ?? ''}
                        onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                      />
                    </div>

                    <div className="editor-row">
                      <span className="editor-icon"><Server size={16} /></span>
                      <select
                        className="editor-select"
                        value={draft.type ?? PortForwardType.Local}
                        onChange={(e) => setDraft({ ...draft, type: e.target.value as PortForwardType })}
                      >
                        <option value={PortForwardType.Local}>Local</option>
                        <option value={PortForwardType.Remote}>Remote</option>
                        <option value={PortForwardType.Dynamic}>Dynamic</option>
                      </select>
                    </div>

                    <div className="editor-row">
                      <span className="editor-icon"><Server size={16} /></span>
                      <input
                        className="editor-input"
                        placeholder={t.common.host}
                        value={draft.host ?? '127.0.0.1'}
                        onChange={(e) => setDraft({ ...draft, host: e.target.value })}
                      />
                    </div>
                    <div className="editor-row">
                      <span className="editor-icon"><Server size={16} /></span>
                      <input
                        className="editor-input"
                        placeholder={t.common.port}
                        value={String(draft.port ?? 8080)}
                        onChange={(e) => setDraft({ ...draft, port: parseInt(e.target.value) || 8080 })}
                      />
                    </div>

                    {draft.type !== PortForwardType.Dynamic && (
                      <>
                        <div className="editor-row">
                          <span className="editor-icon"><Server size={16} /></span>
                          <input
                            className="editor-input"
                            placeholder={t.connections.targetHost}
                            value={draft.targetAddress ?? '127.0.0.1'}
                            onChange={(e) => setDraft({ ...draft, targetAddress: e.target.value })}
                          />
                        </div>
                        <div className="editor-row">
                          <span className="editor-icon"><Server size={16} /></span>
                          <input
                            className="editor-input"
                            placeholder={t.connections.targetPort}
                            value={String(draft.targetPort ?? 80)}
                            onChange={(e) => setDraft({ ...draft, targetPort: parseInt(e.target.value) || 80 })}
                          />
                        </div>
                      </>
                    )}

                    {draft.type === PortForwardType.Dynamic && (
                      <div className="editor-row">
                        <span className="editor-icon"><Shield size={16} /></span>
                        <div className="editor-input" style={{ backgroundColor: 'var(--bg-secondary)', padding: '8px' }}>
                          SOCKS proxy
                        </div>
                      </div>
                    )}

                    <div className="editor-actions">
                      <button className="icon-btn-sm" title={t.common.save} onClick={saveDraft}><Save size={16} /></button>
                      <button className="icon-btn-sm danger" title={t.common.delete} onClick={deleteCurrent}><Trash2 size={16} /></button>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </>
        ) : null}
      </div>
    </div>
  )
})


