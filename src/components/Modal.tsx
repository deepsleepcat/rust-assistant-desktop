/**
 * 通用弹窗与确认框。
 */
import type { ReactNode } from 'react'
import { useEffect, useId, useRef, useState } from 'react'
import { useWorkspaceStore } from '../stores/workspace'
import { IconClose } from './icons'
import { pushEscapeHandler, useEscapeHandler } from '../utils/modalStack'
import { useFocusTrap } from '../utils/focusTrap'
import type { DiffLine } from '../types/diff'

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
  const titleId = useId()
  const cardRef = useRef<HTMLDivElement>(null)
  // M29：打开时焦点移入弹窗（优先 [autofocus]）、Tab 循环、关闭后恢复原焦点
  useFocusTrap(cardRef, true)

  return (
    <div className="modal-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={cardRef} className={`modal-card${wide ? ' settings' : ''}`} role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <div className="modal-header" id={titleId}>
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
 * 避免 AI 写文件请求因弹窗藏在旧对话里而只能等主进程超时。
 * M9：弹窗内展示行级 diff（哪几行改了、改成什么），可展开/收起；拒绝后文件保持不变。
 * 外层只做「有审批就渲染」；内层以 key=请求 id 重挂载，展开状态随每次请求重置。 */
export function ApprovalDialog() {
  const pendingApproval = useWorkspaceStore((s) => s.pendingApproval)
  const respondApproval = useWorkspaceStore((s) => s.respondApproval)
  if (!pendingApproval) return null
  return <ApprovalDialogInner key={pendingApproval.id} req={pendingApproval} respondApproval={respondApproval} />
}

function ApprovalDialogInner({
  req,
  respondApproval,
}: {
  req: {
    id: string
    path: string
    contentPreview: string
    contentLength?: number
    diff?: DiffLine[] | null
    diffSummary?: { added: number; deleted: number } | null
    oldExists?: boolean
    newFile?: boolean
  }
  respondApproval: (approved: boolean) => Promise<void>
}) {
  // diff 不长（≤80 行）默认展开，超长默认收起
  const [diffOpen, setDiffOpen] = useState((req.diff?.length ?? 0) <= 80)
  const cardRef = useRef<HTMLDivElement>(null)
  // 审批弹窗打开时占住栈顶吞掉 Escape（审批不可用 Escape 关闭——必须显式选「允许/拒绝」，
  // 否则误关视觉下方的弹窗；也防止用户以为 Escape 能关掉审批）
  useEffect(() => {
    // 焦点移入弹窗容器（tabIndex=-1，不落在按钮上）：键盘/读屏用户感知焦点所在，
    // 且不会因用户正在输入时的 Enter 误触发「拒绝」
    cardRef.current?.focus()
    return pushEscapeHandler(() => { /* no-op：消费 Escape，防误关下层弹窗 */ })
  }, [])

  const diff: DiffLine[] | null = req.diff ?? null
  // 完整统计优先用主进程截断前算好的数字（diff 因行数上限折叠时数组计数会低估）
  const added = req.diffSummary?.added ?? diff?.filter((l) => l.type === 'add').length ?? 0
  const deleted = req.diffSummary?.deleted ?? diff?.filter((l) => l.type === 'del').length ?? 0

  return (
    <div className="modal-overlay">
      <div ref={cardRef} tabIndex={-1} style={{ outline: 'none' }} className="modal-card confirm-card" role="dialog" aria-modal="true" aria-label="AI 请求修改文件">
        <div className="modal-header">AI 请求修改文件</div>
        <div className="modal-body">
          <p style={{ margin: 0, fontSize: 13, fontWeight: 600 }}>
            {req.newFile && <span className="diff-badge" style={{ marginRight: 8 }}>新文件</span>}
            文件：{req.path}
          </p>
          {diff === null ? (
            // 无法计算 diff（文件过大/读取失败）：退回纯内容预览
            <>
              {typeof req.contentLength === 'number' && (
                <p style={{ margin: '4px 0 0', fontSize: 12, color: 'var(--text-2)' }}>
                  完整内容约 {req.contentLength} 字符，以下为前 2000 字符预览
                </p>
              )}
              <pre className="approval-preview">{req.contentPreview}</pre>
            </>
          ) : diff.length === 0 ? (
            <p style={{ margin: '6px 0 0', fontSize: 12, color: 'var(--text-2)' }}>
              内容与磁盘上的当前版本完全一致，本次写入不会产生实际改动
            </p>
          ) : (
            <>
              <p style={{ margin: '6px 0 0', fontSize: 12, color: 'var(--text-2)', display: 'flex', alignItems: 'center', gap: 8 }}>
                <span>
                  新增 {added} 行 · 删除 {deleted} 行
                  {typeof req.contentLength === 'number' && ` · 完整内容约 ${req.contentLength} 字符`}
                </span>
                <button
                  className="btn"
                  style={{ padding: '1px 8px', fontSize: 11, marginLeft: 'auto' }}
                  onClick={() => setDiffOpen((open) => !open)}
                  title={diffOpen ? '收起行级对比' : '展开行级对比'}
                >
                  {diffOpen ? '收起改动' : '展开改动'}
                </button>
              </p>
              {diffOpen && (
                <div className="diff-view" role="list" aria-label="改动前后对比">
                  {diff.map((line, i) => (
                    <div key={i} className={`diff-line ${line.type}`} role="listitem">
                      <span className="diff-mark">{line.type === 'add' ? '+' : line.type === 'del' ? '-' : line.type === 'omit' ? '…' : ' '}</span>
                      <span className="diff-text">{line.text || ' '}</span>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
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
  const titleId = useId()
  const cardRef = useRef<HTMLDivElement>(null)
  useFocusTrap(cardRef, true)

  return (
    <div className="modal-overlay" onMouseDown={(e) => e.target === e.currentTarget && onCancel()}>
      <div ref={cardRef} className={`modal-card confirm-card${danger ? ' danger' : ''}`} role="alertdialog" aria-modal="true" aria-labelledby={titleId}>
        <div className="modal-header" id={titleId}>{title}</div>
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
  const titleId = useId()
  const cardRef = useRef<HTMLDivElement>(null)

  // Escape 走全局弹窗栈（输入弹窗与其它弹窗叠放时只关最上层，不误丢输入内容）
  useEscapeHandler(onClose)
  useFocusTrap(cardRef, true)

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
      <div ref={cardRef} className="modal-card" role="dialog" aria-modal="true" aria-labelledby={titleId} style={{ width: 'min(400px, 100%)' }}>
        <form
          onSubmit={(e) => {
            e.preventDefault()
            submit()
          }}
        >
          <div className="modal-header" id={titleId}>{title}</div>
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
