/**
 * 手机端通用对话框：输入框弹层与确认弹层。
 *
 * 不使用 window.prompt / window.confirm：Android WebView 对 JS 对话框的支持
 * 依赖宿主实现，移动端可能直接返回 null（用户点不到、也没法取消），
 * 而新建/重命名/删除/放弃修改都必须拿到明确结果。这里用页面内弹层自建。
 */
import { useEffect, useRef, useState } from 'react'
import { AppIcon } from './AppIcon'

interface ModalShellProps {
  title: string
  children?: React.ReactNode
  onCancel: () => void
}

/** 弹层外壳：遮罩点击关闭、Esc 关闭 */
function ModalShell({ title, children, onCancel }: ModalShellProps) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onCancel])

  return (
    <div className="m-modal-mask" onClick={onCancel}>
      <div className="m-modal" role="dialog" aria-label={title} onClick={(e) => e.stopPropagation()}>
        <h3 className="m-modal-title">{title}</h3>
        {children}
      </div>
    </div>
  )
}

interface PromptModalProps {
  title: string
  label?: string
  placeholder?: string
  defaultValue?: string
  confirmText?: string
  /** 校验失败时返回错误文案；返回空串表示通过 */
  validate?: (value: string) => string
  onConfirm: (value: string) => void
  onCancel: () => void
}

/** 输入弹层（新建文件/文件夹、重命名） */
export function PromptModal({
  title,
  label,
  placeholder,
  defaultValue = '',
  confirmText = '确定',
  validate,
  onConfirm,
  onCancel,
}: PromptModalProps) {
  const [value, setValue] = useState(defaultValue)
  const [error, setError] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    // 自动聚焦并选中原名，重命名时可直接覆盖输入
    const el = inputRef.current
    if (!el) return
    el.focus()
    el.select()
  }, [])

  function submit() {
    const trimmed = value.trim()
    if (!trimmed) {
      setError('不能为空')
      return
    }
    const message = validate?.(trimmed) ?? ''
    if (message) {
      setError(message)
      return
    }
    onConfirm(trimmed)
  }

  return (
    <ModalShell title={title} onCancel={onCancel}>
      {label && <label className="m-modal-label">{label}</label>}
      <input
        ref={inputRef}
        className="m-modal-input"
        type="text"
        value={value}
        placeholder={placeholder}
        onChange={(e) => {
          setValue(e.target.value)
          if (error) setError('')
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') submit()
        }}
      />
      {error && <p className="m-modal-error">{error}</p>}
      <div className="m-modal-actions">
        <button className="m-btn" onClick={onCancel}>
          取消
        </button>
        <button className="m-btn primary" onClick={submit}>
          {confirmText}
        </button>
      </div>
    </ModalShell>
  )
}

interface ConfirmModalProps {
  title: string
  message?: string
  /** 主按钮文案（危险操作建议写明动作，如「放弃修改」） */
  confirmText?: string
  /** 主按钮是否为危险操作样式 */
  danger?: boolean
  /** 可选的第三选项（未保存保护：先保存再继续） */
  extraText?: string
  /** 取消按钮文案；传 null 表示只提示、不给取消（结果通知类弹层） */
  cancelText?: string | null
  onConfirm: () => void
  onExtra?: () => void
  onCancel: () => void
}

/** 确认弹层（删除、放弃修改、冲突处理、结果通知） */
export function ConfirmModal({
  title,
  message,
  confirmText = '确定',
  danger = false,
  extraText,
  cancelText = '取消',
  onConfirm,
  onExtra,
  onCancel,
}: ConfirmModalProps) {
  return (
    <ModalShell title={title} onCancel={onCancel}>
      {message && <p className="m-modal-message">{message}</p>}
      <div className="m-modal-actions">
        {cancelText !== null && (
          <button className="m-btn" onClick={onCancel}>
            {cancelText}
          </button>
        )}
        {extraText && onExtra && (
          <button className="m-btn" onClick={onExtra}>
            <AppIcon name="save" size={16} />
            {extraText}
          </button>
        )}
        <button className={`m-btn${danger ? ' danger' : ' primary'}`} onClick={onConfirm}>
          {confirmText}
        </button>
      </div>
    </ModalShell>
  )
}
