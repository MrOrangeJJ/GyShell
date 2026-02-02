import React from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'
import './confirmDialog.scss'

export function ConfirmDialog(props: {
  open: boolean
  title: string
  message: string
  confirmText: string
  cancelText: string
  danger?: boolean
  onConfirm: () => void
  onCancel: () => void
}): React.ReactElement | null {
  if (!props.open) return null

  return createPortal(
    <div className="gy-confirm-overlay" role="dialog" aria-modal="true">
      <div className="gy-confirm-card">
        <div className="gy-confirm-header">
          <div className="gy-confirm-title">{props.title}</div>
          <button className="icon-btn-sm" onClick={props.onCancel} title={props.cancelText}>
            <X size={18} />
          </button>
        </div>

        <div className="gy-confirm-body">
          <div className="gy-confirm-message">{props.message}</div>
        </div>

        <div className="gy-confirm-footer">
          <button className="gy-btn gy-btn-secondary" onClick={props.onCancel}>
            {props.cancelText}
          </button>
          <button
            className={props.danger ? 'gy-btn gy-btn-danger' : 'gy-btn gy-btn-primary'}
            onClick={props.onConfirm}
          >
            {props.confirmText}
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}


