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
import { pickedCompletion } from '@codemirror/autocomplete'
import { Transaction } from '@codemirror/state'
import {
  findCodeByCode,
  findCodesByQuery,
  findCodesBySection,
  findCodesByType,
  findSectionsByQuery,
  findValueType,
  findValueTypes,
  getDialectWords,
  getKeyZhToEnDict,
  getZhToEnDict,
  loadCodeData,
  parseValueList,
  searchLogicBooleans,
  zhToEnKeySegments,
} from '../../services/codeData'
import { findSectionOfLine, isUnclosedSection, keyOfLine, collectLocalVariables } from './rustLanguage'

/** 补全数据源接口（可注入） */
export interface CompletionDataSource {
  findSectionsByQuery(query: string, limit?: number): Array<{ code: string; translate: string; needName?: boolean }>
  findCodesBySection(section: string, query: string, limit?: number): Array<{ code: string; translate: string; description: string; type: string; section?: string }>
  findCodeByCode(code: string): { code: string; translate: string; description: string; type: string } | undefined
  findValueType(type: string): { external?: string; list?: string; describe?: string } | undefined
  /** M31：多值类型合并查询（float,logicBoolean → 全部命中段；未提供时回退 findValueType 单条） */
  findValueTypes?(type: string): Array<{ external?: string; list?: string; describe?: string }>
  findCodesByQuery(query: string, limit?: number): Array<{ code: string; translate: string; description: string; type: string }>
  /** 按值类型查代码（@type(类型) 关联联想） */
  findCodesByType(type: string, query?: string, limit?: number): Array<{ code: string; translate: string; description: string; type: string }>
  /** 项目内资源文件（相对路径），供 @file(类型) 值补全 */
  listResourceFiles?: (exts: string[]) => Promise<string[]> | string[]
  /** 项目内单位名列表（[core] name: 值），供单位引用字段联想 */
  listUnitNames?: () => Promise<string[]> | string[]
  /** M27-2：dialect 逻辑语法 token（谓词/调试函数等），逻辑值上下文补全 */
  findDialectWords?: (query: string, limit?: number) => Array<{ word: string; explanation: string }>
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
  findCodesByType: (t, q, l) => findCodesByType(t, q, l),
  findDialectWords: (q, l) => getDialectWords(q, l),
}

/**
 * 默认数据源 + 项目资源联想（@file 文件列表 / 单位名）。
 * 延迟引入 store 与桥，避免模块循环依赖；扫描结果按项目缓存，
 * 项目内容变化（刷新树/保存）时由外部调用 invalidateResourceCache() 失效。
 * 资源扫描惰性执行：只有值上下文真正需要 @file/@customType/单位名 时才发起
 * 全项目扫描，节/键补全不再被整个项目的递归 readdir 阻塞。
 */
let resourceCache: { root: string; data: ProjectResources | null; at: number } | null = null
/** 在途扫描去重（按项目根键控）：同一项目并发触发多次补全时只发起一次扫描；
 * 切项目瞬间不串用旧项目的在途结果 */
let resourceInflight: { root: string; promise: Promise<ProjectResources | null> } | null = null

/** 资源扫描超时（大项目/网络盘/锁目录）：超时放弃本次扫描降级为空资源，
 * 下次输入再试——不能为了一张候选图把整个补全卡死 */
const RESOURCE_SCAN_TIMEOUT_MS = 5000
/** 扫描失败（含超时）结果的缓存时长：失败也缓存避免大项目每次输入都重扫，
 * 但带 TTL——10s 后自然重试，项目变化另有 invalidateResourceCache() 立即刷新 */
const RESOURCE_FAIL_TTL_MS = 10_000

/** 带超时的 Promise（超时返回 fallback；原 Promise 的拒绝被吞掉防 unhandled rejection） */
export async function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  const guarded = promise.then(
    (v) => v,
    () => fallback,
  )
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      guarded,
      new Promise<T>((resolve) => {
        timer = setTimeout(() => resolve(fallback), ms)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/** 项目内容变化后调用：清空资源缓存，下次补全重新扫描 */
export function invalidateResourceCache(): void {
  resourceCache = null
}

async function loadProjectResources(): Promise<ProjectResources | null> {
  const { useWorkspaceStore } = await import('../../stores/workspace')
  const state = useWorkspaceStore.getState()
  const project = state.projects.find((p) => p.id === state.activeProjectId)
  if (!project) return null
  // 成功结果长期缓存；失败结果带 TTL（超时/失败后 10s 内不重扫，之后自然重试）
  if (resourceCache && resourceCache.root === project.rootPath) {
    if (resourceCache.data !== null || Date.now() - resourceCache.at < RESOURCE_FAIL_TTL_MS) {
      return resourceCache.data
    }
  }
  if (resourceInflight) {
    if (resourceInflight.root === project.rootPath) {
      return resourceInflight.promise
    }
    // 切项目瞬间：旧在途结果不属于当前项目，丢弃等待重新发起
    resourceInflight = null
  }
  resourceInflight = {
    root: project.rootPath,
    promise: (async () => {
      const { getBridge } = await import('../../services/bridge')
      // 扫描失败/超时（如目录被锁）时降级为无资源联想，不让整个补全失效
      const data = await withTimeout(getBridge().mod.scanResources(project.rootPath), RESOURCE_SCAN_TIMEOUT_MS, null).catch(() => null)
      resourceCache = { root: project.rootPath, data, at: Date.now() }
      return data
    })(),
  }
  try {
    return await resourceInflight.promise
  } finally {
    // 只清自己的在途条目：切项目后旧在途 promise 落地时不能清掉新项目刚建立的条目
    //（否则新项目同一输入会重复发起全量扫描）
    if (resourceInflight && resourceInflight.root === project.rootPath) resourceInflight = null
  }
}

export function realResourcesDataSource(): CompletionDataSource {
  return {
    ...realDataSource,
    findValueTypes: (t) => findValueTypes(t),
    listResourceFiles: async (exts) => {
      const data = await loadProjectResources()
      if (!data) return []
      const lower = exts.map((e) => e.toLowerCase())
      return data.files.filter((f) => lower.includes(f.split('.').pop()?.toLowerCase() ?? ''))
    },
    listUnitNames: async () => (await loadProjectResources())?.unitNames ?? [],
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
      ? (view, completion, from, to) => {
          // M1：中文提交前登记追踪表；同译名撞键时改用英文原文（防保存回译改键）
          const ok = trackCommit(c.code, c.translate)
          const insert = (ok ? text : c.code + suffix) + defaultVal
          view.dispatch({
            changes: { from, to, insert },
            selection: { anchor: from + (ok ? text : c.code + suffix).length, head: from + insert.length },
            // 标准补全事务标记：保留撤销分组/事件语义（否则 CM 不识别这次插入是补全提交）
            annotations: [pickedCompletion.of(completion), Transaction.userEvent.of('input.complete')],
          })
          return true
        }
      : (view, completion, from, to) => {
          const ok = trackCommit(c.code, c.translate)
          view.dispatch({
            changes: { from, to, insert: ok ? text : c.code + suffix },
            annotations: [pickedCompletion.of(completion), Transaction.userEvent.of('input.complete')],
          })
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
      apply: (view, completion, from, to) => {
        const ok = trackCommit(s.code, s.translate)
        const base = ok ? commitText(s.code, s.translate) : s.code
        const text = sectionTextWith(view, from, base, '_')
        view.dispatch({
          changes: { from, to, insert: text },
          selection: { anchor: from + text.length, head: from + text.length },
          annotations: [pickedCompletion.of(completion), Transaction.userEvent.of('input.complete')],
        })
        return true
      },
    }
  }
  return {
    label: s.translate ? `${s.code} · ${s.translate}` : s.code,
    type: 'keyword',
    apply: (view, completion, from, to) => {
      const ok = trackCommit(s.code, s.translate)
      const base = ok ? commitText(s.code, s.translate) : s.code
      const text = sectionTextWith(view, from, base, ']')
      view.dispatch({
        changes: { from, to, insert: text },
        annotations: [pickedCompletion.of(completion), Transaction.userEvent.of('input.complete')],
      })
      return true
    },
  }
}

/** 图片缩略图缓存：`项目id:相对路径` → dataURL（防跨项目同名路径串图；上限 200 条防内存膨胀） */
const thumbnailCache = new Map<string, string>()
const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'])

/** 懒加载项目图片为 dataURL（失败静默降级，不阻塞补全）；
 * projectId 由调用方捕获传入——补全弹出后、预览加载前切换项目也不串图 */
async function loadThumbnail(relPath: string, projectId?: string): Promise<string | null> {
  const { useWorkspaceStore } = await import('../../stores/workspace')
  const state = useWorkspaceStore.getState()
  const id = projectId ?? state.activeProjectId
  const project = state.projects.find((p) => p.id === id)
  if (!project) return null
  const key = `${id}:${relPath}`
  const cached = thumbnailCache.get(key)
  if (cached) return cached
  const { getBridge } = await import('../../services/bridge')
  const url = await getBridge().project.readImageAsDataUrl(project.rootPath, relPath).catch(() => null)
  if (url) {
    if (thumbnailCache.size > 200) thumbnailCache.clear()
    thumbnailCache.set(key, url)
  }
  return url
}

/** 图片文件补全项附加预览（对齐手机版：@file 图片项显示缩略图）：
 * 候选被选中时在详情区显示图片预览，懒加载 + 缓存防 IPC 风暴。
 * projectId 由调用方（async 上下文）捕获传入——预览异步加载期间切换项目也不取错项目的图。 */
function withThumbnail(c: Completion, projectId: string | null): Completion {
  const ext = (c.label.split('.').pop() ?? '').toLowerCase()
  if (!IMAGE_EXTS.has(ext)) return c
  return {
    ...c,
    info: async () => {
      const url = await loadThumbnail(c.label, projectId ?? undefined)
      if (!url) return null
      const img = document.createElement('img')
      img.src = url
      img.style.cssText =
        'max-width:160px;max-height:160px;object-fit:contain;display:block;border-radius:6px;'
      return img
    },
  }
}

/** 多值类型合并：data 提供 findValueTypes 用合并结果，否则回退单条（测试注入数据） */
function valueTypeInfos(data: CompletionDataSource, type: string): Array<{ external?: string; list?: string; describe?: string }> {
  if (data.findValueTypes) return data.findValueTypes(type)
  const single = data.findValueType(type)
  return single ? [single] : []
}

/**
 * @file 指令扩展名解析：兼容知识包复合格式（@file(apk{res/raw/}type{ogg,wav}) →
 * 取 type{...} 内的 ogg/wav；简单格式 @file(png) → png）。
 * 复合格式整体传下去会一个文件都匹配不到（listResourceFiles 按扩展名过滤）。
 */
function parseFileExts(spec: string): string[] {
  const open = spec.indexOf('(')
  const close = spec.lastIndexOf(')')
  const inner = open >= 0 && close > open ? spec.slice(open + 1, close) : spec
  const typeOpen = inner.indexOf('type{')
  if (typeOpen >= 0) {
    const typeClose = inner.indexOf('}', typeOpen + 5)
    if (typeClose > typeOpen) {
      return inner
        .slice(typeOpen + 5, typeClose)
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s.length > 0)
    }
  }
  return [inner]
}

/** 值补全：key 查类型 → 类型 list → 候选（中文模式下键是中文，先回译成英文再查） */
async function valueCompletions(key: string, query: string, data: CompletionDataSource): Promise<Completion[]> {
  // 中文显示层：key 可能是中文译名或分段翻译的宏字段（建造自_1_名称），
  // 整串回译失败时按 _ 分段回译（与 lint 的容错一致）。
  // 键位置回译先查键名表（键译名不被节名覆盖，如「价格」→price）
  let enKey = key
  let info = data.findCodeByCode(key)
  if (!info) {
    const back = getKeyZhToEnDict().get(key) ?? getZhToEnDict().get(key) ?? zhToEnKeySegments(key)
    if (back && back !== key) {
      enKey = back
      info = data.findCodeByCode(back)
    }
  }
  // 多值类型（float,logicBoolean）：合并所有命中段，与 lint 的 OR 语义一致
  const vts = info ? valueTypeInfos(data, info.type) : []
  const q = query.trim().toLowerCase()
  const result: Completion[] = []

  if (vts.length > 0) {
    // 合并 list 与特殊指令（去重保序）
    const items: string[] = []
    const directives: string[] = []
    for (const vt of vts) {
      for (const v of parseValueList(vt.list)) {
        if (!items.includes(v)) items.push(v)
      }
      for (const d of (vt.list ?? '').split(',').map((s) => s.trim()).filter((s) => s.startsWith('@'))) {
        if (!directives.includes(d)) directives.push(d)
      }
    }
    for (const v of items.filter((v) => !q || v.toLowerCase().includes(q))) {
      result.push({ label: v, type: 'value', apply: v })
    }

    // @file(类型)：扫描项目内资源文件（png/jpg/ogg/ini…）
    const fileExts = directives
      .filter((s) => s.startsWith('@file('))
      .flatMap((s) => parseFileExts(s))
      .filter((s) => s.length > 0)
    if (fileExts.length > 0 && data.listResourceFiles) {
      const files = (await data.listResourceFiles(fileExts)) ?? []
      // 捕获当前项目 id（缩略图预览用；模块级 store 需动态 import 避免循环依赖）
      const { useWorkspaceStore } = await import('../../stores/workspace')
      const pid = useWorkspaceStore.getState().activeProjectId
      for (const f of files.filter((f) => !q || f.toLowerCase().includes(q))) {
        result.push(withThumbnail({ label: f, type: 'value', apply: f }, pid))
      }
    }

    // @type(类型)：从代码库联想同类型的键（对齐手机版 findCodeByCodeInType，
    // 如 logicBoolean 键值 self.isFlying ← type=noParameterLogicStatement 的键）
    for (const d of directives) {
      const m = d.match(/^@type\((.+)\)$/)
      if (m) {
        for (const c of data.findCodesByType(m[1], query, 20)) {
          result.push(toCompletion(c))
        }
      }
    }

    // @customType(类型)：从当前模组联想自定义值（对齐手机版 FileDataBase.ValueTable；
    // 桌面版数据源 = 项目内单位名 [core] name，如 unit 值类型引用的 unitName）
    for (const d of directives) {
      const m = d.match(/^@customType\((.+)\)$/)
      if (m && data.listUnitNames) {
        const names = (await data.listUnitNames()) ?? []
        for (const n of names.filter((n) => !q || n.toLowerCase().includes(q))) {
          result.push({ label: n, type: 'value', apply: n })
        }
      }
    }
  }

  // 逻辑布尔表达式：值里输入 self. 前缀 → 补全 138 条 self 方法（如 self.hp()）
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

  // M27-2：逻辑值上下文（logicBoolean / 各逻辑语句类型）→ 补全 dialect 逻辑语法
  // token（谓词/调试函数/记忆关键词，如 isFlying、breadUnitMemory）——
  // 输入前缀即可命中，不用记完整拼写；无 dialect 数据时静默降级（可选方法）。
  // 多值类型（'float,logicBoolean'）按逗号分段判断（与 findValueType 语义一致）；
  // 空查询（刚输冒号）时压低数量，避免候选爆炸挤掉既有 list/@type 候选
  const isLogicType = info ? info.type.split(',').some((t) => LOGIC_VALUE_TYPES.has(t.trim())) : false
  if (isLogicType && data.findDialectWords) {
    for (const v of data.findDialectWords(q, q ? 30 : 10)) {
      result.push({ label: v.word, detail: v.explanation, type: 'value', apply: v.word })
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

/** M27-2：逻辑值类型集合——dialect 语法 token 在这些键的值位置补全
 *（logicConstants/noPromptLogicConstant 是常量场景（true/false/数字），不补谓词） */
const LOGIC_VALUE_TYPES = new Set([
  'logicBoolean',
  'logicQuantityStatement',
  'logicTimeStatement',
  'logicalConditionStatement',
  'simpleLogicalConditionStatement',
  'noParameterLogicStatement',
])

/** 键补全：当前节内优先 */
function keyCompletions(section: string, query: string, data: CompletionDataSource): Completion[] {
  return data.findCodesBySection(section, query).map((c) => {
    // 多值类型合并：external 取第一个非空段（如 float,logicBoolean → float 的 :）
    const vts = valueTypeInfos(data, c.type)
    const external = vts.find((v) => v.external)?.external ?? ''
    return toCompletion(c, external)
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
  // 数据未就绪/加载失败时显式等待（codeData 失败会置回 null，下次输入自动重试，
  // 不会整个会话永久失去补全/翻译）
  await loadCodeData()

  const doc = context.state.doc
  const lineInfo = doc.lineAt(context.pos)
  const line = lineInfo.text
  const before = line.slice(0, context.pos - lineInfo.from)
  const lines = doc.toString().split('\n')
  const lineIndex = lineInfo.number - 1
  const section = findSectionOfLine(lines, lineIndex)

  // 注释行不补全（# 开头；activateOnTyping 下否则会弹全局键候选干扰阅读）
  if (line.trimStart().startsWith('#')) return null

  // 分隔符包含 [ ] 等结构符号：光标前的「词」不含这些符号，
  // 保证节补全（[tur → from 指向 tur）等场景的替换范围正确
  const word = before.split(/[\s:;,()=[\]{}]+/).pop() ?? ''

  // 局部变量补全：行内 ${ 未闭合（对齐手机版 CodeAutoCompleteJob：
  // } 位置在 ${ 之前 → 响应变量），替换范围从 ${ 开始，避免插入后变成 ${{变量}}
  const dollarIdx = before.lastIndexOf('${')
  if (dollarIdx >= 0 && !before.slice(dollarIdx + 1).includes('}')) {
    const q = before.slice(dollarIdx + 2)
    const options = localVariableCompletions(lines, q)
    if (options.length > 0) {
      // validFor 必须匹配「从替换起点 ${ 到光标」的整段文本（CodeMirror 对整段做检查），
      // 否则每次输入都会判定失效 → 弹窗闪烁关闭再打开
      return { from: lineInfo.from + dollarIdx, options, validFor: /^\$\{[\w\u4e00-\u9fff]*$/ }
    }
  }

  // 空白/非键值普通行且输入词为空：只有显式触发（Ctrl+Space）才弹候选，
  // 避免 activateOnTyping 在空行/普通行弹出全局前 40 个键。
  // 未闭合节头（[ 开头）是节补全场景，不受此守卫影响
  const key = keyOfLine(line)
  if (key === null && !word && !context.explicit && !isUnclosedSection(line)) return null

  const data = realResourcesDataSource()
  const completions = await computeRustCompletions(line, section, word, before, lineIndex, lines, data)

  if (completions.length === 0) return null
  const from = context.pos - word.length
  // validFor 覆盖 self. / 资源路径（units/tank/t.png）等真实输入字符：
  // 旧规则只认字母数字汉字，输入 . / - 时旧候选立即失效导致列表闪烁/反复查询。
  // filter:false：候选已按输入词/中文说明/译名过滤过一遍，交给 CodeMirror 按
  // label 二次匹配会滤掉「中文命中但 label 是英文」的候选（dialect 词、@type 键）
  return { from, options: completions, validFor: /^[\w\u4e00-\u9fff./-]*$/, filter: false }
}

/** 局部变量补全候选（纯函数，供测试）：当前文件出现过的 ${名字} */
export function localVariableCompletions(lines: string[], query: string): Completion[] {
  const q = query.trim()
  return collectLocalVariables(lines)
    .filter((v) => !q || v.toLowerCase().includes(q.toLowerCase()))
    .map((v) => ({
      label: v,
      type: 'variable',
      apply: `\${${v}}`,
    }))
}
