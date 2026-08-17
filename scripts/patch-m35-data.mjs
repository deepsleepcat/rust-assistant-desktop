/**
 * M35 数据补全脚本（D3 版本元数据 + D4 弃用标记）：
 * 对照官方 RustedWarfareModSupport 的 sections/*.json（962 字段，带 version/isOutdated），
 * 修正 public/data/code.json（1256 条）：
 * - 127 条缺 addVersion：官方匹配到 → 按映射补；未匹配 → 0（全版本存在）
 * - 109 条缺 removeVersion → -1（未移除）
 * - 19 个官方 isOutdated 字段（turretSize/turretTurnSpeed/animation_TYPE_*、
 *   action_#_*、canBuild_#_*）→ removeVersion = 9（1.15-p10 终版已废弃）
 * - 清洗字符串脏值 "4" → 4
 * 只补缺失、不重写已有 addVersion（现有值视为 M34 已确认，decal 等字段官方标注
 * 1.15p9 而现有标 1-4 的差异属于全量数据审计课题，不在本脚本范围）。
 * 幂等：重复运行不产生新变更。
 *
 * 用法：node scripts/patch-m35-data.mjs [官方数据目录]
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const CODE_JSON = path.resolve(__dirname, '..', 'public', 'data', 'code.json')
const OFFICIAL_DIR = process.argv[2] ?? 'W:/mao/tx/RustedWarfareModSupport-rustedwarfare-1.15/data/sections'

/** 官方 version 字符串 → 我们的 versionNumber（game_version.json：1.12=1 … 1.15-p10=9） */
const VERSION_MAP = new Map([
  ['default', 0],
  ['1.0', 1],
  ['1.13', 2],
  ['1.13.3', 2],
  ['1.14', 3],
  ['1.14p6', 3],
  ['1.14?', 3],
  ['1.15', 4],
  ['1.13.3 - 1.15p9', 2], // 区间写法：取引入版本
  ['1.15p9', 8],
  // 1.15p11 超出我们版本表（最新 1.15-p10=9）：按最新标（该版本引入的字段对
  // 任何已知目标版本都算"过新"，比"全版本存在"（0）语义准确）
  ['1.15p11', 9],
])

/** 官方 isOutdated 字段（全小写存储：与条目 code.toLowerCase() 匹配）。
 * 排除说明：speed 是多节通用键（animation,projectile,comment），标废弃会误伤
 * movement/attack 等节的现行 speed；start/end/scale_start/scale_end 在 code.json
 * 中 section=Specific（动画专用），语义与官方 animation.json 废弃键一致，标废弃。 */
const OUTDATED_CODES = new Set([
  'turretsize',
  'turretturnspeed',
  'animation_type_start',
  'animation_type_end',
  'animation_type_scale_start',
  'animation_type_scale_end',
  'animation_type_speed',
  'animation_type_pingpong',
  'start',
  'end',
  'scale_start',
  'scale_end',
  'action_#_convertto',
  'action_#_pos',
  'action_#_price',
  'action_#_text',
  'action_#_description',
  'action_#_addenergy',
  'action_#_whenbuilding_cannotmove',
  'canbuild_#_name/pos/islocked',
  'canbuild_#_name',
  'canbuild_#_pos',
  'canbuild_#_islocked',
])

/** 输出标准化 JSON：LF、2 空格缩进、无尾换行（与知识包同步格式一致） */
function writeJson(file, obj) {
  fs.writeFileSync(file, `${JSON.stringify(obj, null, 2)}\n`.replace(/\n$/, ''), 'utf8')
}

function main() {
  const code = JSON.parse(fs.readFileSync(CODE_JSON, 'utf8'))
  const entries = code.data
  if (!Array.isArray(entries)) throw new Error('code.json 结构异常：缺少 data 数组')

  // 读官方 sections（17 个文件，962 字段）
  const official = new Map() // name 小写 → { version, isOutdated }
  const files = fs.readdirSync(OFFICIAL_DIR).filter((f) => f.endsWith('.json'))
  for (const f of files) {
    const parsed = JSON.parse(fs.readFileSync(path.join(OFFICIAL_DIR, f), 'utf8'))
    for (const field of parsed.data ?? []) {
      if (typeof field.name !== 'string') continue
      const key = field.name.toLowerCase()
      // 通配键（action_#_pos）与具体键（action_1_pos）分开存，避免 # 覆盖具体名
      if (!official.has(key) || official.get(key).isOutdated) {
        official.set(key, { version: field.version, isOutdated: field.isOutdated === true })
      }
    }
  }

  const colOrder = ['code', 'translate', 'description', 'type', 'addVersion', 'removeVersion', 'section', 'demo']
  const stats = { addFilled: 0, addDefault: 0, removeFilled: 0, outdated: 0, dirtyFixed: 0, unmatchedOfficial: [] }
  const removedVersion = 9

  const rebuilt = entries.map((entry) => {
    const out = {}
    for (const key of colOrder) {
      if (key in entry) out[key] = entry[key]
    }
    // 清洗字符串脏值（"4" → 4）
    if (typeof out.addVersion === 'string' && /^\d+$/.test(out.addVersion)) {
      out.addVersion = Number(out.addVersion)
      stats.dirtyFixed++
    }
    const officialHit = official.get(String(out.code).toLowerCase())
    // D3：补 addVersion（只补缺失；已标 0 但官方有非 0 引入版本的修正——
    // 1.15p11 等超出版本表的字段曾被 0 吞掉"过新"提示，首轮修正后幂等）
    const officialVersion = officialHit && VERSION_MAP.has(String(officialHit.version)) ? VERSION_MAP.get(String(officialHit.version)) : undefined
    if (typeof out.addVersion !== 'number') {
      out.addVersion = officialVersion ?? 0
      if (officialVersion === undefined) stats.addDefault++
      else stats.addFilled++
    } else if (out.addVersion === 0 && officialVersion !== undefined && officialVersion !== 0) {
      out.addVersion = officialVersion
      stats.addFilled++
    }
    // D4：补 removeVersion（缺失 → -1；官方废弃 → 9）
    if (typeof out.removeVersion !== 'number') {
      out.removeVersion = -1
      stats.removeFilled++
    }
    if (OUTDATED_CODES.has(String(out.code).toLowerCase()) && out.removeVersion < 0) {
      out.removeVersion = removedVersion
      stats.outdated++
    }
    return out
  })

  // 报告：官方字段里我们完全没有的（防对账遗漏）
  for (const [name, info] of official) {
    if (!rebuilt.some((e) => String(e.code).toLowerCase() === name)) {
      stats.unmatchedOfficial.push(`${name}(${info.version})`)
    }
  }

  code.data = rebuilt
  writeJson(CODE_JSON, code)

  console.log(`已处理 ${entries.length} 条 → ${rebuilt.length} 条`)
  console.log(`D3 补 addVersion（官方映射）: ${stats.addFilled} 条；补 addVersion=0（全版本）: ${stats.addDefault} 条`)
  console.log(`D3 补 removeVersion=-1: ${stats.removeFilled} 条；清洗脏值: ${stats.dirtyFixed} 条`)
  console.log(`D4 标记废弃（removeVersion=${removedVersion}）: ${stats.outdated} 条`)
  console.log(`官方字段未出现在 code.json: ${stats.unmatchedOfficial.length} 个`)
  if (stats.unmatchedOfficial.length > 0 && stats.unmatchedOfficial.length <= 20) {
    for (const u of stats.unmatchedOfficial) console.log('  -', u)
  }
}

main()
