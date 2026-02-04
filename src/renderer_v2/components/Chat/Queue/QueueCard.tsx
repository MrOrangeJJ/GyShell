import React from 'react'
import { GripVertical, Pencil } from 'lucide-react'
import type { QueueItem } from '../../../stores/ChatQueueStore'

export function QueueCard(props: {
  item: QueueItem
  index: number
  isRunning: boolean
  isHidden: boolean
  onEdit: () => void
  editLabel: string
  onDragStart: (e: React.DragEvent) => void
  onDragEnd: () => void
}): React.ReactElement {
  const {
    item,
    index,
    isRunning,
    isHidden,
    onEdit,
    editLabel,
    onDragStart,
    onDragEnd
  } = props

  // Parser for [MENTION_XXX:#...#] labels
  const renderContent = (content: string) => {
    const parts = content.split(/(\[MENTION_(?:SKILL|TAB|FILE|USER_PASTE):#.+?#(?:#.+?#)?\])/g);
    return parts.map((part, i) => {
      const skillMatch = part.match(/\[MENTION_SKILL:#(.+?)#\]/);
      if (skillMatch) {
        return <span key={i} className="mention-badge skill">@{skillMatch[1]}</span>;
      }
      const terminalMatch = part.match(/\[MENTION_TAB:#(.+?)##(.+?)#\]/);
      if (terminalMatch) {
        return <span key={i} className="mention-badge terminal">@{terminalMatch[1]}</span>;
      }
      const fileMatch = part.match(/\[MENTION_FILE:#(.+?)#\]/);
      if (fileMatch) {
        const fileName = fileMatch[1].split(/[/\\]/).pop() || fileMatch[1];
        return <span key={i} className="mention-badge file">{fileName}</span>;
      }
      const pasteMatch = part.match(/\[MENTION_USER_PASTE:#(.+?)##(.+?)#\]/);
      if (pasteMatch) {
        return <span key={i} className="mention-badge paste">{pasteMatch[2]}</span>;
      }
      return part;
    });
  };

  return (
    <div
      className={`queue-card ${isHidden ? 'is-hidden' : ''}`}
      style={{
        marginTop: index === 0 ? 0 : -10,
        zIndex: 100 - index
      }}
      draggable={!isRunning}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
    >
      <div
        className="queue-card-handle"
        aria-hidden="true"
      >
        <GripVertical size={14} />
      </div>
      <div className="queue-card-content">{renderContent(item.content)}</div>
      <button
        className="queue-card-action"
        onClick={onEdit}
        disabled={isRunning}
        title={editLabel}
      >
        <Pencil size={14} />
      </button>
    </div>
  )
}
