import React from 'react'
import { ChevronDown } from 'lucide-react'

export interface ProfileOption {
  id: string
  name: string
}

export function WindowsProfileSelect({
  value,
  options,
  onChange,
  widthCh
}: {
  value: string
  options: ProfileOption[]
  onChange: (nextId: string) => void
  widthCh: number
}) {
  const [open, setOpen] = React.useState(false)
  const rootRef = React.useRef<HTMLDivElement>(null)
  const active = options.find((o) => o.id === value)

  React.useEffect(() => {
    if (!open) return
    const onDocMouseDown = (e: MouseEvent) => {
      const el = rootRef.current
      if (!el) return
      if (!el.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDocMouseDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onDocMouseDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  return (
    <div ref={rootRef} className="windows-profile-select" style={{ width: `${widthCh}ch` }}>
      {/* Keep the trigger style consistent with macOS by reusing the existing class name */}
      <button
        type="button"
        className="profile-dropdown windows-profile-select-trigger"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
        title={active?.name || ''}
      >
        <span className="windows-profile-select-label">{active?.name || ''}</span>
        <ChevronDown size={12} />
      </button>

      {open && (
        <div className="windows-profile-select-menu" role="listbox">
          {options.map((o) => (
            <button
              key={o.id}
              type="button"
              className={`windows-profile-select-option ${o.id === value ? 'is-selected' : ''}`}
              onClick={() => {
                onChange(o.id)
                setOpen(false)
              }}
              role="option"
              aria-selected={o.id === value}
              title={o.name}
            >
              {o.name}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

