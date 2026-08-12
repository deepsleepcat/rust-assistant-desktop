/**
 * 通用弹窗与确认框。
 */
import type { ReactNode } from 'react'
import { useEffect } from 'react'
import { useWorkspaceStore } from '../stores/workspace'
import { IconClose } from './icons'

interface ModalProps {
  title: ReactNode
  onClose: () => void
  children: ReactNode
  footer?: ReactNode
  wide?: boolean
}

export function Modal({ title, onClose, children, footer, wide }: ModalProps) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className="modal-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal-card${wide ? ' settings' : ''}`} role="dialog" aria-modal="true">
        <div className="modal-header">
          {title}
          <span className="grow" />
          <button className="icon-btn" onClick={onClose} aria-label="关闭">
            <IconClose size={15} />
          </button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-footer">{footer}</div>}
      </div>
    </div>
  )
}

/** 全局确认框：由 store.requestConfirm 触发 */
export function ConfirmDialog() {
  const confirm = useWorkspaceStore((s) => s.confirm)
  const dismiss = useWorkspaceStore((s) => s.dismissConfirm)
  if (!confirm) return null
  return (
    <ConfirmBox
      title={confirm.title}
      message={confirm.message}
      danger={confirm.danger}
      confirmText={confirm.confirmText}
      cancelText={confirm.cancelText}
      onCancel={dismiss}
      onConfirm={() => {
        dismiss()
        confirm.onConfirm()
      }}
    />
  )
}

/** 带 props 的确认框（供组件局部使用） */
export function ConfirmBox({
  title,
  message,
  danger,
  confirmText = '确定',
  cancelText = '取消',
  extra,
  onConfirm,
  onCancel,
}: {
  title: string
  message: string
  danger?: boolean
  confirmText?: string
  cancelText?: string
  extra?: ReactNode
  onConfirm: () => void
  onCancel: () => void
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onCancel])

  return (
    <div className="modal-overlay" onMouseDown={(e) => e.target === e.currentTarget && onCancel()}>
      <div className={`modal-card confirm-card${danger ? ' danger' : ''}`} role="alertdialog" aria-modal="true">
        <div className="modal-header">{title}</div>
        <div className="modal-body">
          <p style={{ margin: 0, color: 'var(--text-2)', fontSize: 13.5, lineHeight: 1.7, whiteSpace: 'pre-wrap' }}>{message}</p>
        </div>
        <div className="modal-footer">
          {extra}
          <button className="btn" onClick={onCancel}>
            {cancelText}
          </button>
          <button className={danger ? 'btn-danger' : 'btn primary'} onClick={onConfirm}>
            {confirmText}
          </button>
        </div>
      </div>
    </div>
  )
}

/** 输入弹窗（新建文件/文件夹、重命名、对话标题） */
interface PromptModalProps {
  title: string
  initialValue?: string
  placeholder?: string
  confirmText?: string
  onSubmit: (value: string) => void
  onClose: () => void
}

export function PromptModal({ title, initialValue = '', placeholder, confirmText = '确定', onSubmit, onClose }: PromptModalProps) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className="modal-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal-card" role="dialog" aria-modal="true" style={{ width: 'min(400px, 100%)' }}>
        <form
          onSubmit={(e) => {
            e.preventDefault()
            const input = e.currentTarget.elements.namedItem('value') as HTMLInputElement
            if (input.value.trim()) onSubmit(input.value.trim())
          }}
        >
          <div className="modal-header">{title}</div>
          <div className="modal-body">
            <input
              name="value"
              autoFocus
              defaultValue={initialValue}
              placeholder={placeholder}
              style={{
                width: '100%',
                border: '1px solid var(--border)',
                borderRadius: 'var(--radius-sm)',
                background: 'var(--bg-input)',
                color: 'var(--text-1)',
                font: '14px var(--font-ui)',
                padding: '9px 12px',
                outline: 'none',
              }}
            />
          </div>
          <div className="modal-footer">
            <button type="button" className="btn" onClick={onClose}>
              取消
            </button>
            <button type="submit" className="btn primary">
              {confirmText}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
