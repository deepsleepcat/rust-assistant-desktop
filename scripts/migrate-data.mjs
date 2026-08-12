/**
 * M3 数据迁移脚本（一次性）：
 * 1. 解压手机版 dataBase_v2.2.0.rdb 的 tables/*.json → public/data/
 * 2. 合并旧版 Python 工具的词库 → public/data/vocabulary.json、translations.json
 *
 * 运行：node scripts/migrate-data.mjs
 * 产物提交进仓库，保证应用离线可用。原始数据文件不会被修改。
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const rdbPath = 'W:\\mao\\tx\\rust-assistant-1.0.1\\app\\src\\main\\assets\\dataBase_v2.2.0.rdb'
const legacyDir = 'W:\\mao\\tx\\tx\\tx'
const outDir = path.join(root, 'public', 'data')

if (!existsSync(rdbPath)) {
  console.error(`找不到手机版数据库：${rdbPath}`)
  process.exit(1)
}

mkdirSync(outDir, { recursive: true })

/* ---------- 1. 解压 rdb 的 tables/*.json ---------- */
const tmp = fs_mktemp()
try {
  execFileSync('unzip', ['-o', '-q', rdbPath, '-d', tmp], { stdio: 'ignore' })
} catch {
  // Windows 上 unzip 不可用时尝试 tar（Win10+ 自带 bsdtar，支持 zip）
  try {
    execFileSync('tar', ['-xf', rdbPath, '-C', tmp], { stdio: 'ignore' })
  } catch {
    console.error('解压 rdb 失败：需要 unzip 或 tar 支持')
    process.exit(1)
  }
}
const tablesDir = path.join(tmp, 'tables')
for (const file of ['code.json', 'section.json', 'value_type.json', 'chain_inspection.json', 'game_version.json']) {
  const src = path.join(tablesDir, file)
  if (!existsSync(src)) {
    console.warn(`跳过缺失表：${file}`)
    continue
  }
  writeFileSync(path.join(outDir, file), readFileSync(src))
  console.log(`✓ tables/${file} -> public/data/${file}`)
}

/* ---------- 2. 合并旧版词库 ---------- */
function readJson(p) {
  return JSON.parse(readFileSync(p, 'utf8'))
}

// 翻译词典：translations_filtered.json {words:[{en,zh}]}
const translationsPath = path.join(legacyDir, 'translations_filtered.json')
const translations = existsSync(translationsPath) ? readJson(translationsPath) : { words: [] }
writeFileSync(path.join(outDir, 'translations.json'), JSON.stringify(translations))
console.log(`✓ translations_filtered.json (${translations.words?.length ?? 0} 条) -> public/data/translations.json`)

// 补全词库：bilingual_code_vocabulary.json + 1.json + 2.json（兼容 {words:[...]} 与直接数组）
const vocabularySources = ['bilingual_code_vocabulary.json', '1.json', '2.json']
const seen = new Set()
const words = []
for (const name of vocabularySources) {
  const p = path.join(legacyDir, name)
  if (!existsSync(p)) continue
  const raw = readJson(p)
  const list = Array.isArray(raw) ? raw : raw.words ?? []
  for (const item of list) {
    const word = item?.word
    if (!word || seen.has(word)) continue
    seen.add(word)
    words.push({ word, explanation: item?.explanation ?? '' })
  }
  console.log(`✓ ${name} (+${list.length} 条，合并后共 ${words.length} 条)`)
}
writeFileSync(path.join(outDir, 'vocabulary.json'), JSON.stringify({ words }))
console.log(`→ public/data/vocabulary.json (${words.length} 条)`)

function fs_mktemp() {
  const p = path.join(os.tmpdir(), `ra-migrate-${Date.now()}`)
  mkdirSync(p, { recursive: true })
  return p
}

console.log('\n迁移完成。')
