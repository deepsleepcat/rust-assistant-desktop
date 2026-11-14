/**
 * 单位表单面板（对齐桌面端 src/features/editor/unitForm/UnitFormPanel.tsx）：
 * 以表单方式编辑单位文件，替代在手机键盘上手写 INI。
 * - 按 Core/Graphics/Attack/Movement/Turret 分组渲染字段；
 * - 必填/推荐标注；非法值即时提示（红框 + 错误信息），非法值不写回；
 * - boolean/enum 字段用下拉选择（手机上比打字可靠）；
 * - 图片/音效字段可从项目内资源里选取（相对单位文件目录的路径写回）；
 * - 变更即时同步进编辑会话（updateEditorContent），由编辑器统一保存，
 *   中文显示层下写回保持文件原有键名语言。
 * 桌面端面板是编辑器侧栏；手机端为全屏覆盖层，关闭后回到代码视图继续保存。
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import type { EditSession } from '../editSession'
import { useWorkspace } from '../../../stores/workspace'
import { getBridge } from '../../../services/bridge'
import {
  getEnToZhDict,
  getKeyZhToEnDict,
  getSectionZhToEnDict,
  getZhToEnDict,
  loadCodeData,
} from '../../../services/codeData'
import { AppIcon } from '../../../components/AppIcon'
import { findUnitGroup, UNIT_FORM_GROUPS, type UnitFieldDef } from './unitFormFields'
import { applyUnitFormValue, fillDefaults, parseUnitForm, validateFormValue, type UnitFormState } from './unitFormSync'

interface UnitFormPanelProps {
  session: EditSession
  onClose: () => void
}

/** 相对路径计算（手工按 / 分段处理，与桌面端一致；无 node:path 依赖） */
function relativePath(fromDir: string, toPath: string): string {
  const from = fromDir.split('/').filter(Boolean)
  const to = toPath.split('/').filter(Boolean)
  let i = 0
  while (i < from.length && i < to.length && from[i] === to[i]) i++
  const up = from.length - i
  const rest = to.slice(i)
  return [...Array(up).fill('..'), ...rest].join('/')
}

/** 文件所在目录（session.path 为绝对路径） */
function dirOf(path: string): string {
  const idx = path.lastIndexOf('/')
  return idx > 0 ? path.slice(0, idx) : ''
}

type ZhToEn = (s: string) => string | undefined

export function UnitFormPanel({ session, onClose }: UnitFormPanelProps) {
  const updateEditorContent = useWorkspace((s) => s.updateEditorContent)
  const chineseMode = session.displayMode === 'zh'
  // 中文显示层需要词典（键/节/值分层回译）；加载完成前先按原文解析，加载后重算
  const [dictSeq, setDictSeq] = useState(0)
  useEffect(() => {
    if (!chineseMode) return
    let alive = true
    void loadCodeData().then(() => alive && setDictSeq((n) => n + 1))
    return () => {
      alive = false
    }
  }, [chineseMode])

  // 组合回译：节名 → 键名 → 通用词（值）。手机端 parseUnitForm 只收一个 zhToEn，
  // 三层词典合成一个查找链，语义与桌面端分层选项对齐；非中文模式不回译。
  const zhToEn: ZhToEn | undefined = useMemo(() => {
    if (!chineseMode) return undefined
    return (k) => getSectionZhToEnDict().get(k) ?? getKeyZhToEnDict().get(k) ?? getZhToEnDict().get(k)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chineseMode, dictSeq])

  // 表单值（每次内容变化重新解析；本地编辑态缓存带内容快照——
  // 内容外部变更（撤销/重新载入）后旧草稿自动失效，不覆盖新内容）
  const [draft, setDraft] = useState<Record<string, { value: string; content: string }> | null>(null)
  const [errors, setErrors] = useState<Record<string, { msg: string; content: string }>>({})

  // 项目内资源列表（图片/音频，相对项目根）
  const [resScan, setResScan] = useState<
    { status: 'loading' } | { status: 'error'; error: string } | { status: 'done'; images: string[]; audios: string[] }
  >({ status: 'loading' })
  const [resSeq, setResSeq] = useState(0)
  const [picking, setPicking] = useState<string | null>(null)
  const scanRootRef = useRef('')

  useEffect(() => {
    scanRootRef.current = session.rootPath
    let alive = true
    setResScan({ status: 'loading' })
    void getBridge()
      .mod.scanResources(session.rootPath)
      .then((scan) => {
        if (!alive) return
        const images: string[] = []
        const audios: string[] = []
        for (const f of scan.files ?? []) {
          const ext = f.slice(f.lastIndexOf('.') + 1).toLowerCase()
          if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'].includes(ext)) images.push(f)
          else if (['ogg', 'wav', 'mp3'].includes(ext)) audios.push(f)
        }
        setResScan({ status: 'done', images, audios })
      })
      .catch((err) => alive && setResScan({ status: 'error', error: err instanceof Error ? err.message : String(err) }))
    return () => {
      alive = false
    }
  }, [session.rootPath, resSeq])

  const retryResScan = () => setResSeq((n) => n + 1)
  const resources = resScan.status === 'done' ? { images: resScan.images, audios: resScan.audios } : { images: [], audios: [] }

  const formState: UnitFormState = useMemo(
    () => fillDefaults(parseUnitForm(session.content, { zhToEn })),
    [session.content, zhToEn],
  )

  /** 提交表单值到编辑会话（实时双向同步；中文显示层新键写回中文键名） */
  const commit = (groupSection: string, field: UnitFieldDef, value: string) => {
    const err = validateFormValue(field, value)
    setErrors((prev) => ({ ...prev, [`${groupSection}.${field.key}`]: { msg: err ?? '', content: session.content } }))
    if (err) return // 非法值不写回（内容保持上一次合法值，表单显示红框）
    setDraft((prev) => ({ ...(prev ?? {}), [`${groupSection}.${field.key}`]: { value, content: session.content } }))
    updateEditorContent(
      applyUnitFormValue(session.content, groupSection, field.key, value.trim(), {
        zhToEn,
        enToZh: chineseMode ? (k) => getEnToZhDict().get(k) : undefined,
      }),
    )
  }

  // 必填字段缺失检测（打开即提示，不等待编辑）
  const missingRequired = useMemo(() => {
    const missing: Array<{ groupLabel: string; key: string }> = []
    for (const group of UNIT_FORM_GROUPS) {
      const values = formState[group.section] ?? []
      for (const f of group.fields) {
        if (f.required) {
          const v = values.find((x) => x.key.toLowerCase() === f.key.toLowerCase())
          if (!v || !v.present || !v.value.trim()) missing.push({ groupLabel: group.label, key: f.key })
        }
      }
    }
    return missing
  }, [formState])

  const fileDir = dirOf(session.path)

  return (
    <div className="m-unitform" role="dialog" aria-label="单位表单">
      <header className="m-screen-header">
        <button className="m-btn" onClick={onClose} aria-label="返回编辑器">
          <AppIcon name="close" size={16} />
        </button>
        <h1 className="m-screen-title">单位表单 · {session.name}</h1>
      </header>
      <p className="m-unitform-hint">修改即时同步到代码，返回后点保存写入文件</p>
      <div className="m-scroll">
        {missingRequired.length > 0 && (
          <div className="m-unitform-missing">
            缺少必填字段：{missingRequired.map((m) => `${m.groupLabel}.${m.key}`).join('、')}——单位可能无法正常注册
          </div>
        )}
        {UNIT_FORM_GROUPS.map((group) => {
          const values = formState[group.section] ?? []
          if (values.length === 0) return null
          return (
            <div key={group.section} className="m-unitform-group">
              <div className="m-unitform-group-title">
                {group.label} <span className="m-unitform-section">[{group.section}]</span>
              </div>
              {values.map((v) => {
                const field = findUnitGroup(group.section)?.fields.find((f) => f.key === v.key)
                if (!field) return null
                const key = `${group.section}.${field.key}`
                const errEntry = errors[key]
                const err = errEntry && errEntry.content === session.content ? errEntry.msg : ''
                const draftEntry = draft?.[key]
                const draftValue = draftEntry && draftEntry.content === session.content ? draftEntry.value : undefined
                // 文件中不存在的字段显示空（placeholder 提示默认值），不误导为已设置
                const value = draftValue !== undefined ? draftValue : v.present ? v.value : ''
                const isResourcePicker = picking === key
                const pool =
                  field.resourceExts?.includes('ogg') || field.resourceExts?.includes('wav') ? resources.audios : resources.images
                return (
                  <div key={key} className={`m-unitform-field${err ? ' has-error' : ''}`}>
                    <div className="m-unitform-label">
                      <span title={field.description}>
                        {field.label} <span className="m-unitform-key">{field.key}</span>
                        {field.required && <em className="m-unitform-required">必填</em>}
                        {field.recommended && !field.required && <em className="m-unitform-recommended">推荐</em>}
                      </span>
                    </div>
                    <div className="m-unitform-input-row">
                      {field.type === 'enum' || field.type === 'boolean' ? (
                        <select value={value} onChange={(e) => commit(group.section, field, e.target.value)}>
                          <option value="">（未设置）</option>
                          {Object.entries(field.options ?? {}).map(([k, label]) => (
                            <option key={k} value={k}>
                              {k} · {label}
                            </option>
                          ))}
                        </select>
                      ) : (
                        <input
                          type={field.type === 'number' ? 'number' : 'text'}
                          value={value}
                          inputMode={field.type === 'number' ? 'decimal' : undefined}
                          placeholder={field.defaultValue ? `默认 ${field.defaultValue}` : ''}
                          onChange={(e) => commit(group.section, field, e.target.value)}
                        />
                      )}
                      {field.type === 'resource' && (
                        <button className="m-btn" onClick={() => (isResourcePicker ? setPicking(null) : setPicking(key))}>
                          {isResourcePicker ? '取消' : '选择…'}
                        </button>
                      )}
                    </div>
                    {err && <div className="m-unitform-error">{err}</div>}
                    {!err && field.description && <div className="m-unitform-desc">{field.description}</div>}
                    {isResourcePicker && (
                      <div className="m-unitform-picker">
                        {resScan.status === 'loading' ? (
                          <div className="m-unitform-picker-empty">正在扫描项目资源…</div>
                        ) : resScan.status === 'error' ? (
                          <div className="m-unitform-picker-empty">
                            资源扫描失败：{resScan.error}
                            <button className="m-btn" style={{ marginLeft: 8 }} onClick={retryResScan}>
                              重试
                            </button>
                          </div>
                        ) : pool.length === 0 ? (
                          <div className="m-unitform-picker-empty">项目内没有匹配的资源文件</div>
                        ) : (
                          pool.map((f) => {
                            const abs = `${session.rootPath}/${f}`
                            const rel = relativePath(fileDir, abs)
                            return (
                              <button
                                key={f}
                                className="m-unitform-picker-item"
                                onClick={() => {
                                  commit(group.section, field, rel)
                                  setPicking(null)
                                }}
                              >
                                {f}
                              </button>
                            )
                          })
                        )}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          )
        })}
      </div>
    </div>
  )
}
