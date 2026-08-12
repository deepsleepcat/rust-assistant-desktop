/**
 * 铁锈战争工具集：AI 可以调用的项目操作（Pi agent tool 格式）。
 *
 * 安全设计：
 * - 前 5 个是只读工具，AI 可自由使用；
 * - writeFile 需要用户审批后才执行（由界面层拦截）。
 */
import { getBridge } from '../services/bridge'
import { basename } from '../utils/paths'

export interface RustTool {
  name: string
  description: string
  /** 工具参数 JSON Schema（宽松描述即可） */
  parameters: Record<string, unknown>
  execute(args: Record<string, unknown>, rootPath: string): Promise<string>
}

/** 列出项目目录结构 */
export function createListProjectTool(): RustTool {
  return {
    name: 'listProject',
    description: '列出项目目录结构（可指定相对路径，深度 1 层）',
    parameters: { type: 'object', properties: { path: { type: 'string', description: '相对路径，默认根目录' } } },
    async execute(args, rootPath) {
      const rel = String(args.path ?? '').replace(/^\/+/, '')
      const dir = rel ? `${rootPath.replace(/[\\/]$/, '')}\\${rel.replace(/\//g, '\\')}` : rootPath
      const entries = await getBridge().project.readDir(rootPath, dir)
      return entries.map((e) => `${e.isDirectory ? '[目录]' : '[文件]'} ${e.name}${e.isDirectory ? '/' : ''}`).join('\n')
    },
  }
}

/** 读取文件内容 */
export function createReadFileTool(): RustTool {
  return {
    name: 'readFile',
    description: '读取项目内文件内容（相对路径，如 units/rifle.txt）',
    parameters: { type: 'object', properties: { path: { type: 'string', description: '相对项目根目录的路径' } }, required: ['path'] },
    async execute(args, rootPath) {
      const rel = String(args.path ?? '').replace(/^\/+/, '')
      const filePath = `${rootPath.replace(/[\\/]$/, '')}\\${rel.replace(/\//g, '\\')}`
      const result = await getBridge().project.readFile(rootPath, filePath)
      return result.content.slice(0, 20000) + (result.content.length > 20000 ? '\n...（内容过长已截断）' : '')
    },
  }
}

/** 搜索项目文件内容 */
export function createSearchTool(): RustTool {
  return {
    name: 'searchInProject',
    description: '在项目文件名或代码中搜索关键词（如单位名、标签）',
    parameters: { type: 'object', properties: { query: { type: 'string', description: '搜索关键词' } }, required: ['query'] },
    async execute(args, rootPath) {
      const query = String(args.query ?? '')
      const entries = await getBridge().project.readDir(rootPath, rootPath)
      const matches = entries
        .filter((e) => e.name.toLowerCase().includes(query.toLowerCase()))
        .map((e) => e.name)
      return matches.length > 0 ? `找到 ${matches.length} 个匹配：\n${matches.join('\n')}` : `未找到包含「${query}」的文件`
    },
  }
}

/** 查询代码表（手机版数据库） */
export function createCodeTableTool(): RustTool {
  return {
    name: 'codeTable',
    description: '查询铁锈战争代码表：输入英文键或中文译名，返回字段说明/值类型/所属节',
    parameters: { type: 'object', properties: { query: { type: 'string', description: '键名或中文译名' } }, required: ['query'] },
    async execute(args) {
      const { loadCodeData, findCodesByQuery } = await import('../services/codeData')
      await loadCodeData()
      const results = findCodesByQuery(String(args.query ?? ''), 10)
      return results.length > 0
        ? results.map((c) => `${c.code}（${c.translate}）\n  类型: ${c.type} | 节: ${c.section}\n  ${c.description}`).join('\n\n')
        : `代码表中未找到「${args.query}」`
    },
  }
}

/** 查看文件 Section 大纲 */
export function createOutlineTool(): RustTool {
  return {
    name: 'sectionOutline',
    description: '查看文件的节（Section）大纲，如 [core] [attack] [turret_1]',
    parameters: { type: 'object', properties: { path: { type: 'string', description: '相对路径' } }, required: ['path'] },
    async execute(args, rootPath) {
      const { scanSections } = await import('../features/editor/outline')
      const rel = String(args.path ?? '').replace(/^\/+/, '')
      const filePath = `${rootPath.replace(/[\\/]$/, '')}\\${rel.replace(/\//g, '\\')}`
      const result = await getBridge().project.readFile(rootPath, filePath)
      const sections = scanSections(result.content)
      return sections.map((s) => `[${s.name}] 第 ${s.line} 行`).join('\n')
    },
  }
}

/** 写文件（需审批）：生成完整内容替换 */
export function createWriteFileTool(): RustTool {
  return {
    name: 'writeFile',
    description: '写入/修改项目内文件（相对路径）。会先经过用户审批。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '相对路径，如 units/new-unit.txt' },
        content: { type: 'string', description: '完整文件内容（不是增量补丁）' },
      },
      required: ['path', 'content'],
    },
    async execute(args, rootPath) {
      const rel = String(args.path ?? '').replace(/^\/+/, '')
      const filePath = `${rootPath.replace(/[\\/]$/, '')}\\${rel.replace(/\//g, '\\')}`
      const content = String(args.content ?? '')
      await getBridge().project.writeFile(rootPath, filePath, content, { hasBom: false })
      return `已写入 ${rel}（${content.length} 字符）`
    },
  }
}

export function createRustTools(): RustTool[] {
  return [
    createListProjectTool(),
    createReadFileTool(),
    createSearchTool(),
    createCodeTableTool(),
    createOutlineTool(),
    createWriteFileTool(),
  ]
}

export function toolSummary(tool: RustTool): string {
  return `${tool.name}${basename(tool.name) ? '' : ''}: ${tool.description}`
}
