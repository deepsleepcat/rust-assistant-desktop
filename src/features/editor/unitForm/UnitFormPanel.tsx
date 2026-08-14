/**
 * 单位表单面板（M14，任务 4）：以表单方式编辑单位文件。
 * - 按组（Core/Graphics/Attack/Movement/Turret）分组渲染字段；
 * - 必填/推荐标注；非法值即时提示（红框 + 错误信息）；
 * - 图片/音效字段可选取项目内资源（下拉选择，路径校验）；
 * - 变更即时写回文件内容（applyUnitFormValue → updateTabContent）。
 * 代码模式修改后切回表单会自动重新解析（每次渲染前 parseUnitForm）。
 */
import { useEffect, useMemo, useState } from 'react'
import type { EditorTab } from '../../../types/domain'
import { useWorkspaceStore } from '../../../stores/workspace'
import { getBridge } from '../../../services/bridge'
import { getEnToZhDict, getZhToEnDict } from '../../../services/codeData'
import { findUnitGroup, UNIT_FORM_GROUPS, type UnitFieldDef } from './unitFormFields'
import { applyUnitFormValue, fillDefaults, parseUnitForm, validateFormValue, type UnitFormState } from './unitFormSync'

interface UnitFormPanelProps {
  tab: EditorTab
  rootPath: string
}

/** 相对路径计算（渲染层无 node:path：手工按 / 分段处理 . 和 ..） */
function relativePath(fromDir: string, toPath: string): string {
  const from = fromDir.split('/').filter(Boolean)
  const to = toPath.split('/').filter(Boolean)
  let i = 0
  while (i < from.length && i < to.length && from[i] === to[i]) i++
  const up = from.length - i
  const rest = to.slice(i)
  return [...Array(up).fill('..'), ...rest].join('/')
}

/** 当前 tab 是否为单位文件（含 [core] 或中文 [核心] 节） */
export function isUnitFile(content: string): boolean {
  return /^\s*\[(?:core|核心)\]\s*(?:#.*)?$/im.test(content)
}

export function UnitFormPanel({ tab, rootPath }: UnitFormPanelProps) {
  const updateTabContent = useWorkspaceStore((s) => s.updateTabContent)
  // 表单值（每次内容变化重新解析；本地编辑态缓存带内容快照——
  // 内容外部变更（格式化/重新加载）后旧草稿自动失效，不覆盖新内容）
  const [draft, setDraft] = useState<Record<string, { value: string; content: string }> | null>(null)
  const [errors, setErrors] = useState<Record<string, { msg: string; content: string }>>({})
  const [resources, setResources] = useState<{ images: string[]; audios: string[] }>({ images: [], audios: [] })
  const [picking, setPicking] = useState<string | null>(null)

  // 项目内资源列表（图片/音频，相对项目根）
  useEffect(() => {
    let alive = true
    void getBridge()
      .mod.scanResources(rootPath)
      .then((scan) => {
        if (!alive) return
        const images: string[] = []
        const audios: string[] = []
        for (const f of scan.files ?? []) {
          const ext = f.slice(f.lastIndexOf('.') + 1).toLowerCase()
          if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'].includes(ext)) images.push(f)
          else if (['ogg', 'wav', 'mp3'].includes(ext)) audios.push(f)
        }
        setResources({ images, audios })
      })
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [rootPath])

  // 表单状态：内容变化（含外部编辑/撤销）重新解析，本地草稿失效；
  // 中文显示层传 zhToEn 词典（[核心]/名称/生命值 回译成英文键匹配字段定义）
  const formState: UnitFormState = useMemo(
    () => fillDefaults(parseUnitForm(tab.content, { zhToEn: tab.translationEnabled ? (k) => getZhToEnDict().get(k) : undefined })),
    [tab.content, tab.translationEnabled],
  )
  /** 提交表单值到文件（实时双向同步；中文显示层新键写回中文键名） */
  const commit = (groupSection: string, field: UnitFieldDef, value: string) => {
    const err = validateFormValue(field, value)
    setErrors((prev) => ({ ...prev, [`${groupSection}.${field.key}`]: { msg: err ?? '', content: tab.content } }))
    if (err) return // 非法值不写回（代码保持上一次合法值，表单显示红框）
    setDraft((prev) => ({ ...(prev ?? {}), [`${groupSection}.${field.key}`]: { value, content: tab.content } }))
    const enToZh = tab.translationEnabled ? (k: string) => getEnToZhDict().get(k) : undefined
    updateTabContent(tab.id, applyUnitFormValue(tab.content, groupSection, field.key, value.trim(), { enToZh }))
  }

  /** 资源选择：从项目内文件里选（相对单位文件目录） */
  const pickResource = (groupSection: string, field: UnitFieldDef) => {
    setPicking(`${groupSection}.${field.key}`)
  }

  // 必填字段缺失检测（加载即提示，不等待编辑）
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

  const fileDir = tab.path.includes('/') ? tab.path.slice(0, tab.path.lastIndexOf('/')) : ''

  return (
    <div className="unit-form">
      <div className="unit-form-head">
        <span>单位表单 · {tab.name}</span>
        <span className="unit-form-hint">修改即时同步到代码；切回代码模式可继续手写</span>
      </div>
      {missingRequired.length > 0 && (
        <div className="unit-form-missing">
          缺少必填字段：{missingRequired.map((m) => `${m.groupLabel}.${m.key}`).join('、')}——单位可能无法正常注册
        </div>
      )}
      <div className="unit-form-body">
        {UNIT_FORM_GROUPS.map((group) => {
          const values = formState[group.section] ?? []
          if (values.length === 0) return null
          return (
            <div key={group.section} className="unit-form-group">
              <div className="unit-form-group-title">
                [{group.section}] {group.label}
              </div>
              {values.map((v) => {
                const field = v ? findUnitGroup(group.section)?.fields.find((f) => f.key === v.key) : undefined
                if (!field) return null
                const key = `${group.section}.${field.key}`
                const errEntry = errors[key]
                const err = errEntry && errEntry.content === tab.content ? errEntry.msg : ''
                const draftEntry = draft?.[key]
                const draftValue = draftEntry && draftEntry.content === tab.content ? draftEntry.value : undefined
                // 文件中不存在的字段显示空（placeholder 提示默认值），不误导为已设置
                const value = draftValue !== undefined ? draftValue : v.present ? v.value : ''
                const isResourcePicker = picking === key
                const pool = field.resourceExts?.includes('ogg') || field.resourceExts?.includes('wav') ? resources.audios : resources.images
                return (
                  <div key={key} className={`unit-form-field${err ? ' has-error' : ''}`}>
                    <div className="unit-form-label">
                      <span title={field.description}>
                        {field.label}
                        {field.required && <em className="unit-form-required">必填</em>}
                        {field.recommended && !field.required && <em className="unit-form-recommended">推荐</em>}
                      </span>
                      <code className="unit-form-key">{field.key}</code>
                    </div>
                    <div className="unit-form-input-row">
                      {field.type === 'enum' ? (
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
                          placeholder={field.defaultValue ? `默认 ${field.defaultValue}` : ''}
                          onChange={(e) => commit(group.section, field, e.target.value)}
                        />
                      )}
                      {field.type === 'resource' && (
                        <button
                          className="btn"
                          style={{ padding: '2px 8px', fontSize: 11 }}
                          onClick={() => (isResourcePicker ? setPicking(null) : pickResource(group.section, field))}
                        >
                          {isResourcePicker ? '取消' : '选择…'}
                        </button>
                      )}
                    </div>
                    {err && <div className="unit-form-error">{err}</div>}
                    {!err && field.description && <div className="unit-form-desc">{field.description}</div>}
                    {isResourcePicker && (
                      <div className="unit-form-picker">
                        {pool.length === 0 ? (
                          <div className="unit-form-picker-empty">项目内没有匹配的资源文件</div>
                        ) : (
                          pool.map((f) => {
                            const rel = fileDir ? relativePath(fileDir, f) : f
                            return (
                              <button
                                key={f}
                                className="unit-form-picker-item"
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
