import React, { useEffect, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import type { ITheme } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import '@xterm/xterm/css/xterm.css'
import './xtermView.scss'
import type { TerminalConfig } from '../../lib/ipcTypes'

const SCROLLBAR_HIDE_DELAY = 2000 // ms

export function XTermView(props: {
  config: TerminalConfig
  theme: ITheme
  terminalSettings?: {
    fontSize?: number
    lineHeight?: number
    scrollback?: number
    cursorStyle?: 'block' | 'underline' | 'bar'
    cursorBlink?: boolean
    copyOnSelect?: boolean
    rightClickToPaste?: boolean
  }
  isActive?: boolean
  onSelectionChange?: (selectionText: string) => void
}): React.ReactElement {
  const hostRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const cleanupRef = useRef<(() => void) | null>(null)
  const contextMenuIdRef = useRef<string>(`terminal-${props.config.id}`)
  const onSelectionChangeRef = useRef<typeof props.onSelectionChange>(props.onSelectionChange)
  const settingsRef = useRef(props.terminalSettings)
  const scrollHideTimerRef = useRef<number | null>(null)

  useEffect(() => {
    onSelectionChangeRef.current = props.onSelectionChange
  }, [props.onSelectionChange])

  useEffect(() => {
    settingsRef.current = props.terminalSettings
  }, [props.terminalSettings])

  // Create/dispose xterm instance
  useEffect(() => {
    if (!hostRef.current) return

    const term = new Terminal({
      allowTransparency: true,
      cursorBlink: props.terminalSettings?.cursorBlink ?? true,
      cursorStyle: props.terminalSettings?.cursorStyle ?? 'block',
      fontSize: props.terminalSettings?.fontSize ?? 14,
      lineHeight: Math.max(1, props.terminalSettings?.lineHeight ?? 1.2),
      scrollback: props.terminalSettings?.scrollback ?? 5000,
      theme: props.theme,
      allowProposedApi: true
    })

    const fit = new FitAddon()
    term.loadAddon(fit)

    const webLinks = new WebLinksAddon((event, url) => {
      window.gyshell.system.openExternal(url).catch(() => {
        // ignore
      })
    })
    term.loadAddon(webLinks)

    term.open(hostRef.current)
    fit.fit()

    termRef.current = term
    fitRef.current = fit

    // Ensure backend tab exists (idempotent in main process)
    const dims = fit.proposeDimensions()
    const cols = dims?.cols ?? term.cols ?? 80
    const rows = dims?.rows ?? term.rows ?? 24
    
    // Convert to plain object to avoid "could not be cloned" error with MobX proxies
    const plainConfig = JSON.parse(JSON.stringify(props.config))
    
    window.gyshell.terminal.createTab({ ...plainConfig, cols, rows }).catch(() => {
      // ignore: backend is idempotent and may fail during hot reload; user will see logs in devtools
    })
    window.gyshell.terminal.resize(props.config.id, cols, rows).catch(() => {
      // ignore
    })

    const handleResize = () => {
      try {
        fit.fit()
        const next = fit.proposeDimensions()
        if (next) {
          window.gyshell.terminal.resize(props.config.id, next.cols, next.rows)
        }
      } catch {
        // ignore transient DOM/layout issues
      }
    }

    window.addEventListener('resize', handleResize)

    // Input: xterm -> backend
    const inputDisposable = term.onData((data) => {
      window.gyshell.terminal.write(props.config.id, data)
    })

    const selectionDisposable = term.onSelectionChange(() => {
      const selectionText = term.getSelection()
      onSelectionChangeRef.current?.(selectionText)
      // Auto-copy to clipboard if enabled and selection is non-empty
      if (selectionText && settingsRef.current?.copyOnSelect) {
        navigator.clipboard.writeText(selectionText).catch(() => {
          // ignore
        })
      }
    })

    const showScrollbar = () => {
      if (!hostRef.current) return
      hostRef.current.classList.add('is-scrollbar-visible')
      if (scrollHideTimerRef.current) {
        window.clearTimeout(scrollHideTimerRef.current)
      }
      scrollHideTimerRef.current = window.setTimeout(() => {
        hostRef.current?.classList.remove('is-scrollbar-visible')
      }, SCROLLBAR_HIDE_DELAY)
    }

    const scrollDisposable = term.onScroll(() => {
      showScrollbar()
    })

    const handlePaste = (event: ClipboardEvent) => {
      const selectionText = term.getSelection()
      if (selectionText) {
        event.preventDefault()
        navigator.clipboard.writeText(selectionText).then(() => {
          term.paste(selectionText)
        }).catch(() => {
          term.paste(selectionText)
        })
      }
    }

    const handleDragOver = (event: DragEvent) => {
      event.preventDefault()
    }

    const handleDrop = (event: DragEvent) => {
      event.preventDefault()
      const files = Array.from(event.dataTransfer?.files || [])
      if (!files.length) return
      const paths = files.map((f) => f.path).filter(Boolean)
      if (!paths.length) return
      window.gyshell.terminal.writePaths(props.config.id, paths).catch(() => {
        // ignore
      })
    }

    const handleContextMenu = (event: MouseEvent) => {
      if (settingsRef.current?.rightClickToPaste) {
        event.preventDefault()
        navigator.clipboard.readText().then(text => {
          if (text) term.paste(text)
        }).catch(() => {
          // ignore
        })
        return
      }
      event.preventDefault()
      const selectionText = term.getSelection()
      window.gyshell.ui.showContextMenu({
        id: contextMenuIdRef.current,
        canCopy: selectionText.trim().length > 0,
        canPaste: true
      })
    }

    const onContextMenuAction = (data: { id: string; action: 'copy' | 'paste' }) => {
      if (data.id !== contextMenuIdRef.current) return
      if (data.action === 'copy') {
        const selectionText = term.getSelection()
        if (selectionText) {
          navigator.clipboard.writeText(selectionText).catch(() => {
            // ignore
          })
        }
        return
      }
      if (data.action === 'paste') {
        const selectionText = term.getSelection()
        if (selectionText) {
          navigator.clipboard.writeText(selectionText).then(() => {
            term.paste(selectionText)
          }).catch(() => {
            term.paste(selectionText)
          })
          return
        }
        navigator.clipboard.readText().then(text => {
            if (text) term.paste(text)
        }).catch(() => {
            // ignore
        })
      }
    }

    hostRef.current.addEventListener('paste', handlePaste)
    hostRef.current.addEventListener('dragover', handleDragOver)
    hostRef.current.addEventListener('drop', handleDrop)
    hostRef.current.addEventListener('contextmenu', handleContextMenu)
    const removeContextMenuListener = window.gyshell.ui.onContextMenuAction(onContextMenuAction)

    // Output: backend -> xterm
    const cleanup = window.gyshell.terminal.onData(({ terminalId, data }) => {
      if (terminalId === props.config.id) {
        term.write(data)
      }
    })
    cleanupRef.current = cleanup

    return () => {
      cleanupRef.current?.()
      cleanupRef.current = null
      inputDisposable.dispose()
      selectionDisposable.dispose()
      scrollDisposable.dispose()
      if (scrollHideTimerRef.current) {
        window.clearTimeout(scrollHideTimerRef.current)
        scrollHideTimerRef.current = null
      }
      hostRef.current?.removeEventListener('paste', handlePaste)
      hostRef.current?.removeEventListener('dragover', handleDragOver)
      hostRef.current?.removeEventListener('drop', handleDrop)
      hostRef.current?.removeEventListener('contextmenu', handleContextMenu)
      removeContextMenuListener()
      window.removeEventListener('resize', handleResize)
      term.dispose()
      termRef.current = null
      fitRef.current = null
    }
  }, [props.config.id])

  // Live-update theme (Tabby-style behavior)
  useEffect(() => {
    if (!termRef.current) return
    termRef.current.options.theme = props.theme
  }, [props.theme])

  // Live-update terminal settings
  useEffect(() => {
    if (!termRef.current) return
    const options = termRef.current.options
    if (props.terminalSettings?.fontSize) options.fontSize = props.terminalSettings.fontSize
    if (props.terminalSettings?.lineHeight) options.lineHeight = Math.max(1, props.terminalSettings.lineHeight)
    if (props.terminalSettings?.scrollback) options.scrollback = props.terminalSettings.scrollback
    if (props.terminalSettings?.cursorStyle) options.cursorStyle = props.terminalSettings.cursorStyle
    if (props.terminalSettings?.cursorBlink !== undefined) options.cursorBlink = props.terminalSettings.cursorBlink

    // Refit after changes
    requestAnimationFrame(() => {
      try {
        fitRef.current?.fit()
        const next = fitRef.current?.proposeDimensions()
        if (next) {
          window.gyshell.terminal.resize(props.config.id, next.cols, next.rows)
        }
      } catch {
        // ignore
      }
    })
  }, [
    props.terminalSettings?.fontSize,
    props.terminalSettings?.lineHeight,
    props.terminalSettings?.scrollback,
    props.terminalSettings?.cursorStyle,
    props.terminalSettings?.cursorBlink,
    props.config.id
  ])

  // Re-fit when the tab becomes active (Tabby-like behavior)
  useEffect(() => {
    if (!props.isActive) return
    if (!fitRef.current || !termRef.current) return
    requestAnimationFrame(() => {
      try {
        fitRef.current?.fit()
        const next = fitRef.current?.proposeDimensions()
        if (next) {
          window.gyshell.terminal.resize(props.config.id, next.cols, next.rows)
        }
      } catch {
        // ignore
      }
    })
  }, [props.isActive, props.config.id])

  return <div className="xterm-host" ref={hostRef} />
}


