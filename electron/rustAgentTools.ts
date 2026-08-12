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
import type { AgentTool } from '@earendil-works/pi-agent-core'

const pathSchema = Type.String({ description: '相对项目根目录的路径，如 units/rifle.txt' })

/** 把 AI 给的相对路径解析为项目内绝对路径（越界抛错） */
function resolveInside(rootPath: string, rel: string): string {
  const normalized = String(rel).replace(/^\/+/, '').replace(/\//g, path.sep)
  const abs = path.resolve(rootPath, normalized)
  const root = path.resolve(rootPath)
  if (abs !== root && !abs.startsWith(root + path.sep)) throw new Error('路径超出项目目录范围')
  return abs
}

export function createListProjectTool(): AgentTool {
  return {
    name: 'listProject',
    label: '列出项目目录',
    description: '列出项目目录内容（相对路径，深度 1 层）。用于了解模组结构。',
    parameters: Type.Object({ path: Type.Optional(pathSchema) }),
    async execute(_id, params) {
      const p = params as { path?: string }
      const dir = p.path ? resolveInside(getAgentRoot(), p.path) : getAgentRoot()
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
      const file = resolveInside(getAgentRoot(), p.path)
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
    description: '在项目文件名中搜索关键词（如单位名、标签、文件夹名）。',
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
      const file = resolveInside(getAgentRoot(), p.path)
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

/** 写文件：经过审批后调用；用临时文件 + 原子替换，不破坏原文件。 */
export function createWriteFileTool(): AgentTool {
  return {
    name: 'writeFile',
    label: '写入文件',
    description: '写入/修改项目内文件（相对路径，内容为完整文件）。**必须等待用户审批**。',
    parameters: Type.Object({
      path: pathSchema,
      content: Type.String({ description: '完整文件内容（不是增量补丁）' }),
    }),
    async execute(_id, params) {
      const p = params as { path: string; content: string }
      const file = resolveInside(getAgentRoot(), p.path)
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
        content: [{ type: 'text', text: `已写入 ${p.path}（${p.content.length} 字符）` }],
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
