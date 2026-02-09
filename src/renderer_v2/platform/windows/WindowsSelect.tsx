import React, { forwardRef, useImperativeHandle, useLayoutEffect } from 'react'
import { createPortal } from 'react-dom'
import { ChevronDown } from 'lucide-react'

export interface SelectOption {
  value: string
  label: string
}

export interface SelectHandle {
  toggle: () => void
  open: () => void
  close: () => void
}

interface WindowsSelectProps {
  value: string
  options: SelectOption[]
  onChange: (next: string) => void
  disabled?: boolean
  widthCh?: number
  className?: string
  hideArrow?: boolean
}

export const WindowsSelect = forwardRef<SelectHandle, WindowsSelectProps>(({
  value,
  options,
  onChange,
  disabled,
  widthCh,
  className,
  hideArrow
}, ref) => {
  const [open, setOpen] = React.useState(false)
  const rootRef = React.useRef<HTMLDivElement>(null)
  const triggerRef = React.useRef<HTMLButtonElement>(null)
  const menuRef = React.useRef<HTMLDivElement>(null)
  const [menuStyle, setMenuStyle] = React.useState<React.CSSProperties | undefined>(undefined)
  const active = options.find((o) => o.value === value)

  useImperativeHandle(ref, () => ({
    toggle: () => {
      if (disabled) return
      setOpen(v => !v)
    },
    open: () => {
      if (disabled) return
      setOpen(true)
    },
    close: () => setOpen(false)
  }), [disabled])

  const recomputeMenuPosition = React.useCallback(() => {
    const trigger = triggerRef.current
    const menu = menuRef.current
    if (!trigger || !menu) return

    const rect = trigger.getBoundingClientRect()
    const vw = window.innerWidth
    const vh = window.innerHeight
    const margin = 8
    const gap = 4

    // Start by opening downward
    let top = rect.bottom + gap
    let left = rect.left

    // Let CSS width: fit-content do its job, we only measure the result
    const measured = menu.getBoundingClientRect()
    let menuW = Math.ceil(measured.width)
    const menuH = Math.ceil(measured.height)

    // If bottom overflows, try open upwards
    if (top + menuH > vh - margin) {
      const upTop = rect.top - gap - menuH
      // Prefer whichever side has more room
      const spaceDown = vh - rect.bottom
      const spaceUp = rect.top
      if (spaceUp >= spaceDown) {
        top = Math.max(margin, upTop)
      } else {
        // Keep down but clamp height via maxHeight
        top = Math.max(margin, top)
      }
    }

    // Clamp horizontally inside viewport
    if (left + menuW > vw - margin) left = vw - margin - menuW
    if (left < margin) left = margin

    // Clamp maxHeight to avoid vertical overflow
    const maxHeight = Math.min(300, Math.max(80, vh - margin - top))

    setMenuStyle({
      position: 'fixed',
      top,
      left,
      maxHeight
    })
  }, [])

  useLayoutEffect(() => {
    if (!open) return
    const onDocMouseDown = (e: MouseEvent) => {
      const root = rootRef.current
      const menu = menuRef.current
      const target = e.target as Node
      if (!root) return
      if (!root.contains(target) && !menu?.contains(target)) {
        setOpen(false)
      }
    }
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDocMouseDown)
    document.addEventListener('keydown', onKeyDown)

    // Reposition on scroll/resize so we don't "pierce walls"
    const onReflow = () => recomputeMenuPosition()
    window.addEventListener('resize', onReflow)
    window.addEventListener('scroll', onReflow, true)

    // After mount, measure and position
    recomputeMenuPosition()

    return () => {
      document.removeEventListener('mousedown', onDocMouseDown)
      document.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('resize', onReflow)
      window.removeEventListener('scroll', onReflow, true)
    }
  }, [open, recomputeMenuPosition])

  return (
    <div
      ref={rootRef}
      className="win-select"
      style={widthCh ? { width: `${widthCh}ch` } : undefined}
    >
      <button
        type="button"
        className={className ? `${className} win-select-trigger` : 'win-select-trigger'}
        disabled={disabled}
        onClick={(e) => {
            if (disabled) return
            e.stopPropagation() // Issue 1 fix: Prevent double-toggle when clicked via parent wrapper
            setOpen((v) => !v)
        }}
        aria-haspopup="listbox"
        aria-expanded={open}
        title={active?.label || ''}
        ref={triggerRef}
      >
        <span className="win-select-label">{active?.label || ''}</span>
        {!hideArrow && <ChevronDown size={12} />}
      </button>

      {open && !disabled && (
        createPortal(
          <div
            ref={menuRef}
            className="win-select-menu"
            role="listbox"
            style={menuStyle}
          >
            {options.map((o) => (
              <button
                key={o.value}
                type="button"
                className={`win-select-option ${o.value === value ? 'is-selected' : ''}`}
                onClick={() => {
                  onChange(o.value)
                  setOpen(false)
                }}
                role="option"
                aria-selected={o.value === value}
                title={o.label}
              >
                {o.label}
              </button>
            ))}
          </div>,
          document.body
        )
      )}
    </div>
  )
})
