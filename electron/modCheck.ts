/**
 * 模组检查（M40 巨型文件拆分批次 A5）：
 * 单位完整性（name 缺失/[core] 缺失/单位名重复）+ 链式检查规则。
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { existsSync } from 'node:fs'
import { splitTopLevelConfigValue } from '../src/services/configSyntax'
import { keyMap, parseIniSections } from './modIni'
import { readTextLimited, resolveInside } from './modShared'
import { isExcluded } from './modScan'

/** 单位检查：name 缺失 / [core] 缺失 / name 全局重复 */
export interface ModCheckIssue {
  file: string
  level: 'error' | 'warning' | 'info'
  message: string
}

export interface ModCheckResult {
  issues: ModCheckIssue[]
  unitCount: number
  fileCount: number
}

/** 链式检查规则（public/data/chain_inspection.json） */
export interface ChainRule {
  id: string
  key?: string
  value?: string
  type: string
  list?: string
}

function dataDir(): string {
  const candidates = [
    path.join(__dirname, '..', '..', 'public', 'data'),
    path.join(__dirname, '..', 'public', 'data'),
  ]
  for (const c of candidates) {
    if (existsSync(c)) return c
  }
  return candidates[0]
}

/** 加载链式检查规则（缺失时返回空数组，不阻断检查） */
export async function loadChainRules(): Promise<ChainRule[]> {
  try {
    const raw = JSON.parse(await fs.readFile(path.join(dataDir(), 'chain_inspection.json'), 'utf8')) as { data?: ChainRule[] }
    return raw.data ?? []
  } catch {
    return []
  }
}

/**
 * 对单个单位文件执行链式检查（纯函数，供测试）：
 * - @file   规则：单位文件应包含 list 中的节（缺失 → 警告）
 * - section 规则：若 value 节存在（支持 turret → turret_1 编号节），
 *   list 中的键应存在于该节（缺失 → 警告）
 * - key    规则：若 key 存在且值命中（或 @auto 表示存在即触发），
 *   list 中的键应存在；@tip(...) 在触发时输出提示
 */
export function runChainInspection(content: string, rules: ChainRule[], file: string): ModCheckIssue[] {
  const issues: ModCheckIssue[] = []
  const sections = parseIniSections(content)
  const sectionNames = new Set(sections.map((s) => s.name))

  for (const rule of rules) {
    const list = splitTopLevelConfigValue(rule.list ?? '').map((s) => s.trim()).filter(Boolean)
    const tips = list.filter((s) => s.startsWith('@tip(')).map((s) => s.replace(/^@tip\((.*)\)$/, '$1'))
    const keys = list.filter((s) => !s.startsWith('@'))

    if (rule.type === '@file') {
      for (const sec of keys) {
        if (sec && !sectionNames.has(sec)) {
          issues.push({ file, level: 'warning', message: `缺少 [${sec}] 节（链式检查：单位应有此节）` })
        }
      }
      continue
    }

    if (rule.type === 'section') {
      const target = rule.value ?? ''
      // 精确节名或编号节（turret → turret_1）
      const matched = sections.filter((s) => s.name === target || s.name.startsWith(`${target}_`))
      if (matched.length === 0) continue
      for (const sec of matched) {
        const km = keyMap(sec)
        for (const k of keys) {
          if (k && !km.has(k)) {
            issues.push({ file, level: 'warning', message: `[${sec.name}] 节缺少 ${k}（链式检查：该节应包含 ${k}）` })
          }
        }
      }
      continue
    }

    if (rule.type === 'key') {
      const ruleKey = rule.key ?? ''
      for (const sec of sections) {
        const km = keyMap(sec)
        if (!km.has(ruleKey)) continue
        const actual = km.get(ruleKey) ?? ''
        // @auto：存在即触发；否则值必须匹配（如 canAttack=true）
        const triggered = rule.value === '@auto' || actual === rule.value
        if (!triggered) continue
        for (const t of tips) issues.push({ file, level: 'info', message: `[${sec.name}] ${ruleKey}: ${actual} — ${t}` })
        for (const k of keys) {
          if (k && !km.has(k)) {
            issues.push({ file, level: 'warning', message: `[${sec.name}] ${ruleKey}: ${actual} 时建议补充 ${k}` })
          }
        }
      }
    }
  }

  return issues
}

export async function checkMod(projectRoot: string): Promise<ModCheckResult> {
  const root = resolveInside(projectRoot, '.')
  const issues: ModCheckIssue[] = []
  const nameCount = new Map<string, string[]>()
  let unitCount = 0
  let fileCount = 0
  const rules = await loadChainRules()

  const iniFiles: string[] = []
  async function collect(dir: string, prefix: string): Promise<void> {
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      if (isExcluded(entry.name)) continue
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name
      if (entry.isDirectory()) {
        await collect(path.join(dir, entry.name), rel)
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.ini')) {
        iniFiles.push(rel)
        fileCount++
      }
    }
  }
  await collect(root, '')

  for (const rel of iniFiles) {
    const content = await readTextLimited(path.join(root, rel))
    const sections = parseIniSections(content)
    // 单位判定：节名小写后 [core]/[核心] 都算（与 scanResources/scanUnits 一致）
    const isUnit = sections.some((s) => s.name === 'core' || s.name === '核心')
    if (!isUnit) continue

    unitCount++
    const nameValue = sections.find((s) => s.name === 'core' || s.name === '核心')?.keys.find((k) => k.key.toLowerCase() === 'name')?.value
    if (!nameValue) {
      issues.push({ file: rel, level: 'error', message: `缺少 [core] name:（单位名必填）` })
      continue
    }
    const list = nameCount.get(nameValue) ?? []
    list.push(rel)
    nameCount.set(nameValue, list)

    // 链式检查（对每个单位文件跑规则，追加警告）
    issues.push(...runChainInspection(content, rules, rel))
  }

  for (const [name, files] of nameCount) {
    if (files.length > 1) {
      issues.push({ file: files.join('、'), level: 'error', message: `单位名「${name}」重复（全局唯一）：${files.length} 处` })
    }
  }

  return { issues, unitCount, fileCount }
}
