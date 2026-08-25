import React from 'react'
import type { ChatRenderItem } from './chatRenderModel'
import type { ChatVirtualLayout, ChatViewportAnchor } from './chatVirtualList'
import { resolveChatViewportAnchorScrollTop } from './chatVirtualList'

const RESIZE_ANCHOR_SETTLE_MS = 120

export interface ChatResizeAnchorController {
  rememberStableAnchor: (anchor: ChatViewportAnchor | null) => void
  beginResize: (fallbackAnchor: ChatViewportAnchor | null) => void
  keepAlive: () => void
  isActive: () => boolean
  resolveScrollTop: (
    items: readonly ChatRenderItem[],
    layout: ChatVirtualLayout,
  ) => number | null
  reset: () => void
}

export const useChatResizeAnchor = (): ChatResizeAnchorController => {
  const stableAnchorRef = React.useRef<ChatViewportAnchor | null>(null)
  const activeAnchorRef = React.useRef<ChatViewportAnchor | null>(null)
  const releaseTimerRef = React.useRef<number | null>(null)

  const clearReleaseTimer = React.useCallback(() => {
    if (releaseTimerRef.current === null) return
    window.clearTimeout(releaseTimerRef.current)
    releaseTimerRef.current = null
  }, [])

  const reset = React.useCallback(() => {
    clearReleaseTimer()
    stableAnchorRef.current = null
    activeAnchorRef.current = null
  }, [clearReleaseTimer])

  const scheduleRelease = React.useCallback(() => {
    clearReleaseTimer()
    releaseTimerRef.current = window.setTimeout(() => {
      activeAnchorRef.current = null
      stableAnchorRef.current = null
      releaseTimerRef.current = null
    }, RESIZE_ANCHOR_SETTLE_MS)
  }, [clearReleaseTimer])

  const rememberStableAnchor = React.useCallback(
    (anchor: ChatViewportAnchor | null) => {
      if (activeAnchorRef.current) return
      stableAnchorRef.current = anchor
    },
    [],
  )

  const beginResize = React.useCallback(
    (fallbackAnchor: ChatViewportAnchor | null) => {
      if (!activeAnchorRef.current) {
        activeAnchorRef.current = stableAnchorRef.current || fallbackAnchor
      }
      if (activeAnchorRef.current) scheduleRelease()
    },
    [scheduleRelease],
  )

  const keepAlive = React.useCallback(() => {
    if (activeAnchorRef.current) scheduleRelease()
  }, [scheduleRelease])

  const isActive = React.useCallback(
    () => activeAnchorRef.current !== null,
    [],
  )

  const resolveScrollTop = React.useCallback(
    (items: readonly ChatRenderItem[], layout: ChatVirtualLayout) => {
      const anchor = activeAnchorRef.current
      return anchor
        ? resolveChatViewportAnchorScrollTop(items, layout, anchor)
        : null
    },
    [],
  )

  React.useEffect(() => reset, [reset])

  return React.useMemo(
    () => ({
      rememberStableAnchor,
      beginResize,
      keepAlive,
      isActive,
      resolveScrollTop,
      reset,
    }),
    [
      beginResize,
      isActive,
      keepAlive,
      rememberStableAnchor,
      reset,
      resolveScrollTop,
    ],
  )
}
