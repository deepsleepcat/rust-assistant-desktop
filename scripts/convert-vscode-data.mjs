/**
 * 把 RustedWarfareModSupport（VSCode 插件）的 1.15 新版代码表并入我们的 code.json/section.json。
 *
 * 合并策略（低风险）：
 * - 以手机版数据（public/data/code.json）为基底——translate 中文译名已被翻译系统验证；
 * - 遍历 VSCode 962 条属性：code 已存在 → 保留手机版（词典兼容）；不存在 → 追加，
 *   中文名取自插件 zh-cn 翻译（description 字段是 l10n 键）；
 * - 节表取并集（VSCode 26 节 vs 我们 30 节）；
 * - isOutdated 条目照常收录（代码表应完整；UI 无废弃标记时不影响使用）。
 *
 * 用法：node scripts/convert-vscode-data.mjs
 * 前置：W:\mao\tx\RustedWarfareModSupport-rustedwarfare-1.15 存在
 */
import { readFileSync, writeFileSync, readdirSync } from 'node:fs'
import path from 'node:path'

const PLUGIN = 'W:/mao/tx/RustedWarfareModSupport-rustedwarfare-1.15'
const DATA = 'public/data'

const plugin = (p) => path.join(PLUGIN, p)
const read = (p) => JSON.parse(readFileSync(p, 'utf8'))

// ── 读取插件数据 ──────────────────────────────
const zhCn = read(plugin('translation/bundle.l10n.zh-cn.json'))
const pluginSections = read(plugin('data/sections.json')).data // [{name, description(l10n键)}]
const pluginFiles = readdirSync(plugin('data/sections')).filter((f) => f.endsWith('.json'))
// mod-info.txt 是单独一张表（插件顶层 data/mod-info.json）
const sectionEntries = []
for (const f of pluginFiles) {
  const sec = path.basename(f, '.json')
  const d = read(plugin(`data/sections/${f}`))
  for (const e of d.data ?? []) sectionEntries.push({ ...e, section: sec })
}
for (const e of (read(plugin('data/mod-info.json')).data ?? [])) {
  sectionEntries.push({ ...e, section: 'mod-info' })
}

// ── 读取我们的数据 ────────────────────────────
const codeRaw = read(path.join(DATA, 'code.json'))
const sectionRaw = read(path.join(DATA, 'section.json'))
// 去重按小写比较：code 键大小写不敏感（image/Image、x/X 是同一键），
// 否则 VSCode 的 Image/X 会作为「新条目」追加，词典构建时尾部覆盖手机版译名
const existingCodes = new Set((codeRaw.data ?? []).map((c) => c.code.toLowerCase()))
const existingSections = new Set((sectionRaw.data ?? []).map((s) => s.code))

// ── 合并属性表 ────────────────────────────────
let added = 0
const zhText = (key) => {
  const t = zhCn[key]
  return typeof t === 'string' && t.trim() ? t.trim() : undefined
}
for (const e of sectionEntries) {
  if (existingCodes.has(e.name.toLowerCase())) continue // 已有（手机版数据优先，词典兼容）
  const zh = zhText(e.description)
  codeRaw.data.push({
    code: e.name,
    translate: zh ?? e.name, // 无翻译时用原名兜底，避免补全/代码表出现空中文
    description: zh ?? e.name,
    type: e.type ?? 'string',
    section: e.section,
    demo: e.example ? `示例：\n${e.example}` : undefined,
  })
  existingCodes.add(e.name.toLowerCase())
  added++
}

// ── 合并节表（并集）───────────────────────────
let addedSections = 0
const zhSectionName = (name) => {
  const key = `data.sections.${name}`
  if (zhCn[key]) return zhText(key)
  // 插件节表 description 也是 l10n 键（如 data.sections.prices）
  const meta = pluginSections.find((s) => s.name === name)
  return meta ? zhText(meta.description) : undefined
}
for (const name of pluginSections.map((s) => s.name)) {
  if (existingSections.has(name)) continue
  sectionRaw.data.push({
    code: name,
    translate: zhSectionName(name) ?? name,
    // spawnUnits/spawnProjectiles 等节带命名后缀，与 turret/projectile 同语义
    needName: name === 'spawnUnits' || name === 'spawnProjectiles',
  })
  existingSections.add(name)
  addedSections++
}

// ── 写出（保持缩进格式与 git diff 可读性）──────
writeFileSync(path.join(DATA, 'code.json'), JSON.stringify(codeRaw, null, 2) + '\n')
writeFileSync(path.join(DATA, 'section.json'), JSON.stringify(sectionRaw, null, 2) + '\n')
console.log(`code.json: 新增 ${added} 条（${sectionEntries.length} 条插件属性中）`)
console.log(`section.json: 新增 ${addedSections} 个节（现在共 ${sectionRaw.data.length} 个）`)
