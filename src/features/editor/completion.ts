/**
 * 自动补全：
 * - 行以 [ 开头未闭合 → 补全节名（needName 节补 [turret_ 占位）
 * - 无冒号行 → 补全键（当前节内优先）
 * - 有冒号行 → 按值类型补全值（list 候选 / @file 资源文件 / 单位名联想）
 * - 中文输入也能联想（code / translate 双语匹配）
 * - 中文模式提交时自动应用中文键/节名（保存时回译）
 * - int/float 类型键提交后自动补默认值（1 / 1.0）
 *
 * 数据源可注入（CompletionDataSource），便于单元测试；
 * 默认使用 codeData 的真实数据。
 */
import type { Completion, CompletionContext, CompletionResult } from '@codemirror/autocomplete'
import {
  findCodeByCode,
  findCodesByQuery,
  findCodesBySection,
  findSectionsByQuery,
  findValueType,
  getZhToEnDict,
  parseValueList,
  searchLogicBooleans,
  zhToEnKeySegments,
} from '../../services/codeData'
import { findSectionOfLine, isUnclosedSection, keyOfLine } from './rustLanguage'

/** 补全数据源接口（可注入） */
export interface CompletionDataSource {
  findSectionsByQuery(query: string, limit?: number): Array<{ code: string; translate: string; needName?: boolean }>
  findCodesBySection(section: string, query: string, limit?: number): Array<{ code: string; translate: string; description: string; type: string; section?: string }>
  findCodeByCode(code: string): { code: string; translate: string; description: string; type: string } | undefined
  findValueType(type: string): { external?: string; list?: string; describe?: string } | undefined
  findCodesByQuery(query: string, limit?: number): Array<{ code: string; translate: string; description: string; type: string }>
  /** 项目内资源文件（相对路径），供 @file(类型) 值补全 */
  listResourceFiles?: (exts: string[]) => Promise<string[]> | string[]
  /** 项目内单位名列表（[core] name: 值），供单位引用字段联想 */
  listUnitNames?: () => Promise<string[]> | string[]
}

/** 项目资源扫描结果（@file 文件列表 + 单位名列表） */
export interface ProjectResources {
  files: string[]
  unitNames: string[]
}

/** 默认数据源：真实 codeData */
export const realDataSource: CompletionDataSource = {
  findSectionsByQuery: (q, l) => findSectionsByQuery(q, l),
  findCodesBySection: (s, q, l) => findCodesBySection(s, q, l),
  findCodeByCode: (c) => findCodeByCode(c),
  findValueType: (t) => findValueType(t),
  findCodesByQuery: (q, l) => findCodesByQuery(q, l),
}

/**
 * 默认数据源 + 项目资源联想（@file 文件列表 / 单位名）。
 * 延迟引入 store 与桥，避免模块循环依赖；扫描结果按项目缓存，
 * 项目内容变化（刷新树/保存）时由外部调用 invalidateResourceCache() 失效。
 */
let resourceCache: { root: string; data: ProjectResources } | null = null

/** 项目内容变化后调用：清空资源缓存，下次补全重新扫描 */
export function invalidateResourceCache(): void {
  resourceCache = null
}

async function loadProjectResources(): Promise<ProjectResources | null> {
  const { useWorkspaceStore } = await import('../../stores/workspace')
  const state = useWorkspaceStore.getState()
  const project = state.projects.find((p) => p.id === state.activeProjectId)
  if (!project) return null
  if (resourceCache && resourceCache.root === project.rootPath) return resourceCache.data
  const { getBridge } = await import('../../services/bridge')
  // 扫描失败（如目录被锁）时降级为无资源联想，不让整个补全失效
  const data = await getBridge().mod.scanResources(project.rootPath).catch(() => null)
  if (!data) return null
  resourceCache = { root: project.rootPath, data }
  return data
}

export async function realResourcesDataSource(): Promise<CompletionDataSource> {
  const data = await loadProjectResources()
  return {
    ...realDataSource,
    listResourceFiles: async (exts) => {
      if (!data) return []
      const lower = exts.map((e) => e.toLowerCase())
      return data.files.filter((f) => lower.includes(f.split('.').pop()?.toLowerCase() ?? ''))
    },
    listUnitNames: async () => data?.unitNames ?? [],
  }
}

/** 中文模式开关（EditorArea 切换翻译时同步） */
let chineseMode = false
export function setCompletionChineseMode(on: boolean): void {
  chineseMode = on
}

/**
 * 当前标签的翻译追踪表（M9：由 EditorMirror 挂载时注入）。
 * 中文模式下补全提交的中文键/节名会登记「中文→英文」对，保存时才能回译成英文
 * （tracker 只在打开文件时由 enToZh 填充，补全新建的内容必须自己登记）。
 */
let completionTracker: Map<string, string> | null = null
export function setCompletionTracker(tracker: Map<string, string> | null): void {
  completionTracker = tracker
}

/**
 * 登记补全提交的「中文显示串 → 英文原文」到追踪表（保存时回译用）。
 * 返回是否可用中文提交：同译名已被别的键占用（如 内存→memory 与 memory.NAME）
 * 时返回 false，调用方改插英文原文——否则保存时该键会被回译成先登记的键，静默改键。
 */
function trackCommit(code: string, translate: string): boolean {
  if (!completionTracker || !translate || !code) return true // 未追踪/非中文：正常提交
  const existing = completionTracker.get(translate)
  if (existing === undefined) {
    completionTracker.set(translate, code)
    return true
  }
  return existing === code
}

/** 提交文本：中文模式用中文键/节名（保存时自动回译），否则英文原码（导出供测试） */
export function commitText(code: string, translate: string, suffix = ''): string {
  return (chineseMode && translate ? translate : code) + suffix
}

function toCompletion(c: { code: string; translate: string; description: string; type: string }, suffix = ''): Completion {
  // int/float 键提交后自动补默认值并选中，可直接覆盖输入
  const defaultVal = c.type === 'int' ? '1' : c.type === 'float' ? '1.0' : ''
  const text = commitText(c.code, c.translate, suffix)
  return {
    label: c.translate ? `${c.code} · ${c.translate}` : c.code,
    detail: c.description || undefined,
    type: 'property',
    apply: defaultVal
      ? (view, _completion, from, to) => {
          // M1：中文提交前登记追踪表；同译名撞键时改用英文原文（防保存回译改键）
          const ok = trackCommit(c.code, c.translate)
          const insert = (ok ? text : c.code + suffix) + defaultVal
          view.dispatch({
            changes: { from, to, insert },
            selection: { anchor: from + (ok ? text : c.code + suffix).length, head: from + insert.length },
          })
          return true
        }
      : (view, _completion, from, to) => {
          const ok = trackCommit(c.code, c.translate)
          view.dispatch({ changes: { from, to, insert: ok ? text : c.code + suffix } })
          return true
        },
  }
}

function toSectionCompletion(s: { code: string; translate: string; needName?: boolean }): Completion {
  // 提交文本：用户已输入 [ 时不再重复补 [（word 分隔符已把 [ 排除在词外；
  // 向前跳过空白判断，兼容 `[ tur` 这类写法）。base 可由调用方覆盖（撞键时用英文）
  const sectionTextWith = (view: import('@codemirror/view').EditorView, from: number, base: string, suffix: string) => {
    let i = from - 1
    while (i >= 0 && /[ \t]/.test(view.state.doc.sliceString(i, i + 1))) i--
    const before = i >= 0 ? view.state.doc.sliceString(i, i + 1) : ''
    const bracket = before === '[' ? '' : '['
    return bracket + base + suffix
  }
  // needName 节（turret/projectile 等）：补 [turret_ 并把光标停在 _ 后，等用户输入命名
  if (s.needName) {
    return {
      label: s.translate ? `${s.code} · ${s.translate}` : s.code,
      type: 'keyword',
      apply: (view, _completion, from, to) => {
        const ok = trackCommit(s.code, s.translate)
        const base = ok ? commitText(s.code, s.translate) : s.code
        const text = sectionTextWith(view, from, base, '_')
        view.dispatch({
          changes: { from, to, insert: text },
          selection: { anchor: from + text.length, head: from + text.length },
        })
        return true
      },
    }
  }
  return {
    label: s.translate ? `${s.code} · ${s.translate}` : s.code,
    type: 'keyword',
    apply: (view, _completion, from, to) => {
      const ok = trackCommit(s.code, s.translate)
      const base = ok ? commitText(s.code, s.translate) : s.code
      const text = sectionTextWith(view, from, base, ']')
      view.dispatch({ changes: { from, to, insert: text } })
      return true
    },
  }
}

/** 值补全：key 查类型 → 类型 list → 候选（中文模式下键是中文，先回译成英文再查） */
async function valueCompletions(key: string, query: string, data: CompletionDataSource): Promise<Completion[]> {
  // 中文显示层：key 可能是中文译名或分段翻译的宏字段（建造自_1_名称），
  // 整串回译失败时按 _ 分段回译（与 lint 的容错一致）
  let enKey = key
  let info = data.findCodeByCode(key)
  if (!info) {
    const back = getZhToEnDict().get(key) ?? zhToEnKeySegments(key)
    if (back && back !== key) {
      enKey = back
      info = data.findCodeByCode(back)
    }
  }
  const vt = info ? data.findValueType(info.type) : undefined
  const q = query.trim().toLowerCase()
  const result: Completion[] = []

  if (vt) {
    const items = parseValueList(vt.list)
    for (const v of items.filter((v) => !q || v.toLowerCase().includes(q))) {
      result.push({ label: v, type: 'value', apply: v })
    }

    // @file(类型)：扫描项目内资源文件（png/jpg/ogg/ini…）
    const fileExts = (vt.list ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.startsWith('@file('))
      .map((s) => s.match(/^@file\((.+)\)$/)?.[1] ?? '')
      .filter((s) => s.length > 0)
    if (fileExts.length > 0 && data.listResourceFiles) {
      const files = (await data.listResourceFiles(fileExts)) ?? []
      for (const f of files.filter((f) => !q || f.toLowerCase().includes(q))) {
        result.push({ label: f, type: 'value', apply: f })
      }
    }
  }

  // 逻辑布尔表达式：值里输入 self. 前缀 → 补全 139 条 self 方法（如 self.hp()）
  if (/^self\./.test(query)) {
    const names = searchLogicBooleans(query.slice(5), 30)
    for (const n of names) {
      const text = `self.${n.name}()`
      result.push({
        label: text,
        detail: n.description || undefined,
        type: 'value',
        apply: text,
      })
    }
  }

  // 单位名联想：builtFrom_1_name / canBuild_1_name 等引用字段（键不在代码表也能联想）
  if (data.listUnitNames && /_(name|tooltip)$/.test(enKey)) {
    const names = (await data.listUnitNames()) ?? []
    for (const n of names.filter((n) => !q || n.toLowerCase().includes(q))) {
      result.push({ label: n, type: 'value', apply: n })
    }
  }

  return result
}

/** 键补全：当前节内优先 */
function keyCompletions(section: string, query: string, data: CompletionDataSource): Completion[] {
  return data.findCodesBySection(section, query).map((c) => {
    const vt = data.findValueType(c.type)
    return toCompletion(c, vt?.external ?? '')
  })
}

/** 纯函数补全逻辑（供测试）：根据行上下文选择处理器 */
export async function computeRustCompletions(
  line: string,
  section: string,
  word: string,
  _query: string,
  _lineIndex: number,
  _lines: string[],
  data: CompletionDataSource = realDataSource,
): Promise<Completion[]> {
  // 1. 节补全：行以 [ 开头且未闭合
  if (isUnclosedSection(line)) {
    const inner = line.trimStart().slice(1)
    return data.findSectionsByQuery(inner).map(toSectionCompletion)
  }

  // 2. 值补全：行内有冒号
  const key = keyOfLine(line)
  if (key !== null) {
    // 值位置：只补值，不回退键补全（否则 Enter 会把已输入的值替换成 key:）
    return valueCompletions(key, word, data)
  }

  // 3. 键补全：无冒号行
  return keyCompletions(section, word, data).length > 0
    ? keyCompletions(section, word, data)
    : data.findCodesByQuery(word).map((c) => toCompletion(c))
}

/** CodeMirror 补全 source：根据光标上下文选择处理器 */
export async function rustCompletionSource(context: CompletionContext): Promise<CompletionResult | null> {
  const doc = context.state.doc
  const lineInfo = doc.lineAt(context.pos)
  const line = lineInfo.text
  const before = line.slice(0, context.pos - lineInfo.from)
  const lines = doc.toString().split('\n')
  const lineIndex = lineInfo.number - 1
  const section = findSectionOfLine(lines, lineIndex)
  // 分隔符包含 [ ] 等结构符号：光标前的「词」不含这些符号，
  // 保证节补全（[tur → from 指向 tur）等场景的替换范围正确
  const word = before.split(/[\s:;,()=[\]{}]+/).pop() ?? ''

  const data = await realResourcesDataSource()
  const completions = await computeRustCompletions(line, section, word, before, lineIndex, lines, data)

  if (completions.length === 0) return null
  const from = context.pos - word.length
  return { from, options: completions, validFor: /^[\w\u4e00-\u9fff]*$/ }
}
