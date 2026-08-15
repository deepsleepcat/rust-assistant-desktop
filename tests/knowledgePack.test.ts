/**
 * 知识包更新器（M18，P2 任务 2）测试：
 * - 真实 HTTP 数据源（node http server）+ 临时目录
 * - 版本检查（增量变更文件列表）/ 增量更新 / 哈希校验失败自动保留旧版
 * - 回滚 / 文件名白名单 / 版本字符串消毒 / URL 协议校验
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { compareVersions, createKnowledgePack, sanitizeVersion, sha256Hex, validateSourceUrl, type KnowledgeManifest } from '../electron/knowledgePack'

let packDir: string
let builtinDir: string
let sourceDir: string
let server: http.Server
let baseUrl: string

const BUILTIN_CODE = '{"data":[{"code":"builtinOnly","translate":"内置字段","type":"string","section":"core"}]}'
const UPDATED_CODE = '{"data":[{"code":"updatedField","translate":"更新字段","type":"string","section":"core"}]}'

function writeBuiltin(): void {
  fs.mkdirSync(builtinDir, { recursive: true })
  fs.writeFileSync(path.join(builtinDir, 'code.json'), BUILTIN_CODE)
  fs.writeFileSync(path.join(builtinDir, 'section.json'), '{"data":[]}')
}

function writeSource(files: Record<string, string>, version: string): void {
  fs.rmSync(sourceDir, { recursive: true, force: true })
  fs.mkdirSync(sourceDir, { recursive: true })
  const manifest: KnowledgeManifest = { version, files: [] }
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(sourceDir, name), content)
    manifest.files.push({ path: name, sha256: sha256Hex(Buffer.from(content)), size: Buffer.byteLength(content) })
  }
  fs.writeFileSync(path.join(sourceDir, 'manifest.json'), JSON.stringify(manifest))
}

function startServer(): Promise<string> {
  return new Promise((resolve) => {
    server = http.createServer((req, res) => {
      const rel = (req.url ?? '/').replace(/^\/+/, '')
      // 测试服务器只服务 sourceDir 内文件：resolve 后做根目录边界校验（防 ../ 越出）
      const file = path.resolve(sourceDir, rel)
      if (file !== sourceDir && !file.startsWith(sourceDir + path.sep)) {
        res.writeHead(404)
        res.end('not found')
        return
      }
      try {
        const buf = fs.readFileSync(file)
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(buf)
      } catch {
        res.writeHead(404)
        res.end('not found')
      }
    })
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number }
      resolve(`http://127.0.0.1:${addr.port}`)
    })
  })
}

beforeEach(async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'kp-test-'))
  packDir = path.join(base, 'pack')
  builtinDir = path.join(base, 'builtin')
  sourceDir = path.join(base, 'source')
  writeBuiltin()
  writeSource({ 'code.json': UPDATED_CODE }, 'v1')
  baseUrl = await startServer()
})

afterEach(() => {
  server?.close()
  fs.rmSync(packDir, { recursive: true, force: true })
})

describe('validateSourceUrl / sanitizeVersion / compareVersions', () => {
  it('只允许 http/https（file:// 可读本地文件，拒绝）', () => {
    expect(validateSourceUrl('https://example.com/pack')).toBeNull()
    expect(validateSourceUrl('http://example.com')).toBeNull()
    expect(validateSourceUrl('')).toMatch(/未配置/)
    expect(validateSourceUrl('file:///etc/passwd')).toMatch(/http/)
    expect(validateSourceUrl('ftp://x')).toMatch(/http/)
    expect(validateSourceUrl(`https://${'a'.repeat(600)}`)).toMatch(/过长/)
  })

  it('版本字符串消毒：路径字符全部替换，防空目录逃逸', () => {
    expect(sanitizeVersion('../../etc')).toBe('.._.._etc')
    expect(sanitizeVersion('v1.0/../x')).toBe('v1.0_.._x')
    expect(sanitizeVersion('')).toBe('unknown')
    expect(sanitizeVersion('2026-08-15')).toBe('2026-08-15')
  })

  it('版本数值化比较：多位数/补丁版本不按字典序（1.9 < 1.15、p9 < p10）', () => {
    expect(compareVersions('1.9', '1.15')).toBeLessThan(0)
    expect(compareVersions('1.15', '1.9')).toBeGreaterThan(0)
    expect(compareVersions('1.15-p9', '1.15-p10')).toBeLessThan(0)
    expect(compareVersions('v9', 'v10')).toBeLessThan(0)
    expect(compareVersions('1.15-p10', '1.16')).toBeLessThan(0)
    expect(compareVersions('v2', 'v2')).toBe(0)
    expect(compareVersions('1.15-p6', '1.15')).toBeGreaterThan(0)
  })
})

describe('readDataFile（内置回退）', () => {
  it('未更新时读内置包；更新后读更新包', async () => {
    const kp = createKnowledgePack(packDir, builtinDir)
    const before = await kp.readDataFile('code.json')
    expect(before.source).toBe('builtin')
    expect(JSON.parse(before.content).data[0].code).toBe('builtinOnly')

    const r = await kp.update(baseUrl)
    expect(r.ok).toBe(true)
    const after = await kp.readDataFile('code.json')
    expect(after.source).toBe('updated')
    expect(after.version).toBe('v1')
    expect(JSON.parse(after.content).data[0].code).toBe('updatedField')
  })

  it('未知文件名拒绝（白名单）', async () => {
    const kp = createKnowledgePack(packDir, builtinDir)
    await expect(kp.readDataFile('../evil.json')).rejects.toThrow(/未知的数据文件名/)
    await expect(kp.readDataFile('manifest.json')).rejects.toThrow(/未知的数据文件名/)
  })

  it('更新包缺某文件时回退内置包（增量包只覆盖部分文件）', async () => {
    const kp = createKnowledgePack(packDir, builtinDir)
    await kp.update(baseUrl) // source 只有 code.json
    const sec = await kp.readDataFile('section.json')
    expect(sec.source).toBe('builtin')
    expect(sec.content).toContain('data')
  })
})

describe('checkUpdate / update（增量）', () => {
  it('首次检查：全部文件为变更', async () => {
    const kp = createKnowledgePack(packDir, builtinDir)
    const r = await kp.checkUpdate(baseUrl)
    expect(r.hasUpdate).toBe(true)
    expect(r.currentVersion).toBeNull()
    expect(r.changedFiles).toContain('code.json')
  })

  it('更新成功：版本切换 + 再次检查无变更', async () => {
    const kp = createKnowledgePack(packDir, builtinDir)
    const upd = await kp.update(baseUrl)
    expect(upd.ok).toBe(true)
    expect(upd.version).toBe('v1')
    expect(upd.updatedFiles).toBe(1)

    const again = await kp.checkUpdate(baseUrl)
    expect(again.hasUpdate).toBe(false)
    expect(again.currentVersion).toBe('v1')

    const info = await kp.info()
    expect(info.currentVersion).toBe('v1')
    expect(info.availableVersions).toContain('v1')
    expect(info.builtinFileCount).toBe(2)
  })

  it('增量更新：只下载变更文件', async () => {
    const kp = createKnowledgePack(packDir, builtinDir)
    await kp.update(baseUrl)
    // 服务端出新版本：code.json 变更 + 新增 section.json，version 升 v2
    writeSource(
      {
        'code.json': '{"data":[{"code":"v2field","translate":"V2字段","type":"string","section":"core"}]}',
        'section.json': '{"data":[{"code":"core","translate":"核心"}]}',
      },
      'v2',
    )
    const check = await kp.checkUpdate(baseUrl)
    expect(check.hasUpdate).toBe(true)
    expect(check.changedFiles.sort()).toEqual(['code.json', 'section.json'])
    // 只变更 code.json 时：v2 只改 code.json
    writeSource({ 'code.json': '{"data":[{"code":"v2b","translate":"V2B","type":"string","section":"core"}]}' }, 'v2b')
    const check2 = await kp.checkUpdate(baseUrl)
    expect(check2.changedFiles).toEqual(['code.json'])

    const upd = await kp.update(baseUrl)
    expect(upd.ok).toBe(true)
    expect(upd.updatedFiles).toBe(1)
    const after = await kp.readDataFile('code.json')
    expect(after.version).toBe('v2b')
    expect(after.content).toContain('v2b')
  })

  it('全量快照：增量更新后未变更文件仍是更新版（不静默回退内置）', async () => {
    const kp = createKnowledgePack(packDir, builtinDir)
    await kp.update(baseUrl) // v1：只含 code.json（updatedField）
    // v2：section.json 变更（新增），code.json 不变
    writeSource(
      {
        'section.json': '{"data":[{"code":"core","translate":"核心"}]}',
      },
      'v2',
    )
    await kp.update(baseUrl)
    // v2 目录应包含从 v1 复制来的 code.json（全量快照）
    const code = await kp.readDataFile('code.json')
    expect(code.version).toBe('v2')
    expect(code.content).toContain('updatedField')
    expect(code.source).toBe('updated')
    const section = await kp.readDataFile('section.json')
    expect(section.content).toContain('核心')
  })

  it('多位数版本清理/回滚按数值序（v9→v10 不误删当前版本）', async () => {
    const kp = createKnowledgePack(packDir, builtinDir)
    writeSource({ 'code.json': UPDATED_CODE }, 'v9')
    await kp.update(baseUrl)
    writeSource({ 'code.json': '{"data":[{"code":"v10x","translate":"V10","type":"string","section":"core"}]}' }, 'v10')
    await kp.update(baseUrl)
    const info = await kp.info()
    expect(info.currentVersion).toBe('v10')
    expect(info.availableVersions.sort()).toEqual(['v10', 'v9'])
    // 回滚应回到 v9（字典序会选错）
    const rb = await kp.rollback()
    expect(rb.ok).toBe(true)
    expect(rb.version).toBe('v9')
    expect((await kp.readDataFile('code.json')).content).toContain(UPDATED_CODE)
  })

  it('无网络/服务不可用：返回错误，本地包不受影响', async () => {
    const kp = createKnowledgePack(packDir, builtinDir)
    await kp.update(baseUrl)
    server.close()
    const r = await kp.checkUpdate('http://127.0.0.1:1/manifest.json')
    expect(r.hasUpdate).toBe(false)
    expect(r.error).toBeTruthy()
    const still = await kp.readDataFile('code.json')
    expect(still.source).toBe('updated')
  })
})

describe('更新失败自动回滚（旧版不受影响）', () => {
  it('哈希校验失败：中止更新，指针不动，pending 清理', async () => {
    const kp = createKnowledgePack(packDir, builtinDir)
    await kp.update(baseUrl)
    // 服务端 manifest 声明错误哈希（内容与哈希不符，size 正确 → 命中哈希校验）
    const fakeManifest = JSON.stringify({
      version: 'bad',
      files: [{ path: 'code.json', sha256: sha256Hex(Buffer.from('different content')), size: Buffer.byteLength(UPDATED_CODE) }],
    })
    fs.writeFileSync(path.join(sourceDir, 'manifest.json'), fakeManifest)
    const r = await kp.update(baseUrl)
    expect(r.ok).toBe(false)
    expect(r.error).toContain('哈希校验失败')
    // 旧版仍生效
    const info = await kp.info()
    expect(info.currentVersion).toBe('v1')
    const still = await kp.readDataFile('code.json')
    expect(still.version).toBe('v1')
    // pending 目录已清理
    const leftovers = fs.readdirSync(packDir).filter((f) => f.startsWith('.pending'))
    expect(leftovers).toEqual([])
  })

  it('大小不符：中止更新', async () => {
    const kp = createKnowledgePack(packDir, builtinDir)
    const fakeManifest = JSON.stringify({
      version: 'bad',
      files: [{ path: 'code.json', sha256: sha256Hex(Buffer.from(UPDATED_CODE)), size: 99999 }],
    })
    fs.writeFileSync(path.join(sourceDir, 'manifest.json'), fakeManifest)
    const r = await kp.update(baseUrl)
    expect(r.ok).toBe(false)
    expect(r.error).toContain('大小不符')
    expect((await kp.info()).currentVersion).toBeNull()
  })

  it('manifest 非法文件名被忽略（路径穿越白名单）', async () => {
    const kp = createKnowledgePack(packDir, builtinDir)
    const evil = JSON.stringify({
      version: 'evil',
      files: [
        { path: '../outside.txt', sha256: sha256Hex(Buffer.from('x')), size: 1 },
        { path: 'code.json', sha256: sha256Hex(Buffer.from(UPDATED_CODE)), size: Buffer.byteLength(UPDATED_CODE) },
      ],
    })
    fs.writeFileSync(path.join(sourceDir, 'manifest.json'), evil)
    const check = await kp.checkUpdate(baseUrl)
    expect(check.changedFiles).toEqual(['code.json']) // 白名单外忽略
    const r = await kp.update(baseUrl)
    expect(r.ok).toBe(true)
    expect(r.updatedFiles).toBe(1)
    expect(fs.existsSync(path.join(packDir, '..', 'outside.txt'))).toBe(false)
  })

  it('manifest 版本字符串消毒：不会逃逸出知识包目录', async () => {
    const kp = createKnowledgePack(packDir, builtinDir)
    const evil = JSON.stringify({
      version: '../../escape',
      files: [{ path: 'code.json', sha256: sha256Hex(Buffer.from(UPDATED_CODE)), size: Buffer.byteLength(UPDATED_CODE) }],
    })
    fs.writeFileSync(path.join(sourceDir, 'manifest.json'), evil)
    const r = await kp.update(baseUrl)
    expect(r.ok).toBe(true)
    const info = await kp.info()
    expect(info.currentVersion).toBe('../../escape')
    // 目录在 packDir 内（消毒后 . 保留、/ 变 _ → v.._.._escape）
    expect(fs.existsSync(path.join(packDir, 'v.._.._escape', 'code.json'))).toBe(true)
    expect(fs.existsSync(path.join(packDir, '..', 'escape'))).toBe(false)
  })
})

describe('rollback（回滚到上一版本）', () => {
  it('两次更新后可回滚到上一版', async () => {
    const kp = createKnowledgePack(packDir, builtinDir)
    await kp.update(baseUrl) // v1
    writeSource({ 'code.json': '{"data":[{"code":"v2x","translate":"V2X","type":"string","section":"core"}]}' }, 'v2')
    await kp.update(baseUrl) // v2
    const info = await kp.info()
    expect(info.currentVersion).toBe('v2')
    expect(info.availableVersions).toContain('v1')

    const rb = await kp.rollback()
    expect(rb.ok).toBe(true)
    expect(rb.version).toBe('v1')
    const after = await kp.readDataFile('code.json')
    expect(after.version).toBe('v1')
    expect(after.content).toContain('updatedField')
  })

  it('从未更新时无法回滚', async () => {
    const kp = createKnowledgePack(packDir, builtinDir)
    const rb = await kp.rollback()
    expect(rb.ok).toBe(false)
    expect(rb.error).toMatch(/没有可回滚/)
  })
})
