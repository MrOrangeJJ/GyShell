import React from 'react'
import { ListTodo } from 'lucide-react'

export function QueueModeSwitch(props: {
  enabled: boolean
  disabled?: boolean
  onToggle: () => void
  labelOn: string
  labelOff: string
}): React.ReactElement {
  const { enabled, disabled, onToggle, labelOn, labelOff } = props

  return (
    <button
      className={`icon-btn-sm secondary queue-mode-btn ${enabled ? 'is-active' : ''}`}
      onClick={onToggle}
      disabled={disabled}
      title={enabled ? labelOn : labelOff}
      type="button"
    >
      <ListTodo size={16} strokeWidth={2.5} />
    </button>
  )
}
