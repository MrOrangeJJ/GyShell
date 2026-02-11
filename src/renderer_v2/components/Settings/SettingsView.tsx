import React, { useMemo, useState } from 'react'
import { ArrowLeft, Cpu, Palette, Settings, Plus, Trash2, X, Key, Globe, Box, Tag, Shield, Image, Loader2, Wrench, RefreshCw, BookOpenText, Pencil, Info, AlertTriangle } from 'lucide-react'
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
  const versionInfo = store.versionInfo
  const formattedCheckedAt =
    versionInfo?.checkedAt && versionInfo.checkedAt > 0
      ? new Date(versionInfo.checkedAt).toLocaleString()
      : '-'

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
          <div
            className={store.settingsSection === 'version' ? 'settings-nav-item is-active' : 'settings-nav-item'}
            onClick={() => store.setSettingsSection('version')}
            role="button"
            tabIndex={0}
          >
            <span className="icon">
              <Info size={16} strokeWidth={2} />
            </span>
            <span>{t.settings.version}</span>
          </div>
        </div>
      </div>
      <div className="settings-content">
        <div className="settings-section">
          {store.settingsSection === 'general' ? (
            <>
              <div className="settings-section-header">
                <div className="settings-section-title">
                  {t.settings.general}
                </div>
              </div>
              <div className="settings-rows">
                <div className="settings-row">
                  <div className="settings-row-label-with-info">
                    <label>{t.settings.language}</label>
                    <InfoTooltip content={t.settings.tooltips.language} />
                  </div>
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
                <div className="settings-row">
                  <div className="settings-row-label-with-info">
                    <label>{t.settings.recursionLimit}</label>
                    <InfoTooltip content={t.settings.tooltips.recursionLimit} />
                  </div>
                  <div className="settings-slider-container">
                    <input
                      type="range"
                      className="settings-slider"
                      min="100"
                      max="1010"
                      step="10"
                      value={store.settings?.recursionLimit === 2147483647 ? 1010 : (store.settings?.recursionLimit || 200)}
                      onChange={(e) => {
                        const val = parseInt(e.target.value)
                        store.setRecursionLimit(val === 1010 ? 2147483647 : val)
                      }}
                    />
                    <span className="settings-slider-value">
                      {store.settings?.recursionLimit === 2147483647 ? 'INF' : (store.settings?.recursionLimit || 200)}
                    </span>
                  </div>
                </div>
                <div className="settings-row">
                  <div className="settings-row-label-with-info">
                    <label>{t.settings.debugMode}</label>
                    <InfoTooltip content={t.settings.tooltips.debugMode} />
                  </div>
                  <label className="switch">
                    <input
                      type="checkbox"
                      checked={store.settings?.debugMode ?? false}
                      onChange={(e) => store.setDebugMode(e.target.checked)}
                    />
                    <span className="switch-slider" />
                  </label>
                </div>
              </div>

              <div className="settings-section-header" style={{ marginTop: 24 }}>
                <div className="settings-section-title">
                  {t.settings.experimentalFeatures}
                </div>
              </div>
              <div className="settings-rows">
                <div className="settings-row">
                  <div className="settings-row-label-with-info">
                    <label>{t.settings.runtimeThinkingCorrection}</label>
                    <InfoTooltip content={t.settings.tooltips.runtimeThinkingCorrection} />
                  </div>
                  <label className="switch">
                    <input
                      type="checkbox"
                      checked={store.settings?.experimental?.runtimeThinkingCorrectionEnabled !== false}
                      onChange={(e) => store.setRuntimeThinkingCorrectionEnabled(e.target.checked)}
                    />
                    <span className="switch-slider" />
                  </label>
                </div>
                <div className="settings-row">
                  <div className="settings-row-label-with-info">
                    <label>{t.settings.taskFinishGuard}</label>
                    <InfoTooltip content={t.settings.tooltips.taskFinishGuard} />
                  </div>
                  <label className="switch">
                    <input
                      type="checkbox"
                      checked={store.settings?.experimental?.taskFinishGuardEnabled !== false}
                      onChange={(e) => store.setTaskFinishGuardEnabled(e.target.checked)}
                    />
                    <span className="switch-slider" />
                  </label>
                </div>
                <div className="settings-row">
                  <div className="settings-row-label-with-info">
                    <label>{t.settings.firstTurnThinkingModel}</label>
                    <InfoTooltip content={t.settings.tooltips.firstTurnThinkingModel} />
                  </div>
                  <label className="switch">
                    <input
                      type="checkbox"
                      checked={store.settings?.experimental?.firstTurnThinkingModelEnabled === true}
                      onChange={(e) => store.setFirstTurnThinkingModelEnabled(e.target.checked)}
                    />
                    <span className="switch-slider" />
                  </label>
                </div>
              </div>

              <div className="settings-section-header" style={{ marginTop: 24 }}>
                <div className="settings-section-title">
                  {t.settings.terminal}
                </div>
              </div>
              <div className="settings-rows">
                <div className="settings-row">
                  <div className="settings-row-label-with-info">
                    <label>{t.settings.fontSize}</label>
                    <InfoTooltip content={t.settings.tooltips.fontSize} />
                  </div>
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
                  <div className="settings-row-label-with-info">
                    <label>{t.settings.lineHeight}</label>
                    <InfoTooltip content={t.settings.tooltips.lineHeight} />
                  </div>
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
                  <div className="settings-row-label-with-info">
                    <label>{t.settings.scrollback}</label>
                    <InfoTooltip content={t.settings.tooltips.scrollback} />
                  </div>
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
                  <div className="settings-row-label-with-info">
                    <label>{t.settings.cursorStyle}</label>
                    <InfoTooltip content={t.settings.tooltips.cursorStyle} />
                  </div>
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
                  <div className="settings-row-label-with-info">
                    <label>{t.settings.cursorBlink}</label>
                    <InfoTooltip content={t.settings.tooltips.cursorBlink} />
                  </div>
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
                  <div className="settings-row-label-with-info">
                    <label>{t.settings.copyOnSelect}</label>
                    <InfoTooltip content={t.settings.tooltips.copyOnSelect} />
                  </div>
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
                  <div className="settings-row-label-with-info">
                    <label>{t.settings.rightClickToPaste}</label>
                    <InfoTooltip content={t.settings.tooltips.rightClickToPaste} />
                  </div>
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
                  <InfoTooltip content={t.settings.tooltips.themeCustom}>
                    <button className="btn-secondary" onClick={() => store.openCustomThemeFile()}>
                      {t.settings.openCustomThemes}
                    </button>
                  </InfoTooltip>
                  <InfoTooltip content={t.settings.tooltips.themeReload}>
                    <button
                      className="btn-icon-reload"
                      onClick={() => store.reloadCustomThemes()}
                      title={t.settings.reloadCustomThemes}
                    >
                      <RefreshCw size={14} />
                    </button>
                  </InfoTooltip>
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
                  <div className="settings-section-title">
                    {t.settings.baseModels}
                    <InfoTooltip content={t.settings.tooltips.modelAdd} />
                  </div>
                  <button className="icon-btn-sm" title={t.common.add} onClick={() => openModelEditor()}>
                      <Plus size={16} strokeWidth={2} />
                  </button>
              </div>
              
              <div className="models-list">
                {store.settings?.models.items.map((item) => (
                  <div key={item.id} className="model-item" onClick={() => openModelEditor(item.id)}>
                    {/** Active: text probe passed. Stateless: text failed but /v1/models passed. */}
                    {(() => {
                      const isActive = Boolean(item.profile?.textOutputs)
                      const supportsImage = Boolean(item.profile?.imageInputs)
                      const isStateless =
                        Boolean(item.profile?.ok) &&
                        item.profile?.textOutputs === false &&
                        !supportsImage

                      return (
                        <>
                          <div className="model-icon"><Box size={16} /></div>
                          <div className="model-info">
                              <div className="model-name">{item.name}</div>
                              <div className="model-id">{item.model}</div>
                          </div>
                          <div className="model-meta">
                              {isActive ? (
                                  <span className="tag active">Active</span>
                              ) : isStateless ? (
                                  <span className="tag warning">Stateless</span>
                              ) : (
                                  <span className="tag inactive">NoActive</span>
                              )}
                              {supportsImage ? (
                                  <span className="tag image"><Image size={10} /> Image</span>
                              ) : null}
                          </div>
                        </>
                      )
                    })()}
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
                <InfoTooltip content={t.settings.tooltips.modelProfile} />
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
                          <Select
                            value={p.globalModelId}
                            onChange={(id) => store.saveProfile({ ...p, globalModelId: id })}
                            options={store.settings?.models.items.map((m) => ({ value: m.id, label: m.name })) || []}
                          />
                        </div>
                        <div className="profile-field">
                          <label>{t.settings.actionModel}</label>
                          <Select
                            value={p.actionModelId || ''}
                            onChange={(id) => store.saveProfile({ ...p, actionModelId: id || undefined })}
                            options={[
                              { value: '', label: '(None)' },
                              ...(store.settings?.models.items.map((m) => ({ value: m.id, label: m.name })) || [])
                            ]}
                          />
                        </div>
                        <div className="profile-field">
                          <label>{t.settings.thinkingModel}</label>
                          <Select
                            value={p.thinkingModelId || ''}
                            onChange={(id) => store.saveProfile({ ...p, thinkingModelId: id || undefined })}
                            options={[
                              { value: '', label: '(None)' },
                              ...(store.settings?.models.items.map((m) => ({ value: m.id, label: m.name })) || [])
                            ]}
                          />
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
              <div className="settings-section-header">
                <div className="settings-section-title">
                  {t.settings.tools}
                  <InfoTooltip content={t.settings.tooltips.mcpConfig} />
                </div>
              </div>
              <div className="settings-subsection-header">
                <div className="settings-divider">
                  <span>{t.settings.mcpConfig}</span>
                  <i />
                </div>
                <div className="settings-actions">
                  <InfoTooltip content={t.settings.tooltips.mcpConfig}>
                    <button className="btn-secondary" onClick={() => store.openMcpConfig()}>
                      {t.settings.editMcpConfig}
                    </button>
                  </InfoTooltip>
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
                <div className="settings-section-title">
                  {t.settings.skills}
                  <InfoTooltip content={t.settings.tooltips.skills} />
                </div>
                <div className="settings-actions">
                  <InfoTooltip content={t.settings.tooltips.skills}>
                    <button className="btn-secondary" onClick={() => store.openSkillsFolder()}>
                      {t.settings.openSkillsFolder}
                    </button>
                  </InfoTooltip>
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

              {(() => {
                const skillsByDir: Record<string, typeof store.skills> = {}
                store.skills.forEach((s) => {
                  const dir = s.scanRoot // Group by the scan root directory
                  if (!skillsByDir[dir]) skillsByDir[dir] = []
                  skillsByDir[dir].push(s)
                })

                const sortedDirs = Object.keys(skillsByDir).sort((a, b) => {
                  const isACustom = a.includes('GyShell') || a.endsWith('skills') && !a.includes('.claude') && !a.includes('.agents')
                  const isBCustom = b.includes('GyShell') || b.endsWith('skills') && !b.includes('.claude') && !b.includes('.agents')
                  if (isACustom && !isBCustom) return -1
                  if (!isACustom && isBCustom) return 1
                  return a.localeCompare(b)
                })

                return sortedDirs.map((dir) => {
                  const dirSkills = skillsByDir[dir]
                  const isCustom = dir.includes('GyShell') || (dir.endsWith('skills') && !dir.includes('.claude') && !dir.includes('.agents'))
                  const sectionTitle = isCustom ? t.settings.skillSections.custom : dir
                  
                  const allEnabled = dirSkills.every(s => store.settings?.tools?.skills?.[s.name] !== false)
                  const someEnabled = dirSkills.some(s => store.settings?.tools?.skills?.[s.name] !== false)

                  return (
                    <React.Fragment key={dir}>
                      <div className="settings-divider settings-divider-spaced">
                        <span>{sectionTitle}</span>
                        <i />
                        {!isCustom && (
                          <div className="section-global-toggle">
                            <label className="switch switch-sm">
                              <input
                                type="checkbox"
                                checked={allEnabled}
                                ref={el => { if (el) el.indeterminate = someEnabled && !allEnabled }}
                                onChange={async (e) => {
                                  const enabled = e.target.checked
                                  // Update all skills in this directory
                                  for (const s of dirSkills) {
                                    await store.setSkillEnabled(s.name, enabled)
                                  }
                                }}
                              />
                              <span className="switch-slider" />
                            </label>
                          </div>
                        )}
                      </div>
                      <div className="tools-list">
                        {dirSkills.map((s) => {
                          const isEnabled = store.settings?.tools?.skills?.[s.name] !== false
                          return (
                            <div key={s.filePath} className="tool-item">
                              <div className="tool-info">
                                <div className="tool-name">
                                  {s.name}
                                  {s.isNested && <span className="skill-type-tag">Nested</span>}
                                </div>
                                <div className="tool-meta">{s.description}</div>
                              </div>
                              <div className="tool-actions">
                                <span className={`status-dot ${isEnabled ? 'is-ok' : 'is-disabled'}`} />
                                <label className="switch">
                                  <input
                                    type="checkbox"
                                    checked={isEnabled}
                                    onChange={(e) => store.setSkillEnabled(s.name, e.target.checked)}
                                  />
                                  <span className="switch-slider" />
                                </label>
                                {isCustom && (
                                  <>
                                    <button className="icon-btn-sm" title={t.common.edit} onClick={() => store.editSkill(s.fileName)}>
                                      <Pencil size={14} />
                                    </button>
                                    <button
                                      className="icon-btn-sm danger"
                                      title={t.common.delete}
                                      onClick={() => setDeleteSkillConfirm({ fileName: s.fileName })}
                                    >
                                      <Trash2 size={14} />
                                    </button>
                                  </>
                                )}
                              </div>
                            </div>
                          )
                        })}
                      </div>
                    </React.Fragment>
                  )
                })
              })()}
              {store.skills.length === 0 ? <div className="tool-empty">{t.settings.noSkills}</div> : null}
            </>
          ) : null}

          {store.settingsSection === 'version' ? (
            <>
              <div className="settings-section-header">
                <div className="settings-section-title">{t.settings.version}</div>
                <div className="settings-actions">
                  <button
                    className="btn-secondary"
                    onClick={() => store.checkVersion()}
                    disabled={store.versionCheckInProgress}
                  >
                    {store.versionCheckInProgress ? `${t.settings.checkingVersion}...` : t.settings.checkVersion}
                  </button>
                </div>
              </div>

              <div className="version-grid">
                <div className="version-item">
                  <span className="version-label">{t.settings.currentVersion}</span>
                  <span className="version-value">{versionInfo?.currentVersion || '-'}</span>
                </div>
                <div className="version-item">
                  <span className="version-label">{t.settings.latestVersion}</span>
                  <span className="version-value">{versionInfo?.latestVersion || '-'}</span>
                </div>
                <div className="version-item">
                  <span className="version-label">{t.settings.versionStatus}</span>
                  <span className={`version-status version-status-${versionInfo?.status || 'up-to-date'}`}>
                    {versionInfo?.status === 'update-available'
                      ? t.settings.updateAvailable
                      : versionInfo?.status === 'error'
                      ? t.settings.versionCheckFailed
                      : t.settings.upToDate}
                  </span>
                </div>
                <div className="version-item">
                  <span className="version-label">{t.settings.lastCheckedAt}</span>
                  <span className="version-value">{formattedCheckedAt}</span>
                </div>
                <div className="version-item">
                  <span className="version-label">{t.settings.versionSource}</span>
                  <span className="version-value">{versionInfo?.sourceUrl || '-'}</span>
                </div>
                <div className="version-item">
                  <span className="version-label">{t.settings.downloadPage}</span>
                  {versionInfo?.downloadUrl ? (
                    <button
                      className="version-link"
                      onClick={() => store.openVersionDownload()}
                      title={versionInfo.downloadUrl}
                    >
                      {versionInfo.downloadUrl}
                    </button>
                  ) : (
                    <span className="version-value">-</span>
                  )}
                </div>
              </div>

              {versionInfo?.status === 'error' && versionInfo.warning ? (
                <div className="version-warning">
                  <AlertTriangle size={13} />
                  <span>{t.settings.versionNetworkWarning(versionInfo.warning)}</span>
                </div>
              ) : null}

              <div className="settings-card version-note-card">
                <div className="version-note-title">{t.settings.versionCheckNoteTitle}</div>
                <div className="version-note-content">{t.settings.versionCheckNote}</div>
              </div>
            </>
          ) : null}
        </div>
      </div>
    </div>
  )
})
