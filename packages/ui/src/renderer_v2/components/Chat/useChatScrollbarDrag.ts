import React from 'react'

export interface ChatScrollbarDragController {
  /**
   * True while the user holds the native scrollbar thumb. Measured row heights
   * must not reach the layout during this window.
   */
  isDragging: () => boolean
  /**
   * Height the scroll container must keep reporting while the thumb is held.
   * Null when no drag is active.
   */
  frozenTotalHeight: () => number | null
  /**
   * Records the natural layout height so the frozen height still tracks growth
   * that happens for reasons other than measurement (streaming, pagination).
   */
  syncNaturalHeight: (naturalHeight: number) => void
  begin: (naturalHeight: number) => void
  end: () => void
}

/**
 * Chromium discards a thumb-drag frame whenever the scroller length changes
 * mid-drag (cc/input/scrollbar_controller.cc: a `scroller_length_at_previous_move`
 * mismatch resets `scroller_displacement` and returns without scrolling). A
 * virtual list that swaps estimated row heights for measured ones therefore
 * loses drag frames and the thumb falls behind the pointer.
 *
 * Holding the reported height still for the duration of the drag keeps
 * `scroll_layer_length()` constant so every frame is consumed.
 */
export const createChatScrollbarDragState = (
  onDragEnd: () => void,
): ChatScrollbarDragController => {
  let dragging = false
  let frozenHeight: number | null = null

  return {
    isDragging: () => dragging,
    frozenTotalHeight: () => (dragging ? frozenHeight : null),
    syncNaturalHeight: (naturalHeight: number) => {
      if (!dragging) return
      // Only ever grow: shrinking mid-drag would change the scroller length and
      // reintroduce the dropped frame this state exists to prevent.
      if (frozenHeight === null || naturalHeight > frozenHeight) {
        frozenHeight = naturalHeight
      }
    },
    begin: (naturalHeight: number) => {
      if (dragging) return
      dragging = true
      frozenHeight = naturalHeight
    },
    end: () => {
      if (!dragging) return
      dragging = false
      frozenHeight = null
      onDragEnd()
    },
  }
}

export const useChatScrollbarDrag = (
  onDragEnd: () => void,
): ChatScrollbarDragController => {
  const onDragEndRef = React.useRef(onDragEnd)
  onDragEndRef.current = onDragEnd

  return React.useMemo(
    () => createChatScrollbarDragState(() => onDragEndRef.current()),
    [],
  )
}
