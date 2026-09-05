/**
 * 模板系统（M40 巨型文件拆分批次 A7，移植手机版 baseTemplate_v2.0）：
 * 内置/用户模板的加载、制作、导入、删除与基于模板创建单位。
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { existsSync } from 'node:fs'
import { assertNoLinkEscape, isPathInside } from './paths'
import type { TemplateAction, TemplateMeta } from '../src/types/mod'
import { MAX_SCAN_READ_SIZE, exists, resolveInside } from './modShared'

/** 原始模板 JSON 结构（public/data/templates/*.json） */
export interface RawTemplate {
  name?: string
  name_en?: string
  data?: string
  language?: string
  action?: Array<{ name?: string; key?: string; section?: string; tag?: string; type?: string }>
}

function templatesDir(): string {
  // 编译后 __dirname = dist-electron/electron（两级到项目根）；
  // vitest 直跑源码 __dirname = electron/（一级到项目根）。两个都试。
  const candidates = [
    path.join(__dirname, '..', '..', 'public', 'data', 'templates'),
    path.join(__dirname, '..', 'public', 'data', 'templates'),
  ]
  for (const c of candidates) {
    if (existsSync(c)) return c
  }
  return candidates[0]
}

/** 加载模板 JSON：按 key 精确匹配文件名（键名保留中文等字符，与 saveFileAsTemplate 一致），
 * 内置目录与用户模板目录依次查找；key 含路径分隔符或越界时拒绝。 */
async function loadTemplateRaw(key: string, extraDirs: string[] = []): Promise<RawTemplate | null> {
  if (!key || key.includes('/') || key.includes('\\') || key === '.' || key === '..') return null
  for (const dir of [templatesDir(), ...extraDirs]) {
    const file = path.join(dir, `${key}.json`)
    if (!isPathInside(dir, file)) return null
    try {
      return JSON.parse(await fs.readFile(file, 'utf8')) as RawTemplate
    } catch {
      // 该目录没有此模板（或已损坏）：尝试下一个目录
    }
  }
  return null
}

/** 从模板 data 文本提取 [section] 节的 key 当前值 */
function extractDefaults(data: string | undefined, actions: TemplateAction[]): Record<string, string> {
  const out: Record<string, string> = {}
  if (!data) return out
  let current = ''
  for (const rawLine of data.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, '').trim()
    const sectionMatch = line.match(/^\[(.+)\]$/)
    if (sectionMatch) {
      current = sectionMatch[1]
      continue
    }
    const kv = line.match(/^([^:]+):\s*(.*)$/)
    if (kv) {
      const key = kv[1].trim()
      const action = actions.find((a) => a.key === key && a.section === current)
      if (action && out[action.tag] === undefined) out[action.tag] = kv[2].trim()
    }
  }
  return out
}

function toTemplateMeta(key: string, raw: RawTemplate): TemplateMeta {
  const actions: TemplateAction[] = (raw.action ?? []).map((a) => ({
    label: a.name ?? a.key ?? '',
    key: a.key ?? '',
    section: a.section ?? '',
    tag: a.tag ?? '',
    type: a.type ?? 'input',
  }))
  return {
    key,
    name: raw.name ?? key,
    nameEn: raw.name_en ?? '',
    actions,
    defaults: extractDefaults(raw.data, actions),
  }
}

/** 列出全部模板元数据（内置包 + 用户模板目录） */
export async function listTemplates(extraDirs: string[] = []): Promise<TemplateMeta[]> {
  const dirs = [templatesDir(), ...extraDirs]
  const metas: TemplateMeta[] = []
  const seen = new Set<string>()
  for (const dir of dirs) {
    let files: string[]
    try {
      files = await fs.readdir(dir)
    } catch {
      continue
    }
    for (const f of files.filter((f) => f.endsWith('.json'))) {
      const key = path.basename(f, '.json')
      if (seen.has(key)) continue
      seen.add(key)
      try {
        const raw = JSON.parse(await fs.readFile(path.join(dir, f), 'utf8')) as RawTemplate
        metas.push(toTemplateMeta(key, raw))
      } catch {
        // 单个模板损坏（如用户手工编辑或半截写入）不影响其它模板
        continue
      }
    }
  }
  return metas.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'))
}

/**
 * 把单位源文件保存为模板（模板制作）：
 * - 以文件内容为模板 data；content 可选——传入时用该内容（当前编辑缓冲），
 *   否则读磁盘（与编辑器一致；未保存的修改也能存进模板）；
 * - 自动生成 action：name / maxHp / price 三个输入项（文件里有对应键才生成）；
 * - 写入目标目录（用户模板目录），key 取文件名（仅去除路径分隔符等非法字符，
 *   保留中文等字符，避免「坦克」「侦察车」都变成 custom-template 互相覆盖）；
 * - 目标已存在同名模板时自动追加 -2/-3 序号，绝不静默覆盖。
 */
export async function saveFileAsTemplate(
  projectRoot: string,
  filePath: string,
  templateName: string,
  destDir: string,
  content?: string,
): Promise<{ key: string }> {
  const root = resolveInside(projectRoot, '.')
  const file = resolveInside(root, filePath)
  // L-6：读取源文件前做链接逃逸校验（不能把 junction 指向的外部文件内容存成模板）
  await assertNoLinkEscape(root, file)
  const data = content ?? (await fs.readFile(file, 'utf8'))
  const base = path.basename(filePath, path.extname(filePath)).replace(/[\\/:*?"<>|]/g, '-').trim() || 'custom-template'
  const raw = buildTemplateFromFile(data, templateName)
  await fs.mkdir(destDir, { recursive: true })
  let key = base
  for (let suffix = 2; await exists(path.join(destDir, `${key}.json`)); suffix++) key = `${base}-${suffix}`
  await fs.writeFile(path.join(destDir, `${key}.json`), JSON.stringify(raw, null, 2), 'utf8')
  return { key }
}

/** 从源文件文本生成模板 JSON（纯函数，供测试）：自动提取 action 输入项 */
export function buildTemplateFromFile(content: string, templateName: string): RawTemplate {
  const data = content.replace(/\r\n/g, '\n').replace(/\n+$/, '')
  const action: RawTemplate['action'] = []
  const hasKeyInSection = (key: string, section: string) => {
    const m = new RegExp(`\\[${section}\\]\\s*\\n([\\s\\S]*?)(?:\\n\\[|$)`)
    const sec = data.match(m)?.[1] ?? ''
    return new RegExp(`^\\s*${key}\\s*:`, 'm').test(sec)
  }
  // 与参考实现一致：name/maxHp/price 三输入项，文件里有对应键才生成
  for (const [key, label] of [['name', '名称'], ['maxHp', '血量'], ['price', '价格']] as const) {
    if (hasKeyInSection(key, 'core')) {
      action.push({ name: label, key, section: 'core', tag: `${key}-core`, type: 'input' })
    }
  }
  return { name: templateName, data, language: 'ALL', action }
}

/** 用用户输入替换模板 data 中对应 [section] 节的 key 值（未填的保留默认） */
export function buildFileFromTemplate(raw: RawTemplate, values: Record<string, string>): string {
  const data = raw.data ?? ''
  let current = ''
  return data
    .split(/\r?\n/)
    .map((line) => {
      const sectionMatch = line.match(/^\[(.+)\]$/)
      if (sectionMatch) {
        current = sectionMatch[1]
        return line
      }
      // 跳过注释/节外行；只替换模板声明的字段
      if (line.trim().startsWith('#') || !line.trim()) return line
      const kv = line.match(/^(\s*)([^#:]+?)\s*:\s*(.*)$/)
      if (!kv) return line
      const key = kv[2].trim()
      const action = (raw.action ?? []).find((a) => a.key === key && a.section === current)
      const input = action?.tag ? values[action.tag] : undefined
      if (action && input !== undefined && String(input).trim() !== '') {
        return `${kv[1]}${key}: ${String(input).trim()}`
      }
      return line
    })
    .join('\n')
}

/** 基于模板创建单位：<英文名>/<英文名>.ini（已存在报错）。
 * extraTemplateDirs：用户模板目录，让「保存为模板」制作的模板也能用来创建单位。 */
export async function createUnitFromTemplate(
  projectRoot: string,
  params: { name: string; folder?: string; templateKey: string; values: Record<string, string> },
  extraTemplateDirs: string[] = [],
): Promise<{ path: string }> {
  const root = resolveInside(projectRoot, '.')
  const safeName = params.name.trim().replace(/[\\/:*?"<>|]/g, '-') || 'unit'
  const folder = (params.folder ?? '').replace(/^\/+|\/+$/g, '')
  const rel = folder ? path.posix.join(folder, safeName, `${safeName}.ini`) : path.posix.join(safeName, `${safeName}.ini`)
  const file = resolveInside(root, rel)
  if (await exists(file)) {
    throw new Error(`单位文件已存在：${rel}（不会覆盖已有文件）`)
  }
  const raw = await loadTemplateRaw(params.templateKey, extraTemplateDirs)
  if (!raw) throw new Error(`模板不存在：${params.templateKey}`)
  // M-1：与 createUnit 对齐——模板新建也做链接逃逸校验（项目内 junction 不能写穿）
  await assertNoLinkEscape(root, file)
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, buildFileFromTemplate(raw, params.values ?? {}), 'utf8')
  return { path: rel }
}

/** 模板文件名消毒（key 来自文件名：只允许安全字符，保留中文，防路径穿越） */
function sanitizeTemplateKey(name: string): string {
  const cleaned = name.replace(/[\\/:*?"<>|]/g, '-').trim()
  return cleaned || 'custom-template'
}

/**
 * 导入模板文件到用户模板目录（M23 模板库管理）：
 * 来源文件需是合法模板 JSON（损坏拒绝）；key 取文件名（消毒）；
 * 同名自动追加 -2/-3，绝不静默覆盖；只写 destDir。
 */
export async function importTemplateFile(destDir: string, sourcePath: string): Promise<TemplateMeta> {
  // 大小上限（与项目内文件读取一致）：对话框可能选中超大文件，全量读入会拖垮主进程
  const st = await fs.stat(sourcePath).catch(() => null)
  if (!st || !st.isFile()) throw new Error('模板文件不存在')
  if (st.size > MAX_SCAN_READ_SIZE) throw new Error('模板文件过大（超过 64MB），拒绝导入')
  const parsed = JSON.parse(await fs.readFile(sourcePath, 'utf8')) as unknown
  if (!parsed || typeof parsed !== 'object') throw new Error('不是有效的模板文件（内容不是 JSON 对象）')
  const raw = parsed as RawTemplate
  if (typeof raw.name !== 'string' && typeof raw.data !== 'string') {
    throw new Error('不是有效的模板文件（缺少 name 或 data）')
  }
  await fs.mkdir(destDir, { recursive: true })
  const base = sanitizeTemplateKey(path.basename(sourcePath, '.json'))
  let key = base
  for (let suffix = 2; await exists(path.join(destDir, `${key}.json`)); suffix++) key = `${base}-${suffix}`
  await fs.writeFile(path.join(destDir, `${key}.json`), JSON.stringify(raw, null, 2), 'utf8')
  return toTemplateMeta(key, raw)
}

/**
 * 删除用户模板（M23 模板库管理）：只允许删除 destDir（用户目录）内的模板，
 * 内置模板目录不可删除；key 越界/非法拒绝。
 */
export async function deleteUserTemplate(destDir: string, key: string): Promise<{ ok: boolean; message?: string }> {
  if (!key || key.includes('/') || key.includes('\\') || key === '.' || key === '..') {
    return { ok: false, message: '无效的模板名' }
  }
  const file = path.join(destDir, `${key}.json`)
  if (!isPathInside(destDir, file)) return { ok: false, message: '路径越界，拒绝删除' }
  try {
    await fs.rm(file, { force: true })
    return { ok: true }
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) }
  }
}

/** 用户模板目录的 key 列表（分类：来源 = 用户/内置） */
export async function listUserTemplateKeys(destDir: string): Promise<string[]> {
  try {
    const files = await fs.readdir(destDir)
    return files.filter((f) => f.endsWith('.json')).map((f) => path.basename(f, '.json'))
  } catch {
    return []
  }
}
