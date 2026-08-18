#!/usr/bin/env node
/**
 * Read-only structural auditor for Rusted Warfare directory mods and rwmod ZIPs.
 * It deliberately reports evidence rather than editing, extracting, or executing
 * archive content. A clean report is not a replacement for loading the target
 * game build.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import JSZip from 'jszip'
import { fileURLToPath } from 'node:url'

const TEXT_EXTENSIONS = new Set(['.ini', '.template', '.txt', '.properties', '.tmx', '.tsx'])
const CONFIG_EXTENSIONS = new Set(['.ini', '.template'])
const MAX_TEXT_BYTES = 2 * 1024 * 1024
const RELEASE_DEBRIS = [
  /^__MACOSX(?:\/|$)/i,
  /(?:^|\/)\.git(?:\/|$)/i,
  /(?:^|\/)\.svn(?:\/|$)/i,
  /(?:^|\/)\.hg(?:\/|$)/i,
  /(?:^|\/)node_modules(?:\/|$)/i,
  /(?:^|\/)(?:Thumbs\.db|\.DS_Store|desktop\.ini)$/i,
  /\.bak$/i,
  /(?:^|\/)dist(?:\/|$)/i,
  /(?:^|\/)out(?:\/|$)/i,
]
const ASSET_KEYS = new Set([
  'image', 'image_wreak', 'image_shadow', 'image_turret', 'image_back', 'image_front',
  'image_leg', 'image_end', 'image_middle', 'image_start', 'thumbnail',
])
const FILE_REFERENCE_KEYS = new Set(['copyfrom', 'overrideResourceLoadPath'.toLowerCase()])

function toPosix(value) {
  return String(value).replace(/\\/g, '/').replace(/^\.\//, '')
}

function normalizedSegments(value) {
  return toPosix(value).split('/').filter(Boolean)
}

function isUnsafeArchivePath(value) {
  const normalized = toPosix(value)
  return normalized.startsWith('/') || /^[a-z]:\//i.test(normalized) || normalizedSegments(normalized).includes('..')
}

function issue(level, code, message, file = undefined, detail = undefined) {
  return { level, code, message, ...(file ? { file } : {}), ...(detail === undefined ? {} : { detail }) }
}

function makeResult(input) {
  return {
    schemaVersion: 1,
    input,
    kind: 'unknown',
    packageRoot: '',
    stats: { files: 0, directories: 0, configs: 0, assets: 0, bytes: 0 },
    manifest: { found: false, path: null, title: null, minVersion: null, thumbnail: null },
    issues: [],
  }
}

function push(result, level, code, message, file, detail) {
  result.issues.push(issue(level, code, message, file, detail))
}

function parseIni(text) {
  const sections = new Map()
  const duplicateSections = []
  let current = null
  let multiline = null
  const lines = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').split('\n')
  for (let index = 0; index < lines.length; index++) {
    const raw = lines[index]
    if (multiline) {
      const close = raw.indexOf('"""')
      if (close === -1) {
        multiline.value.push(raw)
        continue
      }
      multiline.value.push(raw.slice(0, close))
      multiline.section.set(multiline.key, multiline.value.join('\n'))
      multiline = null
      continue
    }
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const sectionMatch = line.match(/^\[([^\]]+)\]$/)
    if (sectionMatch) {
      const name = sectionMatch[1].trim()
      if (sections.has(name)) duplicateSections.push(name)
      else sections.set(name, new Map())
      current = sections.get(name)
      continue
    }
    if (!current) continue
    const match = raw.match(/^\s*([^=:]*?)(?:=|:)(.*)$/)
    if (!match) continue
    const key = match[1].trim()
    let value = match[2].trim()
    if (!key) continue
    if (value.startsWith('"""')) {
      value = value.slice(3)
      const close = value.indexOf('"""')
      if (close !== -1) current.set(key, value.slice(0, close))
      else multiline = { section: current, key, value: [value] }
      continue
    }
    const comment = value.search(/\s+#/)
    if (comment !== -1) value = value.slice(0, comment).trim()
    current.set(key, value)
  }
  return { sections, duplicateSections, unterminatedMultiline: Boolean(multiline) }
}

function getSection(parsed, expected) {
  for (const [name, values] of parsed.sections) {
    if (name.toLowerCase() === expected.toLowerCase()) return values
  }
  return null
}

function getValue(section, expected) {
  if (!section) return undefined
  for (const [key, value] of section) {
    if (key.toLowerCase() === expected.toLowerCase()) return value
  }
  return undefined
}

function resourceReference(value, file, packageRoot = '') {
  const raw = String(value).trim()
  if (!raw || raw.toUpperCase() === 'NONE' || raw.toUpperCase() === 'AUTO' || raw.startsWith('SHARED:') || raw.startsWith('CORE:')) return null
  if (raw.startsWith('ROOT:')) return normalizeInsideRoot(`${packageRoot}${raw.slice(5)}`)
  if (raw.startsWith('SHADOW:')) return resourceReference(raw.slice(7), file, packageRoot)
  const base = path.posix.dirname(file)
  return normalizeInsideRoot(path.posix.join(base === '.' ? '' : base, raw))
}

function normalizeInsideRoot(value) {
  const parts = []
  for (const part of normalizedSegments(value)) {
    if (part === '..') return null
    if (part !== '.') parts.push(part)
  }
  return parts.join('/')
}

function isLikelyAsset(name) {
  return /\.(?:png|jpg|jpeg|webp|gif|ogg|wav|tmx|tsx)$/i.test(name)
}

function isConfig(name) {
  return CONFIG_EXTENSIONS.has(path.posix.extname(name).toLowerCase())
}

function topLevelRoots(fileNames) {
  const roots = new Set()
  for (const name of fileNames) {
    const parts = normalizedSegments(name)
    if (parts.length) roots.add(parts[0])
  }
  return roots
}

function detectPackageRoot(fileNames) {
  const direct = fileNames.find((name) => name.toLowerCase() === 'mod-info.txt')
  if (direct) return ''
  const candidates = new Set()
  for (const name of fileNames) {
    const parts = normalizedSegments(name)
    if (parts.length === 2 && parts[1].toLowerCase() === 'mod-info.txt') candidates.add(parts[0])
  }
  if (candidates.size === 1) return `${[...candidates][0]}/`
  return null
}

function relativeToPackage(fileName, packageRoot) {
  if (!packageRoot) return fileName
  return fileName.startsWith(packageRoot) ? fileName.slice(packageRoot.length) : null
}

function inspectManifest(result, files) {
  const manifestPath = `${result.packageRoot}mod-info.txt`
  const manifest = files.get(manifestPath)
  if (!manifest) {
    push(result, 'error', 'manifest-missing', '未在有效包根找到 mod-info.txt。游戏不会把文件名当作发布元数据。')
    return
  }
  result.manifest.found = true
  result.manifest.path = manifestPath
  const parsed = parseIni(manifest.text ?? '')
  if (parsed.unterminatedMultiline) push(result, 'error', 'manifest-multiline', 'mod-info.txt 存在未关闭的三引号多行值。', manifestPath)
  const mod = getSection(parsed, 'mod')
  if (!mod) {
    push(result, 'error', 'manifest-section', 'mod-info.txt 缺少 [mod] 节。', manifestPath)
    return
  }
  const title = getValue(mod, 'title')
  const legacyName = getValue(mod, 'name')
  const minVersion = getValue(mod, 'minVersion')
  const thumbnail = getValue(mod, 'thumbnail')
  result.manifest.title = title ?? null
  result.manifest.minVersion = minVersion ?? null
  result.manifest.thumbnail = thumbnail ?? null
  if (!title?.trim()) {
    push(result, 'error', 'manifest-title', '[mod]title 是实际显示标题，不能为空。不要使用 [mod]name 代替。', manifestPath)
  }
  if (legacyName && !title) {
    push(result, 'warning', 'legacy-name', '检测到 [mod]name 但没有 [mod]title；已检查的加载器使用 title。', manifestPath)
  }
  if (!minVersion?.trim()) push(result, 'warning', 'manifest-min-version', '未声明 minVersion；无法在发布前审查最低兼容版本。', manifestPath)
  if (thumbnail) {
    const target = resourceReference(thumbnail, manifestPath, result.packageRoot)
    if (target && !files.has(target)) push(result, 'warning', 'thumbnail-missing', 'thumbnail 指向的本地文件不存在。', manifestPath, thumbnail)
    if (target === null) push(result, 'warning', 'thumbnail-path', 'thumbnail 包含不能安全解析的相对路径。', manifestPath, thumbnail)
  }
}

function inspectConfigs(result, files) {
  const unitNames = new Map()
  const refCandidates = []
  for (const [fileName, file] of files) {
    if (!isConfig(fileName)) continue
    result.stats.configs++
    if (file.size > MAX_TEXT_BYTES) {
      push(result, 'warning', 'config-too-large', '配置文件超过静态文本检查上限，已跳过内容解析。', fileName, file.size)
      continue
    }
    const parsed = parseIni(file.text ?? '')
    if (parsed.unterminatedMultiline) push(result, 'error', 'ini-multiline', '存在未关闭的三引号多行值。', fileName)
    for (const sectionName of parsed.duplicateSections) {
      push(result, 'warning', 'duplicate-section', '检测到重复节名；最终行为依赖加载顺序，应该合并或重命名。', fileName, sectionName)
    }
    for (const [, values] of parsed.sections) {
      for (const [key, value] of values) {
        const keyId = key.toLowerCase()
        if (ASSET_KEYS.has(keyId)) refCandidates.push({ fileName, key, value, kind: 'asset' })
        if (FILE_REFERENCE_KEYS.has(keyId)) refCandidates.push({ fileName, key, value, kind: 'file' })
      }
    }
    const core = getSection(parsed, 'core')
    const name = getValue(core, 'name')?.trim()
    if (name) {
      if (unitNames.has(name)) push(result, 'error', 'duplicate-unit-name', '多个配置使用同一 [core]name，运行时标识必须全局唯一。', fileName, { name, first: unitNames.get(name) })
      else unitNames.set(name, fileName)
    }
  }
  for (const reference of refCandidates) {
    if (reference.kind === 'file' && reference.key.toLowerCase() === 'copyfrom') {
      for (const item of String(reference.value).split(',')) {
        const rawTarget = item.trim()
        const target = resourceReference(rawTarget, reference.fileName, result.packageRoot)
        if (normalizedSegments(rawTarget).includes('..') || target === null) push(result, 'error', 'copyfrom-path', 'copyFrom 不能包含越出包根的路径或 ..。', reference.fileName, rawTarget)
        else if (target && !files.has(target)) push(result, 'warning', 'copyfrom-missing', 'copyFrom 的本地目标未在包中找到；CORE: 目标不由静态包检查判断。', reference.fileName, item.trim())
      }
      continue
    }
    if (reference.kind === 'asset') {
      const target = resourceReference(reference.value, reference.fileName, result.packageRoot)
      if (target === null) push(result, 'warning', 'asset-path', '资源路径含有不能安全解析的上级目录。', reference.fileName, reference.value)
      else if (target && !files.has(target)) push(result, 'warning', 'asset-missing', '本地资源引用未在包中找到；字段是否允许内置前缀需要游戏验证。', reference.fileName, { key: reference.key, value: reference.value })
    }
  }
}

function inspectNames(result, files, packageRoot) {
  const folded = new Map()
  for (const [name, file] of files) {
    if (!name) continue
    const relative = relativeToPackage(name, packageRoot)
    if (relative === null) continue
    const lower = relative.toLocaleLowerCase('en-US')
    const existing = folded.get(lower)
    if (existing && existing !== name) push(result, 'warning', 'case-collision', '包内存在只靠大小写区分的路径；跨平台或引用解析可能不稳定。', name, existing)
    else folded.set(lower, name)
    for (const pattern of RELEASE_DEBRIS) {
      if (pattern.test(relative)) {
        push(result, 'warning', 'release-debris', '发布包包含常见缓存、备份或系统杂物。', name)
        break
      }
    }
    if (isLikelyAsset(relative)) result.stats.assets++
    result.stats.bytes += file.size
  }
}

async function readDirectory(input, result) {
  result.kind = 'directory'
  const files = new Map()
  async function walk(abs, rel) {
    const entries = await fs.readdir(abs, { withFileTypes: true })
    for (const entry of entries) {
      const nextRel = rel ? `${rel}/${entry.name}` : entry.name
      const nextAbs = path.join(abs, entry.name)
      if (entry.isSymbolicLink()) {
        push(result, 'warning', 'symbolic-link', '静态审计不跟随符号链接；发布包应改用真实文件。', nextRel)
        continue
      }
      if (entry.isDirectory()) {
        result.stats.directories++
        await walk(nextAbs, nextRel)
        continue
      }
      if (!entry.isFile()) continue
      const stat = await fs.stat(nextAbs)
      const normalized = toPosix(nextRel)
      const ext = path.posix.extname(normalized).toLowerCase()
      const content = TEXT_EXTENSIONS.has(ext) && stat.size <= MAX_TEXT_BYTES
        ? await fs.readFile(nextAbs, 'utf8').catch(() => null)
        : null
      files.set(normalized, { size: stat.size, text: content })
      result.stats.files++
    }
  }
  await walk(input, '')
  const root = detectPackageRoot([...files.keys()])
  if (root === null) {
    push(result, 'error', 'package-root', '无法确定唯一包含 mod-info.txt 的包根。')
    result.packageRoot = ''
  } else result.packageRoot = root
  inspectNames(result, files, result.packageRoot)
  inspectManifest(result, files)
  inspectConfigs(result, files)
}

async function readArchive(input, result) {
  result.kind = 'rwmod'
  const buffer = await fs.readFile(input)
  const zip = await JSZip.loadAsync(buffer, { createFolders: false, checkCRC32: false })
  const files = new Map()
  for (const [rawName, entry] of Object.entries(zip.files)) {
    const originalName = entry.unsafeOriginalName ?? rawName
    const name = toPosix(rawName)
    if (entry.dir) {
      result.stats.directories++
      continue
    }
    if (isUnsafeArchivePath(originalName)) {
      push(result, 'error', 'archive-path-traversal', '压缩包条目使用绝对路径或 ..，不得作为发布包加载。', originalName)
      continue
    }
    const ext = path.posix.extname(name).toLowerCase()
    let text = null
    if (TEXT_EXTENSIONS.has(ext) && entry._data?.uncompressedSize <= MAX_TEXT_BYTES) {
      text = await entry.async('string').catch(() => null)
    }
    const size = Number(entry._data?.uncompressedSize ?? 0)
    files.set(name, { size, text })
    result.stats.files++
  }
  const roots = topLevelRoots([...files.keys()])
  const root = detectPackageRoot([...files.keys()])
  if (root === null) {
    push(result, 'error', 'package-root', '无法确定唯一包含 mod-info.txt 的包根。')
    result.packageRoot = ''
  } else {
    result.packageRoot = root
    if (root && roots.size > 1) push(result, 'warning', 'archive-mixed-root', 'rwmod 使用包装目录但同时含有包根外文件；发布结构可能含歧义。')
  }
  inspectNames(result, files, result.packageRoot)
  inspectManifest(result, files)
  inspectConfigs(result, files)
}

export async function auditRwmod(input) {
  const absolute = path.resolve(input)
  const result = makeResult(absolute)
  let stat
  try {
    stat = await fs.stat(absolute)
  } catch (error) {
    push(result, 'error', 'input-missing', '无法读取输入路径。', undefined, error instanceof Error ? error.message : String(error))
    return finalize(result)
  }
  try {
    if (stat.isDirectory()) await readDirectory(absolute, result)
    else if (stat.isFile() && /\.rwmod$/i.test(absolute)) await readArchive(absolute, result)
    else push(result, 'error', 'input-kind', '输入必须是模组目录或 .rwmod ZIP 文件。')
  } catch (error) {
    push(result, 'error', 'read-failed', '读取模组结构失败。', undefined, error instanceof Error ? error.message : String(error))
  }
  return finalize(result)
}

function finalize(result) {
  const counts = { error: 0, warning: 0, info: 0 }
  for (const item of result.issues) counts[item.level]++
  result.summary = {
    ...counts,
    ok: counts.error === 0,
    staticOnly: true,
    note: '该结果是只读静态检查，不能替代指定游戏版本中的重新加载和实机测试。',
  }
  return result
}

function printText(result) {
  console.log(`输入: ${result.input}`)
  console.log(`类型: ${result.kind}${result.packageRoot ? ` | 包根: ${result.packageRoot}` : ''}`)
  console.log(`文件: ${result.stats.files} | 配置: ${result.stats.configs} | 资源: ${result.stats.assets} | 大小: ${result.stats.bytes} bytes`)
  console.log(`manifest: ${result.manifest.found ? result.manifest.path : '缺失'}${result.manifest.title ? ` | title: ${result.manifest.title}` : ''}${result.manifest.minVersion ? ` | minVersion: ${result.manifest.minVersion}` : ''}`)
  if (!result.issues.length) console.log('未发现此审计器覆盖范围内的问题。仍需在目标游戏版本中验证。')
  for (const item of result.issues) {
    console.log(`[${item.level.toUpperCase()}] ${item.code}${item.file ? ` ${item.file}` : ''}: ${item.message}${item.detail === undefined ? '' : ` (${typeof item.detail === 'string' ? item.detail : JSON.stringify(item.detail)})`}`)
  }
  console.log(`汇总: ${result.summary.error} error, ${result.summary.warning} warning, ${result.summary.info} info; 静态检查${result.summary.ok ? '通过' : '发现错误'}。`)
}

async function main() {
  const args = process.argv.slice(2)
  const json = args.includes('--json')
  const target = args.find((arg) => arg !== '--json')
  if (!target) {
    console.error('用法: node audit-rwmod.mjs <模组目录或.rwmod> [--json]')
    process.exitCode = 2
    return
  }
  const result = await auditRwmod(target)
  if (json) console.log(JSON.stringify(result, null, 2))
  else printText(result)
  process.exitCode = result.summary.error ? 1 : 0
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : ''
if (invokedPath === fileURLToPath(import.meta.url)) await main()
