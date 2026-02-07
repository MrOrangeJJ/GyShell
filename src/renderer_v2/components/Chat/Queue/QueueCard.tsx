import React from 'react'
import { GripVertical, Pencil } from 'lucide-react'
import { renderMentionContent } from '../../../lib/MentionParser'
import type { QueueItem } from '../../../stores/ChatQueueStore'

export function QueueCard(props: {
  item: QueueItem
  index: number
  isHidden: boolean
  onEdit: () => void
  editLabel: string
  onDragStart: (e: React.DragEvent) => void
  onDragEnd: () => void
}): React.ReactElement {
  const {
    item,
    index,
    isHidden,
    onEdit,
    editLabel,
    onDragStart,
    onDragEnd
  } = props

  return (
    <div
      className={`queue-card ${isHidden ? 'is-hidden' : ''}`}
      style={{
        marginTop: index === 0 ? 0 : -10,
        zIndex: 100 - index
      }}
      draggable
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
    >
      <div
        className="queue-card-handle"
        aria-hidden="true"
      >
        <GripVertical size={14} />
      </div>
      <div className="queue-card-content">{renderMentionContent(item.content)}</div>
      <button
        className="icon-btn-sm queue-card-action"
        onClick={onEdit}
        title={editLabel}
      >
        <Pencil size={14} />
      </button>
    </div>
  )
}
