import React from 'react'
import { createPortal } from 'react-dom'
import { Loader2, X } from 'lucide-react'
import './confirmDialog.scss'

export function ConfirmDialog(props: {
  open: boolean
  title: string
  message: string
  confirmText: string
  cancelText: string
  danger?: boolean
  loading?: boolean
  onConfirm: () => void
  onCancel: () => void
}): React.ReactElement | null {
  if (!props.open) return null

  return createPortal(
    <div className="gy-confirm-overlay" role="dialog" aria-modal="true">
      <div className="gy-confirm-card">
        <div className="gy-confirm-header">
          <div className="gy-confirm-title">{props.title}</div>
          <button className="icon-btn-sm" onClick={props.onCancel} title={props.cancelText} disabled={!!props.loading}>
            <X size={18} />
          </button>
        </div>

        <div className="gy-confirm-body">
          <div className="gy-confirm-message">{props.message}</div>
        </div>

        <div className="gy-confirm-footer">
          <button className="gy-btn gy-btn-secondary" onClick={props.onCancel} disabled={!!props.loading}>
            {props.cancelText}
          </button>
          <button
            className={props.danger ? 'gy-btn gy-btn-danger' : 'gy-btn gy-btn-primary'}
            onClick={props.onConfirm}
            disabled={!!props.loading}
          >
            {props.loading ? (
              <span className="gy-confirm-loading">
                <Loader2 size={14} />
                <span>{props.confirmText}</span>
              </span>
            ) : (
              props.confirmText
            )}
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}

