import React, { useMemo, useState } from 'react'
import { ArrowLeft, Cpu, Palette, Settings, Plus, Trash2, X, Key, Globe, Box, Tag, Shield, Image, Loader2, Wrench, RefreshCw, BookOpenText } from 'lucide-react'
import { observer } from 'mobx-react-lite'
import type { AppStore } from '../../stores/AppStore'
import type { ModelDefinition } from '../../lib/ipcTypes'
import { BUILTIN_THEMES } from '../../theme/themes'
import type { AppTheme } from '../../theme/themes'
import './settings.scss'
import { ConfirmDialog } from '../Common/ConfirmDialog'
import { NumericInput } from '../Common/NumericInput'
import { InfoTooltip } from '../Common/InfoTooltip'
import { Select } from '../../platform/Select'

function ThemeTile(props: {
  active?: boolean
  theme: AppTheme
  onClick: () => void
}) {
  const { background, foreground, colors } = props.theme.terminal
  const previewColors = [foreground, colors[1], colors[2]]
  const displayName =
    props.theme.name.length > 13 ? `${props.theme.name.slice(0, 13)}...` : props.theme.name
  return (
    <button
      className={props.active ? 'theme-tile is-active' : 'theme-tile'}
      onClick={props.onClick}
      title={props.theme.name}
    >
      <div className="theme-preview" style={{ background }}>
        <div className="theme-preview-swatches">
          {previewColors.map((color, idx) => (
            <span key={`${props.theme.id}-swatch-${idx}`} style={{ background: color }} />
          ))}
        </div>
      </div>
      <div className="theme-tile-content">
        <span className="theme-tile-title">{displayName}</span>
      </div>
    </button>
  )
}

const RULES_PREVIEW_LIMIT = 28

function RuleChipList(props: {
  t: any
  rules: string[]
  onDelete: (rule: string) => void
}) {
  const { t, rules, onDelete } = props
  const [expanded, setExpanded] = useState(false)
  const visible = expanded ? rules : rules.slice(0, RULES_PREVIEW_LIMIT)
  const remaining = Math.max(0, rules.length - visible.length)

  return (
    <div className="cp-rule-block">
      <div className="cp-chips" role="list">
        {visible.map((rule) => (
          <div key={rule} className="cp-chip" role="listitem" data-full={rule} aria-label={rule}>
            <span className="cp-chip-text">{rule}</span>
            <button
              className="cp-chip-delete"
              title={t.common.delete}
              onClick={() => onDelete(rule)}
            >
              <Trash2 size={12} />
            </button>
          </div>
        ))}
        {rules.length === 0 ? <div className="tool-empty">{t.settings.noCommandPolicyRules}</div> : null}
      </div>
      {rules.length > RULES_PREVIEW_LIMIT ? (
        <button className="cp-expand" onClick={() => setExpanded(!expanded)}>
          {expanded ? t.common.showLess : `${t.common.showMore} (+${remaining})`}
        </button>
      ) : null}
    </div>
  )
}

const ModelEditor = observer(({ store, modelId, onClose }: { store: AppStore; modelId?: string; onClose: () => void }) => {
    const t = store.i18n.t
    const existing = store.settings?.models.items.find(m => m.id === modelId)
    
    const [draft, setDraft] = useState<ModelDefinition>(() => {
        if (existing) {
            return {
                ...existing,
                maxTokens: typeof existing.maxTokens === 'number' ? existing.maxTokens : 200000
            }
        }
        return {
            id: `model-${Date.now()}`,
            name: '',
            model: '',
            baseUrl: '',
            apiKey: '',
            maxTokens: 200000
        }
    })
    const [isSaving, setIsSaving] = useState(false)

    const save = async () => {
        setIsSaving(true)
        try {
            await store.saveModel(draft)
            onClose()
        } finally {
            setIsSaving(false)
        }
    }

    return (
        <div className="model-editor-overlay">
            <div className="model-editor-card">
                <div className="editor-header">
                    <h3>{modelId ? t.settings.editModel : t.settings.addModel}</h3>
                    <button className="icon-btn-sm" onClick={onClose} disabled={isSaving}><X size={16} /></button>
                </div>
                <div className="editor-body">
                    {/* SSH-style compact rows: icon + input (no separate label) */}
                    <div className="editor-row">
                      <span className="editor-icon">
                        <Tag size={16} strokeWidth={2} />
                      </span>
                      <input
                        className="editor-input"
                        placeholder={t.common.name}
                        value={draft.name}
                        onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                        disabled={isSaving}
                      />
                    </div>
                    <div className="editor-row">
                      <span className="editor-icon">
                        <Box size={16} strokeWidth={2} />
                      </span>
                      <input
                        className="editor-input"
                        placeholder={t.settings.providerModel}
                        value={draft.model}
                        onChange={(e) => setDraft({ ...draft, model: e.target.value })}
                        disabled={isSaving}
                      />
                    </div>
                    <div className="editor-row">
                      <span className="editor-icon">
                        <Globe size={16} strokeWidth={2} />
                      </span>
                      <input
                        className="editor-input"
                        placeholder={`${t.settings.baseUrl} (${t.common.edit})`}
                        value={draft.baseUrl || ''}
                        onChange={(e) => setDraft({ ...draft, baseUrl: e.target.value })}
                        disabled={isSaving}
                      />
                    </div>
                    <div className="editor-row">
                      <span className="editor-icon">
                        <Key size={16} strokeWidth={2} />
                      </span>
                      <input
                        type="password"
                        className="editor-input"
                        placeholder={`${t.settings.apiKey} (${t.common.edit})`}
                        value={draft.apiKey || ''}
                        onChange={(e) => setDraft({ ...draft, apiKey: e.target.value })}
                        disabled={isSaving}
                      />
                    </div>
                    <div className="editor-row">
                      <span className="editor-icon">
                        <Loader2 size={16} strokeWidth={2} />
                      </span>
                      <NumericInput
                        className="editor-input"
                        placeholder={t.settings.maxTokensPlaceholder}
                        value={draft.maxTokens}
                        onChange={(val) => setDraft({ ...draft, maxTokens: val })}
                        disabled={isSaving}
                        min={0}
                      />
                    </div>
                </div>
                <div className="editor-footer">
                    <button className="btn-secondary" onClick={onClose} disabled={isSaving}>{t.common.cancel}</button>
                    <button className="btn-primary" onClick={save} disabled={!draft.name || !draft.model || isSaving}>
                        {isSaving ? <Loader2 size={16} className="spin" /> : t.common.save}
                    </button>
                </div>
            </div>
        </div>
    )
})

export const SettingsView: React.FC<{ store: AppStore }> = observer(({ store }) => {
  const t = store.i18n.t
  const [editingModelId, setEditingModelId] = useState<string | null>(null)
  const [showModelEditor, setShowModelEditor] = useState(false)

  const [cpDraft, setCpDraft] = useState<{ allowlist: string; denylist: string; asklist: string }>({
    allowlist: '',
    denylist: '',
    asklist: ''
  })

  const cpLists = useMemo(() => store.commandPolicyLists, [store.commandPolicyLists])

  const openModelEditor = (id?: string) => {
      setEditingModelId(id || null)
      setShowModelEditor(true)
  }

  const [deleteConfirm, setDeleteConfirm] = useState<null | { kind: 'model' | 'profile'; id: string }>(null)
  const [deleteSkillConfirm, setDeleteSkillConfirm] = useState<null | { fileName: string }>(null)

  return (
    <div className="settings">
      <ConfirmDialog
        open={!!deleteConfirm}
        title={t.common.confirmDeleteTitle}
        message={deleteConfirm?.kind === 'profile' ? t.common.confirmDeleteProfile : t.common.confirmDeleteModel}
        confirmText={t.common.delete}
        cancelText={t.common.cancel}
        danger
        onCancel={() => setDeleteConfirm(null)}
        onConfirm={() => {
          if (!deleteConfirm) return
          if (deleteConfirm.kind === 'model') void store.deleteModel(deleteConfirm.id)
          else void store.deleteProfile(deleteConfirm.id)
          setDeleteConfirm(null)
        }}
      />
      <ConfirmDialog
        open={!!deleteSkillConfirm}
        title={t.common.confirmDeleteTitle}
        message={t.common.confirmDeleteConfig}
        confirmText={t.common.delete}
        cancelText={t.common.cancel}
        danger
        onCancel={() => setDeleteSkillConfirm(null)}
        onConfirm={() => {
          if (!deleteSkillConfirm) return
          void store.deleteSkill(deleteSkillConfirm.fileName)
          setDeleteSkillConfirm(null)
        }}
      />

      {showModelEditor && (
          <ModelEditor 
            store={store} 
            modelId={editingModelId || undefined} 
            onClose={() => setShowModelEditor(false)} 
          />
      )}
      
      <div className="settings-sidebar">
        <button className="settings-back-btn" onClick={() => store.closeOverlay()} title={t.common.back}>
          <ArrowLeft size={16} strokeWidth={2} />
        </button>
        
        <div className="settings-nav">
          <div
            className={store.settingsSection === 'general' ? 'settings-nav-item is-active' : 'settings-nav-item'}
            onClick={() => store.setSettingsSection('general')}
            role="button"
            tabIndex={0}
          >
            <span className="icon">
              <Settings size={16} strokeWidth={2} />
            </span>
            <span>{t.settings.general}</span>
          </div>
          <div
            className={store.settingsSection === 'theme' ? 'settings-nav-item is-active' : 'settings-nav-item'}
            onClick={() => store.setSettingsSection('theme')}
            role="button"
            tabIndex={0}
          >
            <span className="icon">
              <Palette size={16} strokeWidth={2} />
            </span>
            <span>{t.settings.theme}</span>
          </div>
          <div
            className={store.settingsSection === 'models' ? 'settings-nav-item is-active' : 'settings-nav-item'}
            onClick={() => store.setSettingsSection('models')}
            role="button"
            tabIndex={0}
          >
            <span className="icon">
              <Cpu size={16} strokeWidth={2} />
            </span>
            <span>{t.settings.models}</span>
          </div>
          <div
            className={store.settingsSection === 'security' ? 'settings-nav-item is-active' : 'settings-nav-item'}
            onClick={() => store.setSettingsSection('security')}
            role="button"
            tabIndex={0}
          >
            <span className="icon">
              <Shield size={16} strokeWidth={2} />
            </span>
            <span>{t.settings.security}</span>
          </div>
          <div
            className={store.settingsSection === 'tools' ? 'settings-nav-item is-active' : 'settings-nav-item'}
            onClick={() => store.setSettingsSection('tools')}
            role="button"
            tabIndex={0}
          >
            <span className="icon">
              <Wrench size={16} strokeWidth={2} />
            </span>
            <span>{t.settings.tools}</span>
          </div>
          <div
            className={store.settingsSection === 'skills' ? 'settings-nav-item is-active' : 'settings-nav-item'}
            onClick={() => store.setSettingsSection('skills')}
            role="button"
            tabIndex={0}
          >
            <span className="icon">
              <BookOpenText size={16} strokeWidth={2} />
            </span>
            <span>{t.settings.skills}</span>
          </div>
        </div>
      </div>
      <div className="settings-content">
        <div className="settings-section">
          {store.settingsSection === 'general' ? (
            <>
              <div className="settings-section-title">{t.settings.general}</div>
              <div className="settings-rows">
                <div className="settings-row">
                  <label>{t.settings.language}</label>
                  <Select
                    className="settings-native-select"
                    value={store.i18n.locale}
                    onChange={(v) => store.setLanguage(v as any)}
                    options={[
                      { value: 'en', label: 'English' },
                      { value: 'zh-CN', label: '简体中文' }
                    ]}
                  />
                </div>
              </div>

              <div className="settings-section-title" style={{ marginTop: 24 }}>{t.settings.terminal}</div>
              <div className="settings-rows">
                <div className="settings-row">
                  <label>{t.settings.fontSize}</label>
                  <NumericInput
                    className="settings-inline-input"
                    style={{ width: 80 }}
                    value={store.settings?.terminal?.fontSize || 14}
                    onChange={(val) => store.setTerminalSettings({ fontSize: val })}
                    min={6}
                    max={100}
                  />
                </div>
                <div className="settings-row">
                  <label>{t.settings.lineHeight}</label>
                  <NumericInput
                    className="settings-inline-input"
                    style={{ width: 80 }}
                    value={store.settings?.terminal?.lineHeight || 1.2}
                    onChange={(val) => store.setTerminalSettings({ lineHeight: val })}
                    allowFloat
                    min={1}
                    max={5}
                  />
                </div>
                <div className="settings-row">
                  <label>{t.settings.scrollback}</label>
                  <NumericInput
                    className="settings-inline-input"
                    style={{ width: 80 }}
                    value={store.settings?.terminal?.scrollback || 5000}
                    onChange={(val) => store.setTerminalSettings({ scrollback: val })}
                    min={0}
                    max={1000000}
                  />
                </div>
                <div className="settings-row">
                  <label>{t.settings.cursorStyle}</label>
                  <Select
                    className="settings-native-select"
                    value={store.settings?.terminal?.cursorStyle || 'block'}
                    onChange={(v) => store.setTerminalSettings({ cursorStyle: v as any })}
                    options={[
                      { value: 'block', label: t.settings.cursorStyles.block },
                      { value: 'underline', label: t.settings.cursorStyles.underline },
                      { value: 'bar', label: t.settings.cursorStyles.bar }
                    ]}
                  />
                </div>
                <div className="settings-row">
                  <label>{t.settings.cursorBlink}</label>
                  <label className="switch">
                    <input
                      type="checkbox"
                      checked={store.settings?.terminal?.cursorBlink ?? true}
                      onChange={(e) => store.setTerminalSettings({ cursorBlink: e.target.checked })}
                    />
                    <span className="switch-slider" />
                  </label>
                </div>
                <div className="settings-row">
                  <label>{t.settings.copyOnSelect}</label>
                  <label className="switch">
                    <input
                      type="checkbox"
                      checked={store.settings?.terminal?.copyOnSelect ?? false}
                      onChange={(e) => store.setTerminalSettings({ copyOnSelect: e.target.checked })}
                    />
                    <span className="switch-slider" />
                  </label>
                </div>
                <div className="settings-row">
                  <label>{t.settings.rightClickToPaste}</label>
                  <label className="switch">
                    <input
                      type="checkbox"
                      checked={store.settings?.terminal?.rightClickToPaste ?? false}
                      onChange={(e) => store.setTerminalSettings({ rightClickToPaste: e.target.checked })}
                    />
                    <span className="switch-slider" />
                  </label>
                </div>
              </div>
            </>
          ) : null}

          {store.settingsSection === 'theme' ? (
            <>
              <div className="settings-section-header">
                <div className="settings-section-title">{t.settings.theme}</div>
                <div className="settings-actions">
                  <button className="btn-secondary" onClick={() => store.openCustomThemeFile()}>
                    {t.settings.openCustomThemes}
                  </button>
                  <button
                    className="btn-icon-reload"
                    onClick={() => store.reloadCustomThemes()}
                    title={t.settings.reloadCustomThemes}
                  >
                    <RefreshCw size={14} />
                  </button>
                </div>
              </div>
              <div className="theme-grid">
                <div className="theme-divider">
                  <span>{t.settings.themeSectionCustom}</span>
                  <i />
                </div>
                {store.customThemes.map((theme) => (
                  <ThemeTile
                    key={`custom-${theme.name}`}
                    theme={{ id: theme.name, name: theme.name, terminal: theme }}
                    active={store.settings?.themeId === theme.name}
                    onClick={() => store.setThemeId(theme.name)}
                  />
                ))}
                <div className="theme-divider">
                  <span>{t.settings.themeSectionBuiltIn}</span>
                  <i />
                </div>
                {BUILTIN_THEMES.map((theme) => (
                  <ThemeTile
                    key={`builtin-${theme.id}`}
                    theme={theme}
                    active={store.settings?.themeId === theme.id}
                    onClick={() => store.setThemeId(theme.id)}
                  />
                ))}
              </div>
            </>
          ) : null}

          {store.settingsSection === 'models' ? (
            <>
              <div className="settings-section-header">
                  <div className="settings-section-title">{t.settings.baseModels}</div>
                  <button className="icon-btn-sm" title={t.common.add} onClick={() => openModelEditor()}>
                      <Plus size={16} strokeWidth={2} />
                  </button>
              </div>
              
              <div className="models-list">
                {store.settings?.models.items.map((item) => (
                  <div key={item.id} className="model-item" onClick={() => openModelEditor(item.id)}>
                    <div className="model-icon"><Box size={16} /></div>
                    <div className="model-info">
                        <div className="model-name">{item.name}</div>
                        <div className="model-id">{item.model}</div>
                    </div>
                    <div className="model-meta">
                        {item.profile?.ok ? (
                            <span className="tag active">Active</span>
                        ) : (
                            <span className="tag inactive">NoActive</span>
                        )}
                        {item.profile?.imageInputs ? (
                            <span className="tag image"><Image size={10} /> Image</span>
                        ) : null}
                    </div>
                    <button 
                        className="model-delete-btn"
                        onClick={(e) => { e.stopPropagation(); setDeleteConfirm({ kind: 'model', id: item.id }) }}
                    >
                        <Trash2 size={14} />
                    </button>
                  </div>
                ))}
              </div>

              <div className="settings-section-title" style={{ marginTop: 32 }}>
                {t.settings.profiles}
              </div>
              
              <div className="profiles-grid">
                {store.settings?.models.profiles.map((p) => {
                  const isActive = store.settings?.models.activeProfileId === p.id
                  return (
                    <div key={p.id} className={`profile-card ${isActive ? 'active' : ''}`}>
                      <div className="profile-header">
                        <div 
                            className={`radio-check ${isActive ? 'checked' : ''}`}
                            onClick={() => store.setActiveProfile(p.id)}
                        />
                        <input
                          className="profile-name-input"
                          value={p.name}
                          onChange={(e) => store.saveProfile({ ...p, name: e.target.value })}
                          placeholder={t.settings.profileName}
                        />
                        <button
                          className="icon-btn-sm danger"
                          onClick={() => setDeleteConfirm({ kind: 'profile', id: p.id })}
                          disabled={store.settings?.models.profiles.length === 1}
                        >
                          <Trash2 size={14} />
                        </button>
                      </div>

                      <div className="profile-body">
                        <div className="profile-field">
                          <label>{t.settings.globalModel}</label>
                          <select
                            value={p.globalModelId}
                            onChange={(e) => store.saveProfile({ ...p, globalModelId: e.target.value })}
                          >
                            {store.settings?.models.items.map((m) => (
                              <option key={m.id} value={m.id}>{m.name}</option>
                            ))}
                          </select>
                        </div>
                        <div className="profile-field">
                          <label>{t.settings.actionModel}</label>
                          <select
                            value={p.actionModelId || ''}
                            onChange={(e) => store.saveProfile({ ...p, actionModelId: e.target.value || undefined })}
                          >
                            <option value="">(None)</option>
                            {store.settings?.models.items.map((m) => (
                              <option key={m.id} value={m.id}>{m.name}</option>
                            ))}
                          </select>
                        </div>
                        <div className="profile-field">
                          <label>{t.settings.thinkingModel}</label>
                          <select
                            value={p.thinkingModelId || ''}
                            onChange={(e) => store.saveProfile({ ...p, thinkingModelId: e.target.value || undefined })}
                          >
                            <option value="">(None)</option>
                            {store.settings?.models.items.map((m) => (
                              <option key={m.id} value={m.id}>{m.name}</option>
                            ))}
                          </select>
                        </div>
                      </div>
                    </div>
                  )
                })}
                <button 
                    className="add-profile-btn"
                    onClick={() => {
                      const id = `profile-${Date.now()}`
                      const firstModel = store.settings?.models.items[0]?.id || ''
                      store.saveProfile({
                        id,
                        name: 'New Profile',
                        globalModelId: firstModel
                      })
                      store.setActiveProfile(id)
                    }}
                >
                    <Plus size={16} />
                    <span>New Profile</span>
                </button>
              </div>
            </>
          ) : null}

          {store.settingsSection === 'security' ? (
            <>
              <div className="settings-section-header">
                <div className="settings-section-title">{t.settings.security}</div>
                <div className="settings-actions">
                  <button className="btn-secondary" onClick={() => store.openCommandPolicyFile()}>
                    {t.settings.editCommandPolicyFile}
                  </button>
                  <button
                    className="btn-icon-reload"
                    onClick={() => store.loadCommandPolicyLists()}
                    title={t.common.refresh}
                  >
                    <RefreshCw size={14} />
                  </button>
                </div>
              </div>
              <div className="settings-rows">
                <div className="settings-row">
                  <div className="settings-row-label-with-info">
                    <label>{t.settings.commandPolicyMode}</label>
                    <InfoTooltip 
                      content={
                        <div className="mode-descriptions">
                          <p><strong>{t.settings.commandPolicyModes.safe}</strong>: {t.settings.commandPolicyModeDesc.safe}</p>
                          <p><strong>{t.settings.commandPolicyModes.standard}</strong>: {t.settings.commandPolicyModeDesc.standard}</p>
                          <p><strong>{t.settings.commandPolicyModes.smart}</strong>: {t.settings.commandPolicyModeDesc.smart}</p>
                        </div>
                      }
                    />
                  </div>
                  <div className="settings-radio-group">
                    {(['safe', 'standard', 'smart'] as const).map((mode) => (
                      <label key={mode} className="settings-radio-item">
                        <input
                          type="radio"
                          name="command-policy-mode"
                          value={mode}
                          checked={store.settings?.commandPolicyMode === mode}
                          onChange={() => store.setCommandPolicyMode(mode)}
                        />
                        <span>{t.settings.commandPolicyModes[mode]}</span>
                      </label>
                    ))}
                  </div>
                </div>
              </div>

              <div className="settings-divider settings-divider-spaced">
                <span>{t.settings.commandPolicyAllowlist}</span>
                <i />
              </div>
              <div className="settings-subsection-header">
                <InfoTooltip content={t.settings.commandPolicyRuleDesc} />
                <input
                  className="settings-inline-input"
                  placeholder={t.settings.commandPolicyAddRulePlaceholder}
                  value={cpDraft.allowlist}
                  onChange={(e) => setCpDraft({ ...cpDraft, allowlist: e.target.value })}
                />
                <button
                  className="icon-btn-sm"
                  title={t.common.add}
                  onClick={() => {
                    void store.addCommandPolicyRule('allowlist', cpDraft.allowlist)
                    setCpDraft({ ...cpDraft, allowlist: '' })
                  }}
                >
                  <Plus size={16} strokeWidth={2} />
                </button>
              </div>
              <RuleChipList
                t={t}
                rules={cpLists.allowlist}
                onDelete={(rule) => void store.deleteCommandPolicyRule('allowlist', rule)}
              />

              <div className="settings-divider settings-divider-spaced">
                <span>{t.settings.commandPolicyDenylist}</span>
                <i />
              </div>
              <div className="settings-subsection-header">
                <InfoTooltip content={t.settings.commandPolicyRuleDesc} />
                <input
                  className="settings-inline-input"
                  placeholder={t.settings.commandPolicyAddRulePlaceholder}
                  value={cpDraft.denylist}
                  onChange={(e) => setCpDraft({ ...cpDraft, denylist: e.target.value })}
                />
                <button
                  className="icon-btn-sm"
                  title={t.common.add}
                  onClick={() => {
                    void store.addCommandPolicyRule('denylist', cpDraft.denylist)
                    setCpDraft({ ...cpDraft, denylist: '' })
                  }}
                >
                  <Plus size={16} strokeWidth={2} />
                </button>
              </div>
              <RuleChipList
                t={t}
                rules={cpLists.denylist}
                onDelete={(rule) => void store.deleteCommandPolicyRule('denylist', rule)}
              />

              <div className="settings-divider settings-divider-spaced">
                <span>{t.settings.commandPolicyAsklist}</span>
                <i />
              </div>
              <div className="settings-subsection-header">
                <InfoTooltip content={t.settings.commandPolicyRuleDesc} />
                <input
                  className="settings-inline-input"
                  placeholder={t.settings.commandPolicyAddRulePlaceholder}
                  value={cpDraft.asklist}
                  onChange={(e) => setCpDraft({ ...cpDraft, asklist: e.target.value })}
                />
                <button
                  className="icon-btn-sm"
                  title={t.common.add}
                  onClick={() => {
                    void store.addCommandPolicyRule('asklist', cpDraft.asklist)
                    setCpDraft({ ...cpDraft, asklist: '' })
                  }}
                >
                  <Plus size={16} strokeWidth={2} />
                </button>
              </div>
              <RuleChipList
                t={t}
                rules={cpLists.asklist}
                onDelete={(rule) => void store.deleteCommandPolicyRule('asklist', rule)}
              />
            </>
          ) : null}

          {store.settingsSection === 'tools' ? (
            <>
              <div className="settings-section-title">{t.settings.tools}</div>
              <div className="settings-subsection-header">
                <div className="settings-divider">
                  <span>{t.settings.mcpConfig}</span>
                  <i />
                </div>
                <div className="settings-actions">
                  <button className="btn-secondary" onClick={() => store.openMcpConfig()}>
                    {t.settings.editMcpConfig}
                  </button>
                  <button
                    className="btn-icon-reload"
                    onClick={() => store.reloadMcpTools()}
                    title={t.settings.reloadMcpTools}
                  >
                    <RefreshCw size={14} />
                  </button>
                </div>
              </div>
              <div className="tools-list">
                {store.mcpTools.map((tool) => {
                  const statusClass =
                    !tool.enabled ? 'is-disabled' : tool.status === 'connected' ? 'is-ok' : tool.status === 'error' ? 'is-error' : 'is-pending'
                  return (
                    <div key={tool.name} className="tool-item">
                      <div className="tool-info">
                        <div className="tool-name">{tool.name}</div>
                        <div className="tool-meta">
                          {tool.toolCount !== undefined ? `${tool.toolCount} ${t.settings.toolsCount}` : t.settings.toolsUnknown}
                        </div>
                        {tool.error ? <div className="tool-error">{tool.error}</div> : null}
                      </div>
                      <div className="tool-actions">
                        <span className={`status-dot ${statusClass}`} />
                        <label className="switch">
                          <input
                            type="checkbox"
                            checked={tool.enabled}
                            onChange={(e) => store.setMcpToolEnabled(tool.name, e.target.checked)}
                          />
                          <span className="switch-slider" />
                        </label>
                      </div>
                    </div>
                  )
                })}
                {store.mcpTools.length === 0 ? <div className="tool-empty">{t.settings.noMcpTools}</div> : null}
              </div>

              <div className="settings-divider settings-divider-spaced">
                <span>{t.settings.builtInTools}</span>
                <i />
              </div>
              <div className="tools-list">
                {store.builtInTools.map((tool) => (
                  <div key={tool.name} className="tool-item">
                    <div className="tool-info">
                      <div className="tool-name">{tool.name}</div>
                      <div className="tool-meta">{tool.description || ''}</div>
                    </div>
                    <div className="tool-actions">
                      <span className={`status-dot ${tool.enabled ? 'is-ok' : 'is-disabled'}`} />
                      <label className="switch">
                        <input
                          type="checkbox"
                          checked={tool.enabled}
                          onChange={(e) => store.setBuiltInToolEnabled(tool.name, e.target.checked)}
                        />
                        <span className="switch-slider" />
                      </label>
                    </div>
                  </div>
                ))}
                {store.builtInTools.length === 0 ? <div className="tool-empty">{t.settings.noBuiltInTools}</div> : null}
              </div>
            </>
          ) : null}

          {store.settingsSection === 'skills' ? (
            <>
              <div className="settings-section-header">
                <div className="settings-section-title">{t.settings.skills}</div>
                <div className="settings-actions">
                  <button className="btn-secondary" onClick={() => store.openSkillsFolder()}>
                    {t.settings.openSkillsFolder}
                  </button>
                  <button className="icon-btn-sm" title={t.settings.addSkill} onClick={() => store.createSkill()}>
                    <Plus size={16} strokeWidth={2} />
                  </button>
                  <button
                    className="btn-icon-reload"
                    onClick={() => store.reloadSkills()}
                    title={t.settings.reloadSkills}
                  >
                    <RefreshCw size={14} />
                  </button>
                </div>
              </div>

              <div className="settings-divider">
                <span>{t.settings.skills}</span>
                <i />
              </div>
              <div className="tools-list">
                {store.skills.map((s) => (
                  <div key={s.fileName} className="tool-item">
                    <div className="tool-info">
                      <div className="tool-name">{s.name}</div>
                      <div className="tool-meta">{s.description}</div>
                    </div>
                    <div className="tool-actions">
                      <button className="icon-btn-sm" title={t.common.edit} onClick={() => store.editSkill(s.fileName)}>
                        <Tag size={14} />
                      </button>
                      <button
                        className="icon-btn-sm danger"
                        title={t.common.delete}
                        onClick={() => setDeleteSkillConfirm({ fileName: s.fileName })}
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  </div>
                ))}
                {store.skills.length === 0 ? <div className="tool-empty">{t.settings.noSkills}</div> : null}
              </div>
            </>
          ) : null}
        </div>
      </div>
    </div>
  )
})



