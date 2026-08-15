/**
 * 编辑器错误检查（lint）：
 * - 值合法性：按代码表值类型的 rule 正则校验 key: value 的值部分，
 *   不合法时在值下方标波浪线（红色错误标记）；
 * - 节外代码：key 值行不在任何 [节] 内时给出警告；
 * - 兼容处理：行内注释剥离、中文模式值回译（是/真 → true）、
 *   NONE/AUTO/SHARED 常量放行、变量引用 ${...} 放行。
 *
 * 数据来源：value_type.json 的 rule 字段（与自动补全共用 codeData）。
 */
import { linter } from '@codemirror/lint'
import type { EditorView } from '@codemirror/view'
import type { ValueTypeInfo } from '../../services/codeData'
import { findCodeByCode, findValueType, getAllCodes, getKeyZhToEnDict, getZhToEnDict, loadCodeData, versionNameToNumber, zhToEnKeySegments } from '../../services/codeData'
import { classifyLine } from './rustLanguage'
import { runSemanticChecks, semanticIssuesToDiagnostics, type CustomRule } from './semanticChecks'
import { defaultSemanticCheckerConfig, enabledRuleIds } from './semanticChecks/registry'
import { loadProjectRuleSets } from './semanticChecks/customRules'

/** 规则描述「整行/键」而非「值」的类型：值校验时跳过，避免误报 */
const LINE_LEVEL_TYPES = new Set(['key', 'section', 'value', 'notes', 'define', 'prefixKey', 'code'])

/** 游戏内特殊常量：对这些常量一律放行（image/audio/path 等字段常见） */
const SPECIAL_CONSTANTS = new Set(['NONE', 'AUTO', 'SHARED'])

/** spawnUnits 参数白名单（引擎 ci.java:89-151 的 UnitList 参数；统一小写存储，匹配大小写不敏感） */
const SPAWN_UNITS_PARAMS = new Set([
  'neutralteam', 'settoteamoflastattacker', 'aggressiveteam', 'spawnchance', 'maxspawnlimit', 'techlevel',
  'gridalign', 'skipifoverlapping', 'falling', 'transportedunitstotransfer', 'alwaysstartdiratzero',
  'alwaystartdiratzero', 'offsetx', 'offsety', 'offsetrandomxy', 'offsetrandomx', 'offsetrandomy',
  'offsetheight', 'offsetrandomdir', 'offsetdir', 'addresources', 'spawnsource', 'copywaypointsfrom',
])

/** 按逗号分段（括号深度内的逗号不算分隔；spawnUnits 参数值可含函数调用嵌套） */
function splitTopLevel(value: string): string[] {
  const segs: string[] = []
  let depth = 0
  let cur = ''
  for (const ch of value) {
    if (ch === '(') depth++
    else if (ch === ')') depth = Math.max(0, depth - 1)
    if (ch === ',' && depth === 0) {
      segs.push(cur)
      cur = ''
      continue
    }
    cur += ch
  }
  segs.push(cur)
  return segs
}

/**
 * spawnUnits 值结构校验（引擎 ci.java:55-80）：
 * 「单位名[*数量][(参数=值,...)]」逗号分段（括号内逗号不算分隔），
 * 参数名必须在白名单且值非空。
 * 单位名本身任意（项目内是否存在由 checkRiskyUnitReferenceSemantics 检查）。
 */
function validateSpawnUnits(value: string): string | null {
  const v = value.trim()
  if (!v) return null
  for (const raw of splitTopLevel(v)) {
    const seg = raw.trim()
    if (!seg) continue
    const open = seg.indexOf('(')
    if (open === -1) {
      // 无参数：允许 单位名 或 单位名*数量
      if (!/^[^,()]+(?:\*\d+)?$/.test(seg)) return 'spawnUnits 值应为「单位名」或「单位名*数量」'
      continue
    }
    if (!seg.endsWith(')')) return 'spawnUnits 参数段应以 ) 结尾'
    const head = seg.slice(0, open)
    if (!/^[^,()]+(?:\*\d+)?$/.test(head)) return 'spawnUnits 单位名段格式不正确'
    const params = seg.slice(open + 1, -1)
    if (!params.trim()) return 'spawnUnits 参数段不能为空'
    for (const partRaw of splitTopLevel(params)) {
      const part = partRaw.trim()
      if (!part) continue
      const eq = part.indexOf('=')
      if (eq <= 0) return `spawnUnits 参数「${part}」缺少 = 分隔`
      const name = part.slice(0, eq).trim()
      const val = part.slice(eq + 1).trim()
      if (!SPAWN_UNITS_PARAMS.has(name.toLowerCase())) return `spawnUnits 参数「${name}」未知`
      if (!val) return `spawnUnits 参数「${name}」缺少值`
    }
  }
  return null
}

/**
 * 枚举类类型校验（rule 为空但 list 非空，如 autoTriggerOnEvent/drawType）：
 * 值 = 「成员[(参数)]」逗号分隔列表（引擎按括号感知逗号分段，如
 * autoTriggerOnEvent: created,teamChanged 多事件合法；newMessage(withTag="a,b")
 * 参数段内逗号不算分隔）——每段的基础名必须命中 list 的基础名（忽略大小写；
 * list 条目自身可带参数示例，如 queueItemAdded(withActionTag="#")，比较时剥掉；
 * list 为逗号分隔字符串或数组，两形态兼容）。
 * 返回 null 表示合法；否则返回错误消息。
 */
function validateEnumList(value: string, list: string[] | string, key: string, type: string): string | null {
  const items = typeof list === 'string' ? list.split(',') : list
  // 每条目取括号前的基础名（示例参数不影响枚举成员判定）
  const listLower = new Set(
    items.map((s) => {
      const t = s.trim()
      const open = t.indexOf('(')
      return (open > 0 && t.endsWith(')') ? t.slice(0, open) : t).trim().toLowerCase()
    }).filter(Boolean),
  )
  const v = value.trim()
  // 引擎枚举列表值支持逗号分隔多成员（ag.java:2513 括号感知分段），逐段校验
  for (const raw of splitTopLevel(v)) {
    const seg = raw.trim()
    if (!seg) continue
    // 剥括号参数段（引擎枚举值支持 成员(参数) 形式，如 newMessage(withTag="x")）
    const open = seg.indexOf('(')
    const base = (open > 0 && seg.endsWith(')') ? seg.slice(0, open) : seg).trim().toLowerCase()
    if (!listLower.has(base)) {
      const expect = items.join('、')
      return `「${key}」的值「${value}」不符合类型 ${type}（期望：${expect}）`
    }
  }
  return null
}

/** 去掉行内注释（值后面以空格开头 # 的注释部分），颜色值 #000000 不受影响 */
export function stripInlineComment(value: string): string {
  return value.replace(/[ \t]+#.*$/, '').trim()
}

/** 检查单个 key:value 值是否合法（纯函数，供测试）。返回 null 表示合法或无需检查。 */
export function validateValue(
  key: string,
  value: string,
  data: {
    findCode: (k: string) => { type: string } | undefined
    findType: (t: string) => ValueTypeInfo | undefined
    zhToEn?: (k: string) => string | undefined
  },
): string | null {
  const trimmed = stripInlineComment(value)
  if (!trimmed) return null

  // 引擎多行字符串起始行（""" 语法，ae.java:879-901）：整行放行
  if (trimmed.startsWith('"""')) return null

  // 变量引用/表达式：值内任意位置出现 ${...} 即放行
  // （如 alpha: 0.3+cos( ${timer_2s} * 360) * 0.2 这类表达式）
  if (trimmed.includes('${')) return null
  // 游戏特殊常量放行
  if (SPECIAL_CONSTANTS.has(trimmed)) return null

  // 中文模式：键可能是中文译名或分段翻译的宏字段（如「名称」「建造自_1_名称」），
  // 整串回译失败时按 _ 分段回译再查表
  let code = data.findCode(key)
  if (!code && data.zhToEn) {
    const en = data.zhToEn(key) ?? (key.includes('_') ? zhToEnKeySegments(key) : undefined)
    if (en) code = data.findCode(en)
  }
  if (!code) return null // 键不在代码表 → 用户自定义字段，不检查

  // 多值 type（'float,logicBoolean' 等）：各段类型是 OR 语义——任一类型的规则命中即放行。
  // （第 6 轮修复：此前逗号分段匹配只取第一个段，导致 float 规则误报动态逻辑字段）
  const types = code.type.split(',').map((t) => t.trim()).filter(Boolean)
  const vts = types.map((t) => data.findType(t)).filter((v): v is ValueTypeInfo => v !== undefined)
  if (vts.length === 0) return null
  // 规则描述整行/键（如 key: '^[^#:]+:'），不是值格式 → 跳过
  if (types.some((t) => LINE_LEVEL_TYPES.has(t))) return null

  // 表达式形态放行：布尔/逻辑字段与数值字段（引擎大量字段用 LogicBooleanLoader
  // 读取，支持 self./memory./global. 变量引用、括号表达式、纯算术（1/2、1/5-0.01）、
  // 函数调用；中文显示层 if→如果（词典逐词翻译），注意 JS \b 对中文不成立，
  // 必须用 (?:\s|$) 判定词界）
  const expressionLike =
    trimmed.includes('self.') ||
    trimmed.includes('memory.') ||
    trimmed.includes('global.') ||
    trimmed.includes('CUSTOM:') ||
    /^(?:if\b|如果(?:\s|$))/i.test(trimmed) ||
    /^(?:和|或者|非)(?:\s|$)/.test(trimmed) ||
    /[()]/.test(trimmed) ||
    (/[/*%]/.test(trimmed) && /^[\d\s+\-*/%().]+$/.test(trimmed))
  if (
    types.some((t) => t === 'boolean' || t === 'logicBoolean' || t === 'int' || t === 'float') &&
    expressionLike
  ) return null

  // 任一类型规则命中即合法
  let hasConstrainingRule = false
  for (const vt of vts) {
    // 枚举类类型：rule 为空但 list 非空（autoTriggerOnEvent/drawType 等）——
    // 数据在 list 里（补全用），校验也用它（此前只读 rule 导致整类误报）
    if (!vt?.rule && vt.list) {
      if (vts.some((x) => x.type === 'spawnUnits')) {
        const err = validateSpawnUnits(trimmed)
        if (err) {
          return `「${key}」的值「${trimmed}」不符合类型 ${code.type}（${err}）`
        }
        return null
      }
      const enumErr = validateEnumList(trimmed, vt.list, key, code.type)
      if (enumErr) return enumErr
      return null
    }
    if (!vt?.rule) continue
    hasConstrainingRule = true
    const rule = vt.rule.trim()
    // 无实际约束的规则（匹配任意内容）跳过
    if (rule === '.' || rule === '.+' || rule === '.*') return null

    let re: RegExp
    let reCI: RegExp | null = null
    try {
      // 完整匹配语义：整体包一层非捕获组
      re = new RegExp(`^(?:${rule})$`)
      // 大小写不敏感回退（如 displayType: Upgrade 匹配规则里的 upgrade）
      reCI = new RegExp(`^(?:${rule})$`, 'i')
    } catch {
      continue // 规则本身无法编译 → 尝试下一个类型
    }

    // 候选值：原文 + 中文回译（是/真 → true，非/假 → false）
    const candidates = [trimmed]
    if (data.zhToEn) {
      const en = data.zhToEn(trimmed)
      if (en && en !== trimmed) candidates.push(en.trim())
    }
    if (candidates.some((c) => re.test(c) || (reCI?.test(c) ?? false))) return null

    // 逗号/竖线分隔的多值列表（如 explodeEffect: a, CUSTOM:b；price: 500|100）：
    // 引擎列表读取器按逗号或竖线分段（d.b.a: str.split(",|\\|")），
    // 任一元素合法即放行
    if (/[,|]/.test(trimmed)) {
      const parts = trimmed.split(/[,|]/).map((s) => s.trim()).filter(Boolean)
      if (parts.length > 1 && parts.some((p) => re.test(p) || (reCI?.test(p) ?? false))) return null
    }
  }

  // 值类型都没有实际约束规则（rule 空且 list 空，如 string/effect 等）→ 放行
  if (!hasConstrainingRule) return null

  const vt = vts[0]
  const expect = vt?.describe ? `（期望：${vt.describe}）` : ''
  return `「${key}」的值「${trimmed}」不符合类型 ${code.type}${expect}`
}

/** 计算整篇文档的诊断（纯函数，供测试） */
export function lintIniText(
  content: string,
  data: {
    findCode: (k: string) => { type: string } | undefined
    findType: (t: string) => ValueTypeInfo | undefined
    zhToEn?: (k: string) => string | undefined
  },
): Array<{ from: number; to: number; message: string; severity: 'error' | 'warning' }> {
  const diagnostics: Array<{ from: number; to: number; message: string; severity: 'error' | 'warning' }> = []
  const lines = content.split('\n')
  let lineStart = 0
  // 单趟遍历维护「当前节」：每行向上重扫是 O(n²)，万行级文件会明显卡顿
  let section = ''
  // 引擎多行字符串（""" 语法，ae.java:879-901）状态：串内行是值的一部分，
  // 不参与节/键值解析（否则描述文本里的「key: value」会被误报）
  let inString = false
  const sectionRe = /^\s*\[(.+?)\]\s*(?:#.*)?$/
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const trimmedLine = line.trim()
    if (inString) {
      // 串内：任何行（含 # 注释行——引擎串内照样扫描闭合符）出现 """ 即闭合
      if (trimmedLine.includes('"""')) inString = false
      lineStart += line.length + 1
      continue
    }
    // 非注释行出现 """ 即进入多行字符串（引擎：注释行整行跳过，不触发）。
    // 同一行开闭（key: """text"""）不算进入多行串——第二个 """ 即闭合符
    if (!trimmedLine.startsWith('#') && trimmedLine.includes('"""')) {
      const first = trimmedLine.indexOf('"""')
      if (trimmedLine.indexOf('"""', first + 3) === -1) inString = true
      lineStart += line.length + 1
      continue
    }
    const classified = classifyLine(line)
    const sectionMatch = sectionRe.exec(line)
    if (sectionMatch) section = sectionMatch[1]
    const currentSection = section

    if (classified.kind === 'keyvalue' && classified.key && classified.value !== undefined) {
      // 节外代码：不在任何节内的键值行 → 警告
      if (!currentSection) {
        diagnostics.push({
          from: lineStart,
          to: lineStart + line.length,
          message: '此键值行不在任何 [节] 内，游戏会忽略它',
          severity: 'warning',
        })
      }
      // 值合法性
      const err = validateValue(classified.key, classified.value, data)
      if (err) {
        const colon = line.indexOf(':')
        const from = lineStart + colon + 1
        diagnostics.push({ from, to: lineStart + line.length, message: err, severity: 'error' })
      }
    }
    lineStart += line.length + 1
  }
  return diagnostics
}

/** 项目单位名缓存（语义引用检查用）：scanResources 是 IPC，编辑高频 lint 不能每次都打。
 * 缓存 30s——AI 写文件后最多 30s 内新单位名不生效，可接受（质检会立刻扫描） */
let unitNamesCache: { root: string; names: ReadonlySet<string>; at: number } | null = null

async function cachedUnitNames(rootPath?: string): Promise<ReadonlySet<string> | undefined> {
  if (!rootPath) return undefined
  if (unitNamesCache && unitNamesCache.root === rootPath && Date.now() - unitNamesCache.at < 30_000) {
    return unitNamesCache.names
  }
  const { getBridge } = await import('../../services/bridge')
  const data = await getBridge().mod.scanResources(rootPath).catch(() => null)
  if (data) {
    unitNamesCache = { root: rootPath, names: new Set(data.unitNames), at: Date.now() }
  }
  return unitNamesCache?.root === rootPath ? unitNamesCache.names : undefined
}

/** 项目自定义规则缓存（M19/M21）：rules/*.json 是 IPC 读取，编辑高频 lint 不能每次都打。
 * 缓存 30s；保存规则文件后调用 invalidateProjectRulesCache 立即失效 */
let projectRulesCache: { root: string; rules: CustomRule[]; at: number } | null = null

export function invalidateProjectRulesCache(rootPath?: string): void {
  if (!rootPath || projectRulesCache?.root === rootPath) projectRulesCache = null
}

async function cachedProjectRules(rootPath?: string): Promise<CustomRule[] | undefined> {
  if (!rootPath) return undefined
  if (projectRulesCache && projectRulesCache.root === rootPath && Date.now() - projectRulesCache.at < 30_000) {
    return projectRulesCache.rules
  }
  const loaded = await loadProjectRuleSets(rootPath).catch(() => ({ sets: [], errors: [] }))
  const rules = loaded.sets.flatMap((s) => s.rules)
  projectRulesCache = { root: rootPath, rules, at: Date.now() }
  return rules
}

export interface RustLintOptions {
  /** 项目根（提供时语义引用检查可拿到单位名列表） */
  rootPath?: string
  /** 语义检查器开关（缺省全部开启） */
  semanticCheckers?: Record<string, boolean>
  /** 当前项目目标游戏版本名（版本兼容检查用；空 = 跟随最新） */
  targetVersionName?: string
  /** 当前文件名（checkFile 区分 .template 模板文件用；缺省按单位文件处理） */
  file?: string
}

/** 编辑器语义 lint 的内容上限：超过时只跑基础 lint（单趟 O(n)），
 * 跳过 15 个语义检查器——大文件（1MB+）在渲染线程每次输入都跑全套会明显卡顿 */
const MAX_SEMANTIC_LINT_CHARS = 2 * 1024 * 1024

/** CodeMirror lint 扩展（异步加载代码表数据后逐行检查 + M10 语义检查器合并） */
export function rustLintExtension(opts: RustLintOptions = {}) {
  return linter(
    async (view: EditorView) => {
      await loadCodeData()
      const zhToEnDict = getZhToEnDict()
      const keyZhToEnDict = getKeyZhToEnDict()
      const content = view.state.doc.toString()
      const data = {
        findCode: (k: string) => findCodeByCode(k),
        findType: (t: string) => findValueType(t),
        // 键位置回译先查键名表（键译名不被节名覆盖，如「价格」→price），回落通用词典
        zhToEn: (k: string) => keyZhToEnDict.get(k) ?? zhToEnDict.get(k),
      }
      const diagnostics = lintIniText(content, data)

      // M10：语义检查器（配置驱动，可单独开关；引用检查在拿到单位名时生效；
      // 超大文件跳过语义检查，基础 lint 仍保留）
      if (content.length <= MAX_SEMANTIC_LINT_CHARS) {
        const ruleIds = enabledRuleIds(opts.semanticCheckers ?? defaultSemanticCheckerConfig())
        const unitNames = await cachedUnitNames(opts.rootPath)
        // M19/M21：项目自定义规则（rules/*.json，声明式；缓存 30s）
        const customRules = await cachedProjectRules(opts.rootPath)
        // M11：目标版本名 → 版本号（空 = 最新版本，由检查器兜底）
        const targetVersionNumber = opts.targetVersionName ? versionNameToNumber(opts.targetVersionName) : undefined
        const issues = runSemanticChecks(content, {
          ruleIds,
          ctx: { ...data, codes: getAllCodes().map((c) => c.code), unitNames, targetVersionNumber, file: opts.file },
          customRules,
          customRuleConfig: opts.semanticCheckers,
        })
        return [...diagnostics, ...semanticIssuesToDiagnostics(content, issues)]
      }
      return diagnostics
    },
    { delay: 400 },
  )
}
