/**
 * 单位表单面板（对齐桌面端 src/features/editor/unitForm/UnitFormPanel.tsx）：
 * 以表单方式编辑单位文件，替代在手机键盘上手写 INI。
 * - 按 Core/Graphics/Attack/Movement 分组渲染；炮塔按实际节（turret_1/turret_2/…）
 *   独立实例渲染，可添加/删除（多炮塔字段不再混在一起）；
 * - 草稿三态（表单审计 P1/P2）：输入先保留草稿不被逐字校验弹回；number 完整且合法、
 *   其他类型合法时即时同步代码；中间态/非法值只留草稿，失焦或关闭时校验；
 *   打开面板即校验文件中已有的非法值；重复键提示生效行（游戏读最后一处）；
 * - boolean/enum 字段用下拉选择；图片/音效可从项目内资源选取，
 *   路径统一到项目根坐标再算相对单位目录（不再出现 ../../.. 误路径）；
 * - 变更同步进编辑会话（updateEditorContent），由编辑器统一保存。
 * 桌面端面板是编辑器侧栏；手机端为全屏覆盖层，关闭后回到代码视图继续保存。
 */
import { useEffect, useMemo, useState } from 'react'
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
import { ConfirmModal } from '../../../components/MobileDialog'
import { UNIT_FORM_GROUPS, findUnitGroup, type UnitFieldDef, type UnitFieldGroup } from './unitFormFields'
import {
  appendTurretSection,
  applyUnitFormValue,
  fillDefaults,
  isCompleteNumber,
  nextTurretSectionName,
  parseUnitForm,
  removeUnitSection,
  unitResourceRelPath,
  validateFormValue,
  type UnitFormState,
} from './unitFormSync'

interface UnitFormPanelProps {
  session: EditSession
  onClose: () => void
}

/** 字段输入草稿（content 快照失配时自动失效，不覆盖外部变更的新内容） */
interface FieldDraft {
  raw: string
  content: string
  /** 输入过（区分「打开时的既有值」与「用户正在编辑」） */
  dirty: boolean
  /** 失焦过（输入过程中不报格式错误，失焦后才严格提示） */
  settled: boolean
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

  // 组合回译：节名 → 键名 → 通用词（值）。三层词典合成一个查找链，语义与桌面端分层选项对齐
  const zhToEn: ZhToEn | undefined = useMemo(() => {
    if (!chineseMode) return undefined
    return (k) => getSectionZhToEnDict().get(k) ?? getKeyZhToEnDict().get(k) ?? getZhToEnDict().get(k)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chineseMode, dictSeq])

  const enToZh = useMemo(
    () => (chineseMode ? (k: string) => getEnToZhDict().get(k) : undefined),
    [chineseMode, dictSeq],
  )

  // 输入草稿（key = 节名.字段名）
  const [drafts, setDrafts] = useState<Record<string, FieldDraft>>({})
  // 待删除的炮塔节名（确认弹窗）
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null)

  // 项目内资源列表（图片/音频，相对项目根）
  const [resScan, setResScan] = useState<
    { status: 'loading' } | { status: 'error'; error: string } | { status: 'done'; images: string[]; audios: string[] }
  >({ status: 'loading' })
  const [resSeq, setResSeq] = useState(0)
  const [picking, setPicking] = useState<string | null>(null)

  useEffect(() => {
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

  /** 渲染顺序：非炮塔组按组名；炮塔组按文件中的实际节（turret_1/turret_2/…）逐实例 */
  const sectionKeys = useMemo(() => {
    const keys: Array<{ group: UnitFieldGroup; sectionName: string }> = []
    for (const group of UNIT_FORM_GROUPS) {
      if (group.section === 'turret') {
        for (const k of Object.keys(formState).filter((k) => /^turret(_|$)/.test(k))) {
          keys.push({ group, sectionName: k })
        }
      } else {
        keys.push({ group, sectionName: group.section })
      }
    }
    return keys
  }, [formState])

  const syncValue = (sectionName: string, field: UnitFieldDef, value: string, baseContent: string = session.content) => {
    updateEditorContent(
      applyUnitFormValue(baseContent, sectionName, field.key, value.trim(), { zhToEn, enToZh }),
    )
  }

  /** 输入草稿：任何输入先保留（不被逐字校验弹回）；完整且合法的值即时同步 */
  const onChangeInput = (sectionName: string, field: UnitFieldDef, raw: string) => {
    const key = `${sectionName}.${field.key}`
    setDrafts((prev) => ({ ...prev, [key]: { raw, content: session.content, dirty: true, settled: false } }))
    const complete = field.type === 'number' ? isCompleteNumber(raw) : true
    if (complete && !validateFormValue(field, raw)) {
      syncValue(sectionName, field, raw)
    }
  }

  /** 下拉/资源点选 = 明确确认，直接校验并同步 */
  const onPickValue = (sectionName: string, field: UnitFieldDef, value: string) => {
    const key = `${sectionName}.${field.key}`
    setDrafts((prev) => ({ ...prev, [key]: { raw: value, content: session.content, dirty: true, settled: true } }))
    if (!validateFormValue(field, value)) syncValue(sectionName, field, value)
  }

  /** 失焦：草稿仍停留在这个内容上才结算（同步/标错） */
  const onBlurInput = (sectionName: string, field: UnitFieldDef) => {
    const key = `${sectionName}.${field.key}`
    setDrafts((prev) => {
      const d = prev[key]
      if (!d || d.content !== session.content) return prev
      return { ...prev, [key]: { ...d, settled: true } }
    })
  }

  /** 关闭面板：把「完整且合法」的未同步草稿刷进编辑会话（幂等；中间态/非法草稿不生效） */
  const flushDraftsAndClose = () => {
    let content = session.content
    let changed = false
    for (const [key, d] of Object.entries(drafts)) {
      if (d.content !== session.content || !d.dirty) continue
      const dot = key.indexOf('.')
      const sectionName = key.slice(0, dot)
      const field = findUnitGroup(sectionName)?.fields.find((f) => f.key === key.slice(dot + 1))
      if (!field) continue
      const complete = field.type === 'number' ? isCompleteNumber(d.raw) : true
      if (!complete || validateFormValue(field, d.raw)) continue
      content = applyUnitFormValue(content, sectionName, field.key, d.raw.trim(), { zhToEn, enToZh })
      changed = true
    }
    if (changed) updateEditorContent(content)
    onClose()
  }

  const addTurret = () => {
    updateEditorContent(appendTurretSection(session.content, nextTurretSectionName(session.content)))
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

  return (
    <div className="m-unitform" role="dialog" aria-label="单位表单">
      <header className="m-screen-header">
        <button className="m-btn" onClick={flushDraftsAndClose} aria-label="返回编辑器">
          <AppIcon name="close" size={16} />
        </button>
        <h1 className="m-screen-title">单位表单 · {session.name}</h1>
      </header>
      <p className="m-unitform-hint">合法修改即时同步到代码，返回后点保存写入文件</p>
      <div className="m-scroll">
        {missingRequired.length > 0 && (
          <div className="m-unitform-missing">
            缺少必填字段：{missingRequired.map((m) => `${m.groupLabel}.${m.key}`).join('、')}——单位可能无法正常注册
          </div>
        )}
        {sectionKeys.map(({ group, sectionName }) => {
          const values = formState[sectionName] ?? []
          if (values.length === 0) return null
          const isTurretInstance = group.section === 'turret'
          return (
            <div key={sectionName} className="m-unitform-group">
              <div className="m-unitform-group-title">
                {isTurretInstance ? `${group.label} · ${sectionName}` : group.label}{' '}
                <span className="m-unitform-section">[{sectionName}]</span>
                {isTurretInstance && (
                  <button className="m-btn" style={{ marginLeft: 'auto' }} onClick={() => setConfirmRemove(sectionName)} aria-label={`删除 ${sectionName}`}>
                    <AppIcon name="delete" size={14} />
                  </button>
                )}
              </div>
              {values.map((v) => {
                const field = findUnitGroup(sectionName)?.fields.find((f) => f.key === v.key)
                if (!field) return null
                const key = `${sectionName}.${field.key}`
                const draftEntry = drafts[key]
                const draftActive = draftEntry !== undefined && draftEntry.content === session.content
                // 文件中不存在的字段显示空（placeholder 提示默认值），不误导为已设置
                const value = draftActive ? draftEntry.raw : v.present ? v.value : ''
                // 错误来源：number 完整值非法即时提示；其余类型失焦后才严格提示
                //（输入过程中允许未完成状态，不被逐字校验弹回）；或打开面板时文件里已有的非法值
                let err = ''
                if (draftActive) {
                  const e = validateFormValue(field, draftEntry.raw)
                  const complete = field.type === 'number' ? isCompleteNumber(draftEntry.raw) : false
                  if (e && (complete || draftEntry.settled)) err = e
                  else if (!e && field.type === 'number' && !complete && draftEntry.settled) err = '数值未输入完成，尚未写入代码'
                } else if (v.present) {
                  const e = validateFormValue(field, v.value)
                  if (e) err = `文件中已有非法值：${e}`
                }
                const isResourcePicker = picking === key
                const pool =
                  field.resourceExts?.includes('ogg') || field.resourceExts?.includes('wav') ? resources.audios : resources.images
                const duplicated = (v.dupLines?.length ?? 0) > 1
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
                        <select
                          value={value}
                          aria-label={`${field.label}（${field.key}）`}
                          onChange={(e) => onPickValue(sectionName, field, e.target.value)}
                        >
                          <option value="">（未设置）</option>
                          {Object.entries(field.options ?? {}).map(([k, label]) => (
                            <option key={k} value={k}>
                              {k} · {label}
                            </option>
                          ))}
                        </select>
                      ) : (
                        <input
                          // number 也用 text + inputMode：浏览器 number 控件会把「1.」「-」等
                          // 中间态吞成空串，导致草稿丢失（表单审计 P2）
                          type="text"
                          value={value}
                          inputMode={field.type === 'number' ? 'decimal' : undefined}
                          placeholder={field.defaultValue ? `默认 ${field.defaultValue}` : ''}
                          aria-label={`${field.label}（${field.key}）`}
                          aria-invalid={err ? true : undefined}
                          onChange={(e) => onChangeInput(sectionName, field, e.target.value)}
                          onBlur={() => onBlurInput(sectionName, field)}
                        />
                      )}
                      {field.type === 'resource' && (
                        <button className="m-btn" onClick={() => (isResourcePicker ? setPicking(null) : setPicking(key))}>
                          {isResourcePicker ? '取消' : '选择…'}
                        </button>
                      )}
                    </div>
                    {duplicated && (
                      <div className="m-unitform-desc">
                        ⚠ 文件中有 {v.dupLines!.length} 处 {field.key}（第 {v.dupLines!.join('、')} 行），游戏使用最后一处；修改已应用到生效行，建议清理其余重复
                      </div>
                    )}
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
                            // 资源与单位统一到项目根坐标再算相对路径（同目录 → body.png，不再 ../../..）
                            const rel = unitResourceRelPath(session.path, session.rootPath, f)
                            return (
                              <button
                                key={f}
                                className="m-unitform-picker-item"
                                onClick={() => {
                                  onPickValue(sectionName, field, rel)
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
        <div className="m-unitform-group">
          <button className="m-btn" onClick={addTurret}>
            <AppIcon name="plus" size={14} /> 添加炮塔
          </button>
        </div>
      </div>
      {confirmRemove && (
        <ConfirmModal
          title={`删除 ${confirmRemove}？`}
          message="将删除整个炮塔节（含节内全部字段）。代码仍需点保存才写入文件。"
          confirmText="删除"
          danger
          onCancel={() => setConfirmRemove(null)}
          onConfirm={() => {
            updateEditorContent(removeUnitSection(session.content, confirmRemove, { zhToEn }))
            setConfirmRemove(null)
          }}
        />
      )}
    </div>
  )
}
