/**
 * AI 工具集（手机版 v1）：10 个工具，供对话循环中的 function calling 使用。
 * 安全边界：
 * - 所有路径参数必须是项目内相对路径（拒绝绝对路径 / .. 穿越 / 空路径）；
 * - 写文件（writeFile/applyDiff）必须经过用户审批（由调用方处理）；
 * - 文件读取只读，不做任何解释执行。
 * fs 操作全部走桥（bridge），与编辑器共用同一套权限边界。
 */
import type { AiChatMessage } from '../../types/ai'
import { getBridge } from '../../services/bridge'
import {
  findCodeByCode,
  findCodesByQuery,
  findValueType,
  getAllCodes,
  getAllOfficialUnits,
  getAllSections,
  getKeyZhToEnDict,
  getZhToEnDict,
  searchLogicBooleans,
  searchVocabulary,
} from '../../services/codeData'
import { scanSections } from '../editor/outline'
import { joinProjectPath } from '../../utils/projectPath'
import { isRustConfigFile } from '../../utils/paths'
import { runSemanticChecks } from '../editor/semanticChecks'
import { applyUnifiedDiff, parseUnifiedDiff } from './applyDiff'

/** 工具参数 schema（OpenAI function calling 格式） */
export interface AiToolDef {
  name: string
  description: string
  parameters: Record<string, unknown>
}

export interface AiToolContext {
  rootPath: string
  /** 写文件审批回调：返回 true 表示用户批准 */
  approveWrite: (req: { tool: string; path: string; contentPreview: string; diff?: string }) => Promise<boolean>
}

/** 工具执行结果（文本形式回传模型） */
export type ToolResult = { ok: true; output: string } | { ok: false; error: string }

/** 校验项目内相对路径（安全边界）：拒绝绝对路径、.. 穿越、空路径 */
export function safeRelPath(raw: string): string | null {
  if (typeof raw !== 'string') return null
  const p = raw.trim().replace(/\\/g, '/')
  if (!p) return null
  if (p.startsWith('/') || /^[A-Za-z]:/.test(p)) return null
  if (p.split('/').includes('..')) return null
  if (p.includes('\0')) return null
  return p
}

const LIST_PROJECT: AiToolDef = {
  name: 'listProject',
  description: '列出项目目录内容（dir 省略 = 项目根）。返回文件/目录名列表。',
  parameters: {
    type: 'object',
    properties: { dir: { type: 'string', description: '相对项目根的目录路径，省略 = 根' } },
  },
}

const READ_FILE: AiToolDef = {
  name: 'readFile',
  description: '读取项目内文件内容（path 为相对项目根的路径）。',
  parameters: {
    type: 'object',
    properties: { path: { type: 'string' } },
    required: ['path'],
  },
}

const SEARCH_IN_PROJECT: AiToolDef = {
  name: 'searchInProject',
  description: '按文件名关键词搜索项目（返回匹配的相对路径列表）。',
  parameters: {
    type: 'object',
    properties: { query: { type: 'string' } },
    required: ['query'],
  },
}

const GREP_IN_PROJECT: AiToolDef = {
  name: 'grepInProject',
  description: '在项目文件中递归搜索文本关键词（大小写不敏感），返回 文件:行号:该行内容。',
  parameters: {
    type: 'object',
    properties: { query: { type: 'string' }, dir: { type: 'string', description: '相对目录，省略 = 项目根' } },
    required: ['query'],
  },
}

const SECTION_OUTLINE: AiToolDef = {
  name: 'sectionOutline',
  description: '查看文件的节大纲（[节名] + 行号）。',
  parameters: {
    type: 'object',
    properties: { path: { type: 'string' } },
    required: ['path'],
  },
}

const CODE_TABLE: AiToolDef = {
  name: 'codeTable',
  description: '查询代码表（英文键或中文译名 → 字段说明/值类型/所属节）。',
  parameters: {
    type: 'object',
    properties: { query: { type: 'string' } },
    required: ['query'],
  },
}

const QUERY_REFERENCE: AiToolDef = {
  name: 'queryReference',
  description: '查询参考知识库（多源）：code=代码表、logic=逻辑语法词、unit=官方单位、section=节名。',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string' },
      domain: { type: 'string', enum: ['code', 'logic', 'unit', 'section'] },
    },
    required: ['query'],
  },
}

const GENERATE_CHECK_CASES: AiToolDef = {
  name: 'generateCheckCases',
  description: '为单位文件生成声明式检查用例（JSON 数组）。返回可直接保存为项目规则的用例。',
  parameters: {
    type: 'object',
    properties: { path: { type: 'string' } },
    required: ['path'],
  },
}

const WRITE_FILE: AiToolDef = {
  name: 'writeFile',
  description: '写入/修改文件（path 相对项目根，content 为完整新内容）。必须经过用户审批。',
  parameters: {
    type: 'object',
    properties: { path: { type: 'string' }, content: { type: 'string' } },
    required: ['path', 'content'],
  },
}

const APPLY_DIFF: AiToolDef = {
  name: 'applyDiff',
  description: '对已有文件做局部修改（unified diff 格式，@@ 头 + 行块）。必须经过用户审批。',
  parameters: {
    type: 'object',
    properties: { path: { type: 'string' }, diff: { type: 'string' } },
    required: ['path', 'diff'],
  },
}

export const AI_TOOLS: AiToolDef[] = [
  LIST_PROJECT,
  READ_FILE,
  SEARCH_IN_PROJECT,
  GREP_IN_PROJECT,
  SECTION_OUTLINE,
  CODE_TABLE,
  QUERY_REFERENCE,
  GENERATE_CHECK_CASES,
  WRITE_FILE,
  APPLY_DIFF,
]

/** 读取项目内文本文件（相对路径，限制扩展名） */
async function readProjectFile(rootPath: string, rel: string): Promise<string> {
  if (!isRustConfigFile(rel) && !/\.(json|md)$/i.test(rel)) {
    throw new Error(`不支持读取该类型文件：${rel}（只允许配置文件/JSON/Markdown）`)
  }
  const { content } = await getBridge().project.readFile(rootPath, joinProjectPath(rootPath, rel))
  return content
}

/** 执行工具（args 已由模型给出；path 一律经 safeRelPath 校验） */
export async function runTool(
  tool: string,
  args: Record<string, unknown>,
  ctx: AiToolContext,
): Promise<ToolResult> {
  try {
    switch (tool) {
      case 'listProject': {
        const dir = safeRelPath(String(args.dir ?? ''))
        const target = dir === '' || dir === null ? ctx.rootPath : joinProjectPath(ctx.rootPath, dir)
        const entries = await getBridge().project.readDir(ctx.rootPath, target)
        const lines = entries.map((e) => `${e.isDirectory ? '[目录]' : '[文件]'} ${e.name}${e.isDirectory ? '/' : ''}`)
        return { ok: true, output: lines.join('\n') || '（空目录）' }
      }
      case 'readFile': {
        const rel = safeRelPath(String(args.path ?? ''))
        if (!rel) return { ok: false, error: 'path 必须是项目内相对路径' }
        const content = await readProjectFile(ctx.rootPath, rel)
        return { ok: true, output: content.slice(0, 200_000) }
      }
      case 'searchInProject': {
        const q = String(args.query ?? '').toLowerCase()
        if (!q) return { ok: false, error: 'query 不能为空' }
        const { files } = await getBridge().mod.scanResources(ctx.rootPath)
        const hits = files.filter((f) => f.toLowerCase().includes(q)).slice(0, 50)
        return { ok: true, output: hits.join('\n') || '（无匹配文件）' }
      }
      case 'grepInProject': {
        const q = String(args.query ?? '').toLowerCase()
        if (!q) return { ok: false, error: 'query 不能为空' }
        const dirRel = safeRelPath(String(args.dir ?? ''))
        const prefix = dirRel === null || dirRel === '' ? '' : `${dirRel}/`
        const { files } = await getBridge().mod.scanResources(ctx.rootPath)
        const out: string[] = []
        for (const f of files.filter((x) => x.startsWith(prefix))) {
          if (!isRustConfigFile(f)) continue
          try {
            const content = await readProjectFile(ctx.rootPath, f)
            content.split(/\r?\n/).forEach((line, i) => {
              if (line.toLowerCase().includes(q)) out.push(`${f}:${i + 1}:${line.trim().slice(0, 120)}`)
            })
          } catch {
            // 读失败跳过
          }
          if (out.length >= 100) break
        }
        return { ok: true, output: out.join('\n') || '（无匹配）' }
      }
      case 'sectionOutline': {
        const rel = safeRelPath(String(args.path ?? ''))
        if (!rel) return { ok: false, error: 'path 必须是项目内相对路径' }
        const content = await readProjectFile(ctx.rootPath, rel)
        const outline = scanSections(content)
        return {
          ok: true,
          output: outline.map((s) => `[${s.name}] 第 ${s.line} 行`).join('\n') || '（无节）',
        }
      }
      case 'codeTable': {
        const q = String(args.query ?? '')
        const zhToEn = (k: string) => getKeyZhToEnDict().get(k) ?? getZhToEnDict().get(k)
        const hits = findCodesByQuery(q, 20)
        if (hits.length === 0) {
          const en = zhToEn(q)
          const byEn = en ? findCodesByQuery(en, 20) : []
          if (byEn.length > 0) return { ok: true, output: formatCodeHits(byEn) }
          return { ok: true, output: '（代码表无匹配）' }
        }
        return { ok: true, output: formatCodeHits(hits) }
      }
      case 'queryReference': {
        const q = String(args.query ?? '').toLowerCase()
        const domain = String(args.domain ?? 'all')
        const out: string[] = []
        if (domain === 'all' || domain === 'code') {
          const hits = findCodesByQuery(q, 10)
          if (hits.length > 0) out.push('【代码表】\n' + formatCodeHits(hits))
        }
        if (domain === 'all' || domain === 'logic') {
          const hits = searchLogicBooleans(q, 10)
          if (hits.length > 0) out.push('【逻辑语法】\n' + hits.map((h) => `${h.name} — ${h.description ?? ''}`).join('\n'))
          const vocab = searchVocabulary(q, 5)
          if (vocab.length > 0) out.push('【词库】\n' + vocab.map((v) => `${v.word} — ${v.explanation}`).join('\n'))
        }
        if (domain === 'all' || domain === 'unit') {
          const units = getAllOfficialUnits().filter((u) => u.name.toLowerCase().includes(q) || (u.zhName ?? '').includes(q)).slice(0, 10)
          if (units.length > 0) out.push('【官方单位】\n' + units.map((u) => `${u.name}（${u.zhName ?? u.displayKey}）`).join('\n'))
        }
        if (domain === 'all' || domain === 'section') {
          const sections = getAllSections().filter((s) => s.code.toLowerCase().includes(q) || s.translate.includes(q)).slice(0, 10)
          if (sections.length > 0) out.push('【节名】\n' + sections.map((s) => `${s.code}（${s.translate}）`).join('\n'))
        }
        return { ok: true, output: out.join('\n\n') || '（参考库无匹配）' }
      }
      case 'generateCheckCases': {
        const rel = safeRelPath(String(args.path ?? ''))
        if (!rel) return { ok: false, error: 'path 必须是项目内相对路径' }
        const content = await readProjectFile(ctx.rootPath, rel)
        // 基于语义检查器对文件做一次真实扫描，转成声明式规则（贴合实际字段）
        const zhToEn = (k: string) => getKeyZhToEnDict().get(k) ?? getZhToEnDict().get(k)
        const lintData = {
          findCode: (k: string) => findCodeByCode(k),
          findType: (t: string) => findValueType(t),
          zhToEn,
        }
        const issues = runSemanticChecks(content, { ctx: { ...lintData, codes: getAllCodes().map((c) => c.code), file: rel } })
        const cases: Array<Record<string, unknown>> = []
        for (const it of issues.slice(0, 20)) {
          cases.push({
            id: `check-${cases.length + 1}`,
            title: it.message.slice(0, 30),
            section: undefined,
            key: undefined,
            severity: it.severity,
            check: { type: 'regex-match', pattern: '.*' },
            note: `${rel}:${it.line} ${it.suggestion}`,
          })
        }
        if (cases.length === 0) {
          cases.push({
            id: 'check-1',
            title: `${rel} 基础检查`,
            key: 'maxHp',
            severity: 'warning',
            check: { type: 'numeric-range', min: 1 },
          })
        }
        return { ok: true, output: JSON.stringify({ formatVersion: 1, name: `${rel} 检查用例`, rules: cases }, null, 2) }
      }
      case 'writeFile': {
        const rel = safeRelPath(String(args.path ?? ''))
        if (!rel) return { ok: false, error: 'path 必须是项目内相对路径' }
        const content = String(args.content ?? '')
        const preview = content.slice(0, 800)
        const approved = await ctx.approveWrite({ tool, path: rel, contentPreview: preview })
        if (!approved) return { ok: false, error: '用户拒绝了本次写入，请调整方案后重试' }
        const file = joinProjectPath(ctx.rootPath, rel)
        const bridge = getBridge()
        const parent = file.slice(0, file.lastIndexOf('/'))
        await bridge.project.createFolder(ctx.rootPath, parent, '')
        await bridge.project.writeFile(ctx.rootPath, file, content, { hasBom: false })
        return { ok: true, output: `已写入 ${rel}（${content.length} 字符）` }
      }
      case 'applyDiff': {
        const rel = safeRelPath(String(args.path ?? ''))
        if (!rel) return { ok: false, error: 'path 必须是项目内相对路径' }
        const diffText = String(args.diff ?? '')
        const old = await readProjectFile(ctx.rootPath, rel)
        const hunks = parseUnifiedDiff(diffText)
        const preview = hunks
          .map((h) => `@@ -${h.oldStart},${h.oldCount} +${h.newStart},${h.newCount} @@\n${h.lines.map((l) => `${l.type === 'del' ? '-' : l.type === 'add' ? '+' : ' '}${l.text}`).join('\n')}`)
          .join('\n')
          .slice(0, 800)
        const approved = await ctx.approveWrite({ tool, path: rel, contentPreview: preview, diff: diffText })
        if (!approved) return { ok: false, error: '用户拒绝了本次修改，请调整方案后重试' }
        const result = applyUnifiedDiff(old, hunks)
        if (!result.ok) return { ok: false, error: result.error }
        await getBridge().project.writeFile(ctx.rootPath, joinProjectPath(ctx.rootPath, rel), result.text, { hasBom: false })
        return { ok: true, output: `已应用 diff 到 ${rel}` }
      }
      default:
        return { ok: false, error: `未知工具：${tool}` }
    }
  } catch (err) {
    const msg = typeof err === 'string' ? err : err instanceof Error ? err.message : String(err)
    return { ok: false, error: msg }
  }
}

function formatCodeHits(hits: Array<{ code: string; translate: string; description: string; type: string; section?: string }>): string {
  return hits
    .map((c) => `${c.code}（${c.translate}）类型:${c.type}${c.section ? ` 节:${c.section}` : ''}${c.description ? ` — ${c.description}` : ''}`)
    .join('\n')
}

/** 把工具执行结果转成回传消息 */
export function toolResultToMessage(toolName: string, result: ToolResult): AiChatMessage {
  return {
    role: 'user',
    content: result.ok
      ? `工具 ${toolName} 结果：\n${result.output}`
      : `工具 ${toolName} 执行失败：${result.error}`,
  }
}
