/**
 * 主进程铁锈战争工具集：AI 可以直接调用的项目操作（Pi AgentTool 格式）。
 *
 * 安全设计：
 * - 所有工具运行在 Electron 主进程（Node），直接使用 fs；
 * - 路径一律经过 requireInsideRoot 校验，限制在项目根目录内；
 * - 前 5 个只读工具 AI 可自由使用；
 * - writeFile 必须经过用户审批（由 beforeToolCall 钩子拦截）。
 */
import path from 'node:path'
import fs from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { Type } from 'typebox'
import { assertNoLinkEscape, isPathInside } from './paths'
import { getHistory, DEFAULT_HISTORY_LIMITS } from './aiHistory'
import type { AgentTool } from '@earendil-works/pi-agent-core'

const pathSchema = Type.String({ description: '相对项目根目录的路径，如 units/rifle.txt' })

/** 把 AI 给的相对路径解析为项目内绝对路径（越界抛错；盘符根/大小写与 paths.ts 一致） */
function resolveInside(rootPath: string, rel: string): string {
  const normalized = String(rel).replace(/^\/+/, '').replace(/\//g, path.sep)
  const abs = path.resolve(rootPath, normalized)
  if (!isPathInside(rootPath, abs)) throw new Error('路径超出项目目录范围')
  return abs
}

/** 词法校验 + 链接逃逸校验（M1：项目内 junction 不能把 AI 的读写重定向到根外） */
async function resolveInsideReal(rootPath: string, rel: string): Promise<string> {
  const abs = resolveInside(rootPath, rel)
  await assertNoLinkEscape(rootPath, abs)
  return abs
}

/** 供主进程审批流程复用：把 AI 相对路径解析为项目内绝对路径（与工具内部同一套校验） */
export function resolveAgentPath(rel: string): Promise<string> {
  return resolveInsideReal(getAgentRoot(), rel)
}

/**
 * writeFile 写盘前快照的工具调用 id 关联表（撤销入口）：
 * 快照在工具 execute 内记录（拿到 toolCallId），工具结束事件在 ai.ts 消费
 * （tool_execution_end 携带同一 toolCallId；工具可能并行执行，必须按 id 关联）。
 * 读取后即删除；流中止时由 clearSnapshotInfo 清空，防止表无限膨胀。
 * skipped=true：文件过大/读失败，本次写入没有快照（界面提示不可撤销）。
 */
const snapshotInfo = new Map<string, { id?: string; skipped: boolean }>()

export interface SnapshotInfo {
  id?: string
  skipped: boolean
}

export function takeSnapshotInfo(toolCallId: string): SnapshotInfo | null {
  const info = snapshotInfo.get(toolCallId) ?? null
  snapshotInfo.delete(toolCallId)
  return info
}

/** 流结束（done/error/abort）时清空未消费的快照关联，防止表泄漏 */
export function clearSnapshotInfo(): void {
  snapshotInfo.clear()
}

export function createListProjectTool(): AgentTool {
  return {
    name: 'listProject',
    label: '列出项目目录',
    description: '列出项目目录内容（相对路径，深度 1 层）。用于了解模组结构。',
    parameters: Type.Object({ path: Type.Optional(pathSchema) }),
    async execute(_id, params) {
      const p = params as { path?: string }
      // L-5：目录也可能是 junction——列表也不能读穿到根外
      const dir = p.path ? await resolveInsideReal(getAgentRoot(), p.path) : getAgentRoot()
      const entries = await fs.readdir(dir, { withFileTypes: true })
      return {
        content: [{ type: 'text', text: entries.map((e) => `${e.isDirectory() ? '[目录]' : '[文件]'} ${e.name}${e.isDirectory() ? '/' : ''}`).join('\n') || '（空目录）' }],
        details: {},
      }
    },
  }
}

export function createReadFileTool(): AgentTool {
  return {
    name: 'readFile',
    label: '读取文件',
    description: '读取项目内文件内容（相对路径）。用于查看单位定义、模板等。',
    parameters: Type.Object({ path: pathSchema }),
    async execute(_id, params) {
      const p = params as { path: string }
      const file = await resolveInsideReal(getAgentRoot(), p.path)
      // 与 fs:readFile 对称的 64MB 上限：AI 是远程模型，可能被项目内恶意内容
      // prompt 注入后反复调用只读工具读大文件 → 全量读入会拖垮主进程
      const st = await fs.stat(file)
      if (st.size > 64 * 1024 * 1024) {
        return {
          content: [{ type: 'text', text: `文件过大（${(st.size / 1024 / 1024).toFixed(1)}MB，超过 64MB 上限），已拒绝读取。可用 sectionOutline 查看结构。` }],
          details: { size: st.size },
        }
      }
      const buf = await fs.readFile(file)
      const hasBom = buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf
      const content = (hasBom ? buf.subarray(3).toString('utf8') : buf.toString('utf8')).slice(0, 20000)
      return {
        content: [{ type: 'text', text: content + (content.length >= 20000 ? '\n...（内容过长已截断）' : '') }],
        details: { size: buf.length },
      }
    },
  }
}

export function createSearchTool(): AgentTool {
  return {
    name: 'searchInProject',
    label: '搜索项目',
    description: '搜索项目根目录第一层文件的文件名中的关键词（不递归子目录、不搜索文件内容）。如需要内容请用 readFile。',
    parameters: Type.Object({ query: Type.String({ description: '搜索关键词' }) }),
    async execute(_id, params) {
      const p = params as { query: string }
      const root = getAgentRoot()
      const query = String(p.query).toLowerCase()
      const entries = await fs.readdir(root, { withFileTypes: true })
      const matches = entries.filter((e) => e.name.toLowerCase().includes(query)).map((e) => e.name)
      return {
        content: [{ type: 'text', text: matches.length ? `找到 ${matches.length} 个：\n${matches.join('\n')}` : `未找到包含「${p.query}」的文件` }],
        details: { count: matches.length },
      }
    },
  }
}

export function createOutlineTool(): AgentTool {
  return {
    name: 'sectionOutline',
    label: '查看节大纲',
    description: '查看文件的节（Section）大纲，如 [core] [attack] [turret_1]。',
    parameters: Type.Object({ path: pathSchema }),
    async execute(_id, params) {
      const p = params as { path: string; content: string }
      const file = await resolveInsideReal(getAgentRoot(), p.path)
      // 与 readFile 一致的大小上限：节大纲也需全量读入，超限时给提示而不是 OOM
      const st = await fs.stat(file)
      if (st.size > 64 * 1024 * 1024) {
        return {
          content: [{ type: 'text', text: `文件过大（${(st.size / 1024 / 1024).toFixed(1)}MB，超过 64MB 上限），已拒绝读取` }],
          details: { size: st.size },
        }
      }
      const content = await fs.readFile(file, 'utf8')
      const lines = content.split(/\r?\n/)
      const sections = lines
        .map((line, index) => (/^\s*\[.+?\]\s*$/.test(line) ? `[${line.trim().slice(1, -1)}] 第 ${index + 1} 行` : null))
        .filter((s): s is string => s !== null)
      return {
        content: [{ type: 'text', text: sections.length ? sections.join('\n') : '（无节）' }],
        details: {},
      }
    },
  }
}

/** 写文件：经过审批后调用；用临时文件 + 原子替换，不破坏原文件。
 * 写盘前记录旧内容快照（任务 2）：撤销/历史入口靠快照 id 关联到本次工具调用。 */
export function createWriteFileTool(): AgentTool {
  return {
    name: 'writeFile',
    label: '写入文件',
    description: '写入/修改项目内文件（相对路径，内容为完整文件）。**必须等待用户审批**。',
    parameters: Type.Object({
      path: pathSchema,
      content: Type.String({ description: '完整文件内容（不是增量补丁）' }),
    }),
    async execute(toolCallId, params) {
      const p = params as { path: string; content: string }
      const file = await resolveInsideReal(getAgentRoot(), p.path)
      // LOW-2：与 fs:writeFile 的 64MB 上限对称——提示注入诱导 AI 写超大文件
      // 会填满项目所在磁盘，必须限制
      if (Buffer.byteLength(p.content, 'utf8') > 64 * 1024 * 1024) {
        return {
          content: [{ type: 'text', text: '写入失败：内容超过 64MB 上限，请拆分或精简内容' }],
          details: {},
        }
      }
      const existed = await fs.access(file).then(() => true).catch(() => false)
      // 写盘前快照：旧内容（撤销 = 恢复它）；文件不存在也记一条 null 快照（撤销 = 删除新建文件）。
      // 快照失败（读不到/超限）不阻断写入，但记录 skipped 让界面提示「本次修改不可撤销」。
      let snapshot: SnapshotInfo
      try {
        if (existed) {
          const st = await fs.stat(file).catch(() => null)
          if (st && st.size <= DEFAULT_HISTORY_LIMITS.maxEntryBytes) {
            const id = await getHistory().addSnapshot(getAgentRoot(), p.path, await fs.readFile(file, 'utf8'))
            if (id) snapshot = { id, skipped: false }
            else snapshot = { skipped: true } // 内容超限（与 stat 上限一致，理论上不会发生）
          } else {
            snapshot = { skipped: true } // 文件过大：快照库有单条上限，跳过
          }
        } else {
          const id = await getHistory().addSnapshot(getAgentRoot(), p.path, null)
          if (id) snapshot = { id, skipped: false }
          else snapshot = { skipped: true }
        }
      } catch (err) {
        console.warn('[writeFile] 快照失败，本次写入不可撤销:', err)
        snapshot = { skipped: true }
      }
      snapshotInfo.set(toolCallId, snapshot)
      await fs.mkdir(path.dirname(file), { recursive: true })
      const tmp = path.join(path.dirname(file), `.${path.basename(file)}.ai-${randomUUID()}.tmp`)
      try {
        await fs.writeFile(tmp, p.content, 'utf8')
        await fs.rename(tmp, file)
      } catch (err) {
        await fs.rm(tmp, { force: true }).catch(() => undefined)
        throw err
      }
      return {
        content: [{ type: 'text', text: `${existed ? '已修改' : '已新增'} ${p.path}（${p.content.length} 字符）` }],
        details: { path: p.path },
      }
    },
  }
}

/** 读取 public/data 下的数据文件：
 * 生产（dist-electron/electron）用 __dirname 定位；测试环境（vitest 无真实 __dirname）
 * 回退到进程工作目录定位。仅「文件不存在」（ENOENT）才尝试下一候选——
 * 权限/损坏等真实错误直接抛出，避免诊断失真。 */
async function readPublicDataFile(name: string): Promise<Buffer> {
  const candidates = [
    path.join(__dirname, '..', '..', 'public', 'data', name),
    path.join(process.cwd(), 'public', 'data', name),
  ]
  for (const p of candidates) {
    try {
      return await fs.readFile(p)
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') throw err
      // 该候选不存在：尝试下一个
    }
  }
  throw new Error(`数据文件不存在：${name}`)
}

/** 代码表查询：直接读 public/data/code.json（主进程 Node 环境用 fs，不用 fetch） */
interface CodeTableEntry {
  code: string
  translate: string
  description: string
  type: string
  section: string
}
let codeTableCache: CodeTableEntry[] | null = null

async function loadCodeTable(): Promise<CodeTableEntry[]> {
  if (codeTableCache) return codeTableCache
  const raw = await readPublicDataFile('code.json')
  const parsed = JSON.parse(raw.toString('utf8')) as { data?: CodeTableEntry[] }
  codeTableCache = parsed.data ?? []
  return codeTableCache
}

export function createCodeTableTool(): AgentTool {
  return {
    name: 'codeTable',
    label: '查询代码表',
    description: '查询铁锈战争代码表：输入英文键或中文译名，返回字段说明/值类型/所属节。',
    parameters: Type.Object({ query: Type.String({ description: '键名或中文译名，如 name、价格、maxHp' }) }),
    async execute(_id, params) {
      const p = params as { query: string }
      try {
        const entries = await loadCodeTable()
        const q = String(p.query).trim().toLowerCase()
        const matches = entries.filter((e) => e.code.toLowerCase().includes(q) || e.translate.includes(String(p.query).trim()))
        const top = matches.slice(0, 10)
        return {
          content: [{
            type: 'text',
            text: top.length
              ? top.map((e) => `${e.code}（${e.translate}）\n  类型: ${e.type} | 节: ${e.section}\n  ${e.description}`).join('\n\n')
              : `代码表中未找到「${p.query}」`,
          }],
          details: { count: top.length },
        }
      } catch (err) {
        throw new Error(`代码表加载失败：${err instanceof Error ? err.message : String(err)}`, { cause: err })
      }
    },
  }
}

/** ── M26-3 参考知识检索（query_reference）：代码表/逻辑词库/单位库/节 多源查询 ── */

interface VocabEntry {
  word: string
  explanation: string
}
interface UnitEntry {
  name: string
  zhName?: string
  zhDesc?: string
}
interface SectionEntry {
  code: string
  translate: string
}
interface ReferenceData {
  code: CodeTableEntry[]
  vocab: VocabEntry[]
  units: UnitEntry[]
  sections: SectionEntry[]
}
let referenceCache: ReferenceData | null = null

/** 全量加载参考数据（每文件缓存；任一文件失败降级为空数组，不阻塞其它源）。
 * 代码表加载失败时不写缓存（下次调用重试），避免整进程生命周期内代码表源永久失效 */
async function loadReferenceData(): Promise<ReferenceData> {
  if (referenceCache) return referenceCache
  const [codeRaw, vocabRaw, dialectRaw, unitsRaw, sectionRaw] = await Promise.all([
    loadCodeTable().catch(() => null),
    readPublicDataFile('vocabulary.json')
      .then((b) => (JSON.parse(b.toString('utf8')).words ?? []) as VocabEntry[])
      .catch(() => []),
    readPublicDataFile('dialect.json')
      .then((b) => (JSON.parse(b.toString('utf8')).words ?? []) as VocabEntry[])
      .catch(() => []),
    readPublicDataFile('units.json')
      .then((b) => (JSON.parse(b.toString('utf8')).data ?? []) as UnitEntry[])
      .catch(() => []),
    readPublicDataFile('section.json')
      .then((b) => (JSON.parse(b.toString('utf8')).data ?? []) as SectionEntry[])
      .catch(() => []),
  ])
  if (codeRaw) {
    referenceCache = { code: codeRaw, vocab: [...vocabRaw, ...dialectRaw], units: unitsRaw, sections: sectionRaw }
    return referenceCache
  }
  // 代码表失败：本次返回其余源（不缓存，下次调用重试）
  return { code: [], vocab: [...vocabRaw, ...dialectRaw], units: unitsRaw, sections: sectionRaw }
}

/** 查询参考知识（M26-3）：多源检索，返回带来源标注的条目。
 * domain 限定来源：code=代码表 / logic=逻辑词库 / unit=单位库 / section=节 / all=全部。 */
export function createQueryReferenceTool(): AgentTool {
  return {
    name: 'queryReference',
    label: '查询参考知识',
    description:
      '查询铁锈战争参考知识库（多源）：代码表字段（英文键或中文译名 → 说明/值类型/所属节）、逻辑语法词（谓词/函数，如 isFlying、breadUnitMemory）、官方单位、节名。' +
      'domain 可选 code / logic / unit / section（缺省 all）。比 codeTable 覆盖更广，遇到不认识的字段、逻辑词或单位名先用它查。',
    parameters: Type.Object({
      query: Type.String({ description: '关键词（英文或中文），如 maxHp、飞行、坦克、core' }),
      domain: Type.Optional(Type.String({ description: '限定来源：code / logic / unit / section（缺省 all）' })),
    }),
    async execute(_id, params) {
      const p = params as { query: string; domain?: string }
      const q = String(p.query).trim().toLowerCase()
      if (!q) return { content: [{ type: 'text', text: '请输入查询关键词' }], details: {} }
      const domain = p.domain ?? 'all'
      const data = await loadReferenceData()
      // all 模式每源独立上限（防代码表独占 12 条挤掉其它源）；单域模式 12 条
      const perSourceCap = domain === 'all' ? 4 : 12
      const totalCap = domain === 'all' ? 16 : 12
      const lines: string[] = []
      const push = (text: string): void => { if (lines.length < totalCap) lines.push(text) }

      if (domain === 'all' || domain === 'code') {
        let count = 0
        for (const e of data.code) {
          if (e.code.toLowerCase().includes(q) || e.translate.includes(p.query.trim())) {
            push(`[代码表] ${e.code}（${e.translate}）\n  类型: ${e.type} | 节: ${e.section}\n  ${e.description ?? ''}`)
            if (++count >= perSourceCap) break
          }
        }
      }
      if (domain === 'all' || domain === 'logic') {
        let count = 0
        for (const v of data.vocab) {
          if (v.word.toLowerCase().includes(q) || (v.explanation ?? '').includes(p.query.trim())) {
            push(`[逻辑词库] ${v.word}\n  ${v.explanation}`)
            if (++count >= perSourceCap) break
          }
        }
      }
      if (domain === 'all' || domain === 'unit') {
        let count = 0
        for (const u of data.units) {
          if (u.name.toLowerCase().includes(q) || (u.zhName ?? '').includes(p.query.trim())) {
            push(`[单位] ${u.name}${u.zhName ? `（${u.zhName}）` : ''}\n  ${u.zhDesc ?? ''}`)
            if (++count >= perSourceCap) break
          }
        }
      }
      if (domain === 'all' || domain === 'section') {
        let count = 0
        for (const s of data.sections) {
          if (s.code.toLowerCase().includes(q) || s.translate.includes(p.query.trim())) {
            push(`[节] ${s.code}（${s.translate}）`)
            if (++count >= perSourceCap) break
          }
        }
      }
      return {
        content: [{ type: 'text', text: lines.length ? lines.join('\n\n') : `参考知识中未找到「${p.query}」` }],
        details: { count: lines.length, domain },
      }
    },
  }
}

/** 检查用例生成（M19，P2 任务 3）：AI 生成声明式检查规则（JSON），
 * 界面可「试运行」验证后保存为项目规则（rules/*.json）。
 * 安全边界：只接受声明式 schema（validateRuleSet 校验），不执行任何脚本。 */
export function createGenerateCheckCasesTool(): AgentTool {
  return {
    name: 'generateCheckCases',
    label: '生成检查用例',
    description:
      '生成针对单位文件的声明式检查用例（JSON 数组）。规则元素：{id, title, description?, section?, key, severity?(error/warning/info), check:{type, min?, max?, values?, pattern?}}。' +
      'check.type 只能是 numeric-range / required-key / forbidden-value / regex-match / enum-value。' +
      '先 readFile 查看目标单位，用例必须贴合实际字段与数值；规则只做键值校验，不能表达任意逻辑。',
    parameters: Type.Object({
      targetPath: Type.Optional(pathSchema),
      rules: Type.Array(
        Type.Object({
          id: Type.String(),
          title: Type.String(),
          description: Type.Optional(Type.String()),
          section: Type.Optional(Type.String()),
          key: Type.Optional(Type.String()),
          severity: Type.Optional(Type.String()),
          check: Type.Any(),
        }),
      ),
      note: Type.Optional(Type.String({ description: '用例说明（写给用户看的简短说明）' })),
    }),
    async execute(_id, params) {
      const p = params as { targetPath?: string; rules: unknown[]; note?: string }
      const { validateRuleSet } = await import('../src/features/editor/semanticChecks/ruleSchema.js')
      const v = validateRuleSet({ formatVersion: 1, name: 'AI 生成规则', rules: p.rules })
      if (!v.ok) {
        return {
          content: [
            {
              type: 'text',
              text: `检查用例格式有误，请修正后重试：\n${v.errors.join('\n')}\n（用例只能使用声明式检查：numeric-range/required-key/forbidden-value/regex-match/enum-value）`,
            },
          ],
          details: { ok: false, errors: v.errors },
        }
      }
      const lines = v.set.rules.map(
        (r) => `- ${r.title}（${r.id}）：${r.description ?? describeCheck(r.check)}${r.section ? `，节 [${r.section}]` : ''}${r.key ? `，键 ${r.key}` : ''}${r.severity ? `，级别 ${r.severity}` : ''}`,
      )
      const targetLine = p.targetPath ? `目标文件：${p.targetPath}\n` : ''
      const noteLine = p.note ? `说明：${p.note}\n` : ''
      return {
        content: [
          {
            type: 'text',
            text: `已生成 ${v.set.rules.length} 条检查用例：\n${lines.join('\n')}\n\n${targetLine}${noteLine}点击卡片上的「试运行」验证用例，验证通过后可「保存为项目规则」（写入项目 rules/ 目录，编辑器/质检/报告即时生效）。`,
          },
        ],
        details: { ok: true, rules: v.set.rules, targetPath: p.targetPath ?? null, note: p.note ?? null },
      }
    },
  }
}

/** 检查类型的人类可读描述（工具结果展示用） */
function describeCheck(check: { type: string; min?: number; max?: number; values?: string[]; pattern?: string }): string {
  switch (check.type) {
    case 'numeric-range':
      return `数值 ${check.min !== undefined ? `≥ ${check.min}` : ''}${check.min !== undefined && check.max !== undefined ? ' 且 ' : ''}${check.max !== undefined ? `≤ ${check.max}` : ''}`
    case 'required-key':
      return '节内必须存在该键'
    case 'forbidden-value':
      return `禁用值：${(check.values ?? []).join('、')}`
    case 'enum-value':
      return `允许值：${(check.values ?? []).join('、')}`
    case 'regex-match':
      return `匹配 ${check.pattern}`
    default:
      return check.type
  }
}

export function createRustAgentTools(): AgentTool[] {
  return [
    createListProjectTool(),
    createReadFileTool(),
    createSearchTool(),
    createCodeTableTool(),
    createQueryReferenceTool(),
    createOutlineTool(),
    createWriteFileTool(),
    createGenerateCheckCasesTool(),
  ]
}

/** 当前项目根目录（由主进程在发起对话时设置，工具通过它做路径校验） */
let currentRoot = ''
export function setAgentRoot(root: string): void {
  currentRoot = path.resolve(root)
}
export function getAgentRoot(): string {
  return currentRoot
}
