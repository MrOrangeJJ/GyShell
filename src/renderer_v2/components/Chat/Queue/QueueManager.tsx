import React, { useEffect, useRef, useState } from 'react'
import type { QueueItem } from '../../../stores/ChatQueueStore'
import { QueueCard } from './QueueCard'
import './queue.scss'

export function QueueManager(props: {
  items: QueueItem[]
  isRunning: boolean
  onReorder: (fromIndex: number, toIndex: number) => void
  onEdit: (item: QueueItem) => void
  editLabel: string
}): React.ReactElement | null {
  const { items, isRunning, onReorder, onEdit, editLabel } = props
  const [draggingId, setDraggingId] = useState<string | null>(null)
  const [dropIndex, setDropIndex] = useState<number | null>(null)
  const stackRef = useRef<HTMLDivElement>(null)
  const autoScrollRafRef = useRef<number | null>(null)
  const autoScrollDirRef = useRef<-1 | 0 | 1>(0)
  const dropMargin = 80
  const lastDropIndexRef = useRef<number | null>(null)
  const handledDropRef = useRef(false)

  if (!items.length) return null

  const stopAutoScroll = () => {
    autoScrollDirRef.current = 0
    if (autoScrollRafRef.current !== null) {
      cancelAnimationFrame(autoScrollRafRef.current)
      autoScrollRafRef.current = null
    }
  }

  const startAutoScroll = () => {
    if (autoScrollRafRef.current !== null) return
    const step = () => {
      const container = stackRef.current
      const dir = autoScrollDirRef.current
      if (!container || dir === 0) {
        stopAutoScroll()
        return
      }
      container.scrollTop += dir * 4
      autoScrollRafRef.current = requestAnimationFrame(step)
    }
    autoScrollRafRef.current = requestAnimationFrame(step)
  }

  const setDropIndexSafe = (nextIndex: number | null) => {
    setDropIndex(nextIndex)
    if (nextIndex !== null) {
      lastDropIndexRef.current = nextIndex
    }
  }

  const computeDropIndexByClientY = (clientY: number): number | null => {
    const container = stackRef.current
    if (!container) return null
    const rect = container.getBoundingClientRect()
    if (clientY < rect.top - dropMargin || clientY > rect.bottom + dropMargin) {
      return null
    }
    if (clientY <= rect.top) return 0
    if (clientY >= rect.bottom) return items.length
    const cards = Array.from(container.querySelectorAll<HTMLElement>('.queue-card:not(.is-hidden)'))
    for (let i = 0; i < cards.length; i += 1) {
      const cardRect = cards[i].getBoundingClientRect()
      const midpoint = cardRect.top + cardRect.height / 2
      if (clientY < midpoint) return i
    }
    return items.length
  }

  const handleDragStart = (itemId: string) => (e: React.DragEvent) => {
    if (isRunning) return
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('text/plain', itemId)
    setDropIndexSafe(null)
    handledDropRef.current = false
    // Defer hiding until drag has actually started (prevents drag cancellation)
    requestAnimationFrame(() => {
      setDraggingId(itemId)
    })
  }

  const handleContainerDragOver = (e: React.DragEvent) => {
    if (isRunning) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    const container = stackRef.current
    if (!container) return
    const rect = container.getBoundingClientRect()
    if (e.clientY < rect.top) {
      autoScrollDirRef.current = -1
      startAutoScroll()
    } else if (e.clientY > rect.bottom) {
      autoScrollDirRef.current = 1
      startAutoScroll()
    } else {
      stopAutoScroll()
    }
    const nextIndex = computeDropIndexByClientY(e.clientY)
    setDropIndexSafe(nextIndex)
  }

  const handleContainerDrop = (e: React.DragEvent) => {
    if (isRunning) return
    e.preventDefault()
    if (handledDropRef.current) return
    const fromId = e.dataTransfer.getData('text/plain')
    if (!fromId) return
    const fromIndex = items.findIndex((item) => item.id === fromId)
    if (fromIndex < 0) return
    const targetIndex = dropIndex ?? lastDropIndexRef.current
    if (targetIndex === null) return
    const adjustedIndex = fromIndex < targetIndex ? targetIndex - 1 : targetIndex
    if (adjustedIndex === fromIndex) return
    handledDropRef.current = true
    onReorder(fromIndex, adjustedIndex)
    setDropIndexSafe(null)
    stopAutoScroll()
  }

  const handleDragEnd = () => {
    setDraggingId(null)
    setDropIndexSafe(null)
    stopAutoScroll()
  }

  useEffect(() => {
    return () => {
      stopAutoScroll()
    }
  }, [])

  useEffect(() => {
    if (!draggingId) return
    const handleWindowDragOver = (e: DragEvent) => {
      // Make the whole app a valid drop zone while dragging queue items
      e.preventDefault()
      const container = stackRef.current
      if (!container) return
      const rect = container.getBoundingClientRect()
      if (e.clientY < rect.top) {
        autoScrollDirRef.current = -1
        startAutoScroll()
      } else if (e.clientY > rect.bottom) {
        autoScrollDirRef.current = 1
        startAutoScroll()
      } else {
        stopAutoScroll()
      }
      const nextIndex = computeDropIndexByClientY(e.clientY)
      setDropIndexSafe(nextIndex)
    }
    const handleWindowDrop = (e: DragEvent) => {
      e.preventDefault()
      if (handledDropRef.current) return
      const fromId = e.dataTransfer?.getData('text/plain') || ''
      const targetIndex = dropIndex ?? lastDropIndexRef.current
      if (!fromId || targetIndex === null) {
        stopAutoScroll()
        return
      }
      const fromIndex = items.findIndex((item) => item.id === fromId)
      if (fromIndex < 0) {
        stopAutoScroll()
        return
      }
      const adjustedIndex = fromIndex < targetIndex ? targetIndex - 1 : targetIndex
      if (adjustedIndex === fromIndex) {
        stopAutoScroll()
        return
      }
      handledDropRef.current = true
      onReorder(fromIndex, adjustedIndex)
      setDropIndexSafe(null)
      stopAutoScroll()
      // reset after this event loop to avoid double-handling
      setTimeout(() => { handledDropRef.current = false }, 0)
    }
    window.addEventListener('dragover', handleWindowDragOver, true)
    window.addEventListener('drop', handleWindowDrop, true)
    return () => {
      window.removeEventListener('dragover', handleWindowDragOver, true)
      window.removeEventListener('drop', handleWindowDrop, true)
    }
  }, [draggingId, dropIndex, items, onReorder])

  return (
    <div
      className={`queue-stack ${isRunning ? 'is-running' : ''} ${draggingId ? 'is-dragging' : ''}`}
      ref={stackRef}
      onDragOver={handleContainerDragOver}
      onDrop={handleContainerDrop}
    >
      {dropIndex === 0 && <div className="queue-drop-line" />}
      {items.map((item, index) => (
        <React.Fragment key={item.id}>
          {dropIndex === index && index !== 0 && <div className="queue-drop-spacer" />}
          <QueueCard
            item={item}
            index={index}
            isRunning={isRunning}
            isHidden={draggingId === item.id}
            onEdit={() => onEdit(item)}
            editLabel={editLabel}
            onDragStart={handleDragStart(item.id)}
            onDragEnd={handleDragEnd}
          />
        </React.Fragment>
      ))}
      {dropIndex === items.length && <div className="queue-drop-line" />}
    </div>
  )
}
