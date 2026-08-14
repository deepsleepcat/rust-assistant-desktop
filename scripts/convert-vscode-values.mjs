/**
 * 把 RustedWarfareModSupport（VSCode 插件）的值枚举表并入：
 * 1. data/value/*.json（27 张表，除 logicboolean）→ 更新 code.json 对应属性的 type + value_type.json 的 list 枚举
 * 2. data/value/logicboolean.json（139 条逻辑布尔函数）→ public/data/logicboolean.json（hover/补全用）
 *
 * 匹配策略：VSCode 按「属性名 = 表名」匹配。code.json 中 code === 表名的属性，
 * 若其 type 是粗粒度（string/enum/value/unit 等），改为表名，并在 value_type.json
 * 添加 { type: 表名, list: 枚举值列表 }——补全时值候选显示枚举，lint 无 rule 自动跳过。
 *
 * 用法：node scripts/convert-vscode-values.mjs
 */
import { readFileSync, writeFileSync, readdirSync } from 'node:fs'
import path from 'node:path'

const PLUGIN = 'W:/mao/tx/RustedWarfareModSupport-rustedwarfare-1.15'
const DATA = 'public/data'
const plugin = (p) => path.join(PLUGIN, p)
const read = (p) => JSON.parse(readFileSync(p, 'utf8'))
const zhCn = read(plugin('translation/bundle.l10n.zh-cn.json'))
const zhText = (key) => {
  const t = zhCn[key]
  return typeof t === 'string' && t.trim() ? t.trim() : undefined
}

// ── 1. 值枚举表 → code.json type + value_type.json list ──────────
const codeRaw = read(path.join(DATA, 'code.json'))
const vtRaw = read(path.join(DATA, 'value_type.json'))
const valueFiles = readdirSync(plugin('data/value')).filter((f) => f.endsWith('.json') && f !== 'logicboolean.json')

// 粗粒度类型：这些类型没有专属枚举，可安全替换为细粒度表名
const COARSE = new Set(['string', 'enum', 'value', 'unit', 'list', 'event', 'notes', 'code'])
let updatedCodes = 0
let addedTypes = 0

for (const f of valueFiles) {
  const tableName = path.basename(f, '.json')
  const table = read(plugin(`data/value/${f}`))
  const values = (table.data ?? []).map((e) => e.name).filter((n) => typeof n === 'string' && n)
  if (values.length === 0) continue

  // 匹配 code.json 中的同名属性（VSCode 约定表名 = 属性名）
  const target = codeRaw.data.find((c) => c.code === tableName)
  if (target && COARSE.has(target.type)) {
    target.type = tableName
    updatedCodes++
  }

  // value_type.json：同名 type 已有（保留原 rule，只补 list）；没有则新增
  const existing = vtRaw.data.find((v) => v.type === tableName)
  if (existing) {
    if (!existing.list) existing.list = values.join(',')
    else {
      const have = new Set(existing.list.split(',').map((s) => s.trim()))
      const merged = [...have]
      for (const v of values) if (!have.has(v)) merged.push(v)
      existing.list = merged.join(',')
    }
  } else {
    vtRaw.data.push({
      name: zhText(`data.value.${tableName}.${values[0]}.description`) ?? tableName,
      type: tableName,
      rule: '',
      external: '',
      offset: '',
      list: values.join(','),
      tag: '',
      describe: values.length > 0 ? values.slice(0, 8).join('、') : '',
    })
    addedTypes++
  }
}

// ── 2. 逻辑布尔函数表 → public/data/logicboolean.json ────────────
const lb = read(plugin('data/value/logicboolean.json'))
// 按名去重（大小写不敏感，与 code.json 去重策略一致）
const lbSeen = new Set()
const lbData = []
for (const e of lb.data ?? []) {
  const key = String(e.name ?? '').toLowerCase()
  if (!key || lbSeen.has(key)) continue
  lbSeen.add(key)
  lbData.push({
    name: e.name,
    type: e.type ?? '',
    description: zhText(e.description) ?? e.description,
    example: e.example ?? '',
  })
}

// ── 写出 ────────────────────────────────────────────
writeFileSync(path.join(DATA, 'code.json'), JSON.stringify(codeRaw, null, 2) + '\n')
writeFileSync(path.join(DATA, 'value_type.json'), JSON.stringify(vtRaw, null, 2) + '\n')
writeFileSync(path.join(DATA, 'logicboolean.json'), JSON.stringify({ data: lbData }, null, 2) + '\n')
console.log(`code.json: ${updatedCodes} 个属性 type 改为细粒度枚举`)
console.log(`value_type.json: 新增 ${addedTypes} 个枚举类型（现在共 ${vtRaw.data.length} 个）`)
console.log(`logicboolean.json: ${lbData.length} 条逻辑布尔函数`)
