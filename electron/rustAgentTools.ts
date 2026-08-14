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
 * writeFile 写盘前快照的工具调用 id 关联表（任务 2 撤销入口）：
 * 快照在工具 execute 内记录（拿到 toolCallId），审批/工具结束事件在 ai.ts 消费
 * （tool_execution_end 携带同一 toolCallId）。读取后即删除，防止表无限膨胀。
 */
const snapshotIds = new Map<string, string>()

export function takeSnapshotId(toolCallId: string): string | null {
  const id = snapshotIds.get(toolCallId) ?? null
  snapshotIds.delete(toolCallId)
  return id
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
      // 快照失败（读不到/超限）不阻断写入，只是本次没有撤销入口。
      let snapshotId: string | null = null
      try {
        if (existed) {
          const st = await fs.stat(file)
          if (st.size <= DEFAULT_HISTORY_LIMITS.maxEntryBytes) {
            snapshotId = await getHistory().addSnapshot(getAgentRoot(), p.path, await fs.readFile(file, 'utf8'))
          }
        } else {
          snapshotId = await getHistory().addSnapshot(getAgentRoot(), p.path, null)
        }
      } catch (err) {
        console.warn('[writeFile] 快照失败，本次写入无撤销入口:', err)
        snapshotId = null
      }
      if (snapshotId) snapshotIds.set(toolCallId, snapshotId)
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
  const dataPath = path.join(__dirname, '..', '..', 'public', 'data', 'code.json')
  const raw = await fs.readFile(dataPath, 'utf8')
  const parsed = JSON.parse(raw) as { data?: CodeTableEntry[] }
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

export function createRustAgentTools(): AgentTool[] {
  return [
    createListProjectTool(),
    createReadFileTool(),
    createSearchTool(),
    createCodeTableTool(),
    createOutlineTool(),
    createWriteFileTool(),
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
