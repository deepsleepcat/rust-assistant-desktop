#!/usr/bin/env node
/** Validate the project-local Rusted Warfare skill's discoverability and corpus. */
import fs from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const skillRoot = path.resolve(scriptDir, '..')
const referencesDir = path.join(skillRoot, 'references')
const requiredReferences = [
  '00-source-authority-and-versioning.md',
  '01-mod-discovery-rwmod-and-metadata.md',
  '02-ini-parser-templates-and-inheritance.md',
  '03-unit-architecture-and-field-catalog-routing.md',
  '04-actions-logic-resources-effects-and-state.md',
  '05-assets-audio-localization-and-maps.md',
  '06-cross-references-validation-and-debugging.md',
  '07-packaging-release-and-regression.md',
  '08-case-study-abyss-stars.md',
  '09-case-study-aseu.md',
  '10-instance-mod-compatibility-matrix.md',
  '11-agent-prompts-and-task-playbooks.md',
  '12-known-limitations-and-errata.md',
]
const requiredTopics = new Map([
  ['00-source-authority-and-versioning.md', ['证据', '版本']],
  ['01-mod-discovery-rwmod-and-metadata.md', ['rwmod', 'mod-info.txt', 'title']],
  ['02-ini-parser-templates-and-inheritance.md', ['copyFrom', 'all-units.template', '@copyFromSection']],
  ['03-unit-architecture-and-field-catalog-routing.md', ['[core]', '[graphics]', '字段']],
  ['04-actions-logic-resources-effects-and-state.md', ['hiddenAction', '资源', 'LogicBoolean']],
  ['05-assets-audio-localization-and-maps.md', ['本地化', '地图', '音频']],
  ['06-cross-references-validation-and-debugging.md', ['引用', '调试', 'strictLevel']],
  ['07-packaging-release-and-regression.md', ['发布', '回归', 'rwmod']],
  ['08-case-study-abyss-stars.md', ['AbyssStars', '深渊星辰']],
  ['09-case-study-aseu.md', ['ASEU', '深渊扩展']],
  ['10-instance-mod-compatibility-matrix.md', ['模组实例', '特殊', '兼容']],
  ['11-agent-prompts-and-task-playbooks.md', ['提示词', '工作流']],
  ['12-known-limitations-and-errata.md', ['模拟', '勘误']],
])
const MIN_HAN_CHARS = 110_000
const MAX_SKILL_LINES = 520
const inventoryPath = path.join(referencesDir, 'corpus-inventory.json')
const requiredInventorySources = [
  'W:\\mao\\tx\\tools\\decompilers\\game-lib-src',
  'W:\\mao\\tx\\模组加载器',
  'W:\\mao\\tx\\AbyssStars深渊星辰0.7.10',
  'W:\\mao\\tx\\ASEU深渊星辰-深渊扩展DLCX',
  'W:\\mao\\tx\\模组实例',
  'W:\\mao\\tx\\模组实例\\特殊',
]

function issue(level, code, message, file = undefined) {
  return { level, code, message, ...(file ? { file } : {}) }
}

function markdownLinks(text) {
  const links = []
  const re = /\[[^\]]*\]\(([^)]+)\)/g
  for (let match; (match = re.exec(text));) {
    const target = match[1].split('#', 1)[0].trim()
    if (target && !/^[a-z]+:/i.test(target)) links.push(target)
  }
  return links
}

function isInside(root, candidate) {
  const rel = path.relative(root, candidate)
  return rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel))
}

async function exists(file) {
  return fs.access(file).then(() => true).catch(() => false)
}

export async function validateSkill() {
  const findings = []
  const skillPath = path.join(skillRoot, 'SKILL.md')
  const skillText = await fs.readFile(skillPath, 'utf8').catch((error) => {
    findings.push(issue('error', 'skill-read', `无法读取 SKILL.md：${error.message}`, skillPath))
    return ''
  })
  const frontmatter = skillText.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/)
  if (!frontmatter) findings.push(issue('error', 'frontmatter', 'SKILL.md 缺少 YAML frontmatter。', skillPath))
  else {
    const name = frontmatter[1].match(/^name:\s*(.+?)\s*$/m)?.[1]
    const description = frontmatter[1].match(/^description:\s*(.+?)\s*$/m)?.[1]
    if (name !== 'rusted-warfare-modding') findings.push(issue('error', 'skill-name', 'frontmatter name 必须与父目录 rusted-warfare-modding 一致。', skillPath))
    if (!description || description.length > 1024) findings.push(issue('error', 'skill-description', 'frontmatter description 缺失或超过 1024 个字符。', skillPath))
  }
  const skillLines = skillText ? skillText.split(/\r?\n/).length : 0
  if (skillLines > MAX_SKILL_LINES) findings.push(issue('error', 'skill-size', `SKILL.md 有 ${skillLines} 行，超过渐进加载上限 ${MAX_SKILL_LINES}。`, skillPath))
  for (const required of ['Engine-confirmed', 'audit-rwmod.mjs', 'validate-skill.mjs', 'all-units.template']) {
    if (!skillText.includes(required)) findings.push(issue('error', 'skill-routing', `SKILL.md 缺少关键工作流标记：${required}`, skillPath))
  }

  const inventory = await fs.readFile(inventoryPath, 'utf8').then((text) => JSON.parse(text)).catch((error) => {
    findings.push(issue('error', 'inventory-read', `无法读取或解析来源清单：${error.message}`, inventoryPath))
    return null
  })
  if (inventory) {
    const paths = new Set((inventory.sources ?? []).map((source) => source.path))
    for (const requiredPath of requiredInventorySources) {
      if (!paths.has(requiredPath)) findings.push(issue('error', 'inventory-source', `来源清单缺少指定证据源：${requiredPath}`, inventoryPath))
    }
    const instanceCorpus = inventory.sources?.find((source) => source.path === 'W:\\mao\\tx\\模组实例')
    const specialSubset = inventory.sources?.find((source) => source.path === 'W:\\mao\\tx\\模组实例\\特殊')
    if (instanceCorpus?.readOnlyAudit?.archives !== 48) {
      findings.push(issue('error', 'inventory-instance-count', '来源清单必须记录已审计的 48 个顶层实例 rwmod。', inventoryPath))
    }
    if (instanceCorpus?.readOnlyAudit?.recursivePhysicalArchivePaths !== 59 || instanceCorpus?.readOnlyAudit?.specialSubsetPhysicalArchivePaths !== 11) {
      findings.push(issue('error', 'inventory-instance-paths', '来源清单必须区分 48 个顶层样本、59 个递归物理路径和 11 个特殊子集路径。', inventoryPath))
    }
    if (specialSubset?.subsetOf !== 'W:\\mao\\tx\\模组实例' || specialSubset?.readOnlyAudit?.archives !== 11 || specialSubset?.overlap?.allPayloadsMatchParentCorpus !== true || specialSubset?.overlap?.addsNewTopLevelSampleIdentities !== 0) {
      findings.push(issue('error', 'inventory-special-subset', '特殊目录必须登记为父实例库的 11 条重叠镜像路径，而非新增独立样本。', inventoryPath))
    }
  }

  const contents = new Map()
  let hanChars = 0
  for (const name of requiredReferences) {
    const absolute = path.join(referencesDir, name)
    if (!(await exists(absolute))) {
      findings.push(issue('error', 'reference-missing', '缺少必备参考文件。', absolute))
      continue
    }
    const text = await fs.readFile(absolute, 'utf8')
    contents.set(name, text)
    const perFileHan = (text.match(/[\u3400-\u9fff]/g) ?? []).length
    hanChars += perFileHan
    if (perFileHan < 4_000) findings.push(issue('error', 'reference-too-short', `中文有效内容仅 ${perFileHan} 字，低于每章 4,000 字下限。`, absolute))
    for (const topic of requiredTopics.get(name) ?? []) {
      if (!text.includes(topic)) findings.push(issue('error', 'reference-topic', `缺少验收主题：${topic}`, absolute))
    }
    if (!text.includes('SKILL.md')) findings.push(issue('warning', 'reference-navigation', '章节没有指出主 SKILL.md，按需阅读路径不清晰。', absolute))
  }
  if (hanChars < MIN_HAN_CHARS) findings.push(issue('error', 'corpus-size', `参考库中文字符数 ${hanChars}，低于 ${MIN_HAN_CHARS} 下限。`, referencesDir))

  const readmePath = path.join(referencesDir, 'README.md')
  const readmeText = await fs.readFile(readmePath, 'utf8').catch((error) => {
    findings.push(issue('error', 'reference-index-read', `无法读取参考索引：${error.message}`, readmePath))
    return ''
  })
  const allFiles = new Map([['SKILL.md', skillText], ['references/README.md', readmeText], ...contents])
  for (const [name, text] of allFiles) {
    const base = name === 'SKILL.md' ? skillRoot : referencesDir
    for (const target of markdownLinks(text)) {
      const resolved = path.resolve(base, target)
      if (!isInside(skillRoot, resolved)) {
        findings.push(issue('error', 'link-escape', `Markdown 链接越出 skill 根目录：${target}`, name))
      } else if (!(await exists(resolved))) {
        findings.push(issue('error', 'link-missing', `Markdown 链接目标不存在：${target}`, name))
      }
    }
  }
  const summary = {
    errors: findings.filter((item) => item.level === 'error').length,
    warnings: findings.filter((item) => item.level === 'warning').length,
    referenceHanChars: hanChars,
    referenceCount: contents.size,
    skillLines,
    ok: !findings.some((item) => item.level === 'error'),
  }
  return { skillRoot, summary, findings }
}

function print(result) {
  console.log(`Skill: ${result.skillRoot}`)
  console.log(`参考章节: ${result.summary.referenceCount}/${requiredReferences.length} | 中文字符: ${result.summary.referenceHanChars} | SKILL 行数: ${result.summary.skillLines}`)
  if (!result.findings.length) console.log('Skill 结构、引用、主题和内容规模均通过。')
  for (const item of result.findings) console.log(`[${item.level.toUpperCase()}] ${item.code}${item.file ? ` ${item.file}` : ''}: ${item.message}`)
  console.log(`汇总: ${result.summary.errors} error, ${result.summary.warnings} warning`)
}

async function main() {
  const result = await validateSkill()
  print(result)
  process.exitCode = result.summary.ok ? 0 : 1
}

if (path.resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) await main()
