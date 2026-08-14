/**
 * 通用弹窗与确认框。
 */
import type { ReactNode } from 'react'
import { useEffect, useRef, useState } from 'react'
import { useWorkspaceStore } from '../stores/workspace'
import { IconClose } from './icons'
import { pushEscapeHandler, useEscapeHandler } from '../utils/modalStack'

interface ModalProps {
  title: ReactNode
  onClose: () => void
  children: ReactNode
  footer?: ReactNode
  wide?: boolean
}

export function Modal({ title, onClose, children, footer, wide }: ModalProps) {
  // Escape 走全局弹窗栈（多弹窗叠放时只关最上层）
  useEscapeHandler(onClose)

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
  const saveThen = confirm?.saveThen
  const cancelledRef = useRef(false)
  useEffect(() => {
    cancelledRef.current = false
  }, [confirm])
  if (!confirm) return null
  // 确认框是全局最上层组件之一：Escape 经弹窗栈分发到 ConfirmBox 内部处理
  const cancel = () => {
    // 保存进行中按 Escape/取消：标记已取消，保存完成后不再执行 done（否则用户
    // 已取消却照样切换项目/关标签）；同时通知确认方（resolve 挂起的调用方）
    cancelledRef.current = true
    confirm.onCancel?.()
    dismiss()
  }
  return (
    <ConfirmBox
      title={confirm.title}
      message={confirm.message}
      danger={confirm.danger}
      confirmText={confirm.confirmText}
      cancelText={confirm.cancelText}
      extra={
        saveThen && (
          <button
            className="btn primary"
            onClick={() => {
              void (async () => {
                // 保存成功且未被取消才关闭并继续；失败（外部修改拦截等）保留弹窗由用户决定
                if (await saveThen.save()) {
                  if (cancelledRef.current) return // 保存期间被取消：放弃后续动作
                  dismiss()
                  saveThen.done()
                }
              })()
            }}
          >
            {saveThen.label}
          </button>
        )
      }
      onCancel={cancel}
      onConfirm={() => {
        dismiss()
        confirm.onConfirm()
      }}
    />
  )
}

/** 全局 AI 审批弹窗：独立于对话视图渲染——切换对话/无对话时审批仍可见可操作，
 * 避免 AI 写文件请求因弹窗藏在旧对话里而只能等主进程超时 */
export function ApprovalDialog() {
  const pendingApproval = useWorkspaceStore((s) => s.pendingApproval)
  const respondApproval = useWorkspaceStore((s) => s.respondApproval)
  const cardRef = useRef<HTMLDivElement>(null)
  // 审批弹窗打开时占住栈顶吞掉 Escape（审批不可用 Escape 关闭——必须显式选「允许/拒绝」，
  // 否则误关视觉下方的弹窗；也防止用户以为 Escape 能关掉审批）。无审批时不注册（不占栈）
  const hasApproval = pendingApproval !== null
  useEffect(() => {
    if (!hasApproval) return
    // 焦点移入弹窗容器（tabIndex=-1，不落在按钮上）：键盘/读屏用户感知焦点所在，
    // 且不会因用户正在输入时的 Enter 误触发「拒绝」
    cardRef.current?.focus()
    return pushEscapeHandler(() => { /* no-op：消费 Escape，防误关下层弹窗 */ })
  }, [hasApproval])
  if (!pendingApproval) return null
  return (
    <div className="modal-overlay">
      <div ref={cardRef} tabIndex={-1} style={{ outline: 'none' }} className="modal-card confirm-card" role="dialog" aria-modal="true" aria-label="AI 请求修改文件">
        <div className="modal-header">AI 请求修改文件</div>
        <div className="modal-body">
          <p style={{ margin: 0, fontSize: 13, fontWeight: 600 }}>文件：{pendingApproval.path}</p>
          {typeof pendingApproval.contentLength === 'number' && (
            <p style={{ margin: '4px 0 0', fontSize: 12, color: 'var(--text-2)' }}>
              完整内容约 {pendingApproval.contentLength} 字符，以下为前 2000 字符预览
            </p>
          )}
          <pre className="approval-preview">{pendingApproval.contentPreview}</pre>
        </div>
        <div className="modal-footer">
          <button className="btn" onClick={() => void respondApproval(false)}>拒绝</button>
          <button className="btn primary" onClick={() => void respondApproval(true)}>允许写入</button>
        </div>
      </div>
    </div>
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
  // Escape 走全局弹窗栈（确认框与其它弹窗叠放时只关最上层）
  useEscapeHandler(onCancel)

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
  /** 预设后缀（如 ['.ini', '.template', '.txt']）：点击自动追加/替换到文件名，未写后缀提交时自动补上 */
  suffixes?: string[]
  /** 作为文件名校验（新建/重命名）：非法字符/Windows 保留名/尾点空格在提交前拦截，与主进程规则一致 */
  validateName?: boolean
  onSubmit: (value: string) => void
  onClose: () => void
}

/** Windows 文件名校验（与主进程 assertValidName 对称，前端先拦一层，错误提示更友好） */
export function validateFileName(name: string): string | null {
  if (!name.trim()) return '名称不能为空'
  // eslint-disable-next-line no-control-regex -- 控制字符在文件名里不可见且易被滥用
  if (/[<>:"/\\|?*\x00-\x1f]/.test(name)) return '名称包含非法字符（< > : " / \\ | ? *）'
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(name)) return `「${name}」是系统保留名，无法使用`
  if (/[. ]$/.test(name)) return '名称不能以点或空格结尾'
  return null
}

export function PromptModal({ title, initialValue = '', placeholder, confirmText = '确定', suffixes, validateName, onSubmit, onClose }: PromptModalProps) {
  const [value, setValue] = useState(initialValue)
  const [suffix, setSuffix] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  // Escape 走全局弹窗栈（输入弹窗与其它弹窗叠放时只关最上层，不误丢输入内容）
  useEscapeHandler(onClose)

  /** 应用预设后缀：替换已存在的后缀；名字为空时仅记录选择（提交时自动补） */
  const applySuffix = (s: string) => {
    setSuffix(s)
    setError(null)
    if (!value.trim()) return
    setValue(value.replace(/\.[^./\\]+$/, '') + s)
  }

  const submit = () => {
    let name = value.trim()
    if (!name) return
    if (!/\.[^./\\]+$/.test(name) && suffix) name += suffix
    if (validateName) {
      const err = validateFileName(name)
      if (err) {
        setError(err)
        return
      }
    }
    onSubmit(name)
  }

  return (
    <div className="modal-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal-card" role="dialog" aria-modal="true" style={{ width: 'min(400px, 100%)' }}>
        <form
          onSubmit={(e) => {
            e.preventDefault()
            submit()
          }}
        >
          <div className="modal-header">{title}</div>
          <div className="modal-body">
            <input
              name="value"
              autoFocus
              value={value}
              onChange={(e) => { setValue(e.target.value); if (error) setError(null) }}
              placeholder={placeholder}
              style={{
                width: '100%',
                border: `1px solid ${error ? 'var(--danger)' : 'var(--border)'}`,
                borderRadius: 'var(--radius-sm)',
                background: 'var(--bg-input)',
                color: 'var(--text-1)',
                font: '14px var(--font-ui)',
                padding: '9px 12px',
                outline: 'none',
              }}
            />
            {error && <p style={{ margin: '6px 0 0', fontSize: 12, color: 'var(--danger)' }}>{error}</p>}
            {suffixes && suffixes.length > 0 && (
              <div className="suffix-presets">
                {suffixes.map((s) => (
                  <button
                    key={s}
                    type="button"
                    className={`suffix-chip${suffix === s ? ' active' : ''}`}
                    onClick={() => applySuffix(s)}
                  >
                    {s}
                  </button>
                ))}
              </div>
            )}
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
