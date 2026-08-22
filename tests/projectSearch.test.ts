import { afterEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { searchProjectFiles } from '../electron/projectSearch'
import { createMockBridge, MOCK_PROJECT_ROOT } from '../src/services/mockBridge'

const dirs: string[] = []
function tmp(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'rust-search-'))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** 测试夹具仅允许在临时项目根内创建文件，避免测试自身构造越界写入。 */
function file(root: string, relativePath: string, content = ''): void {
  const target = path.resolve(root, relativePath)
  if (!target.startsWith(root + path.sep)) throw new Error(`测试夹具路径越界：${relativePath}`)
  mkdirSync(path.dirname(target), { recursive: true })
  writeFileSync(target, content, 'utf8')
}

describe('M37 searchProjectFiles（受限全项目文件搜索）', () => {
  it('递归命中文件名/相对路径，大小写与斜杠不敏感', async () => {
    const root = tmp()
    file(root, 'units/tank/HeavyTank.ini')
    file(root, 'maps/深渊/space_map.tmx')
    file(root, 'README.md')

    const byName = await searchProjectFiles(root, 'heavytank', false)
    expect(byName.entries.map((entry) => entry.relativePath)).toEqual(['units/tank/HeavyTank.ini'])

    const byPath = await searchProjectFiles(root, 'UNITS\\TANK', false)
    expect(byPath.entries.map((entry) => entry.name)).toEqual(['HeavyTank.ini'])

    const zh = await searchProjectFiles(root, '深渊', false)
    expect(zh.entries[0]).toMatchObject({ name: 'space_map.tmx', relativePath: 'maps/深渊/space_map.tmx' })
    expect(path.isAbsolute(zh.entries[0].path)).toBe(true)
  })

  it('隐藏文件默认跳过，开启后可命中', async () => {
    const root = tmp()
    file(root, '.private/secret.ini')
    file(root, 'visible.ini')

    expect((await searchProjectFiles(root, 'secret', false)).entries).toEqual([])
    expect((await searchProjectFiles(root, 'secret', true)).entries.map((entry) => entry.relativePath)).toEqual(['.private/secret.ini'])
  })

  it('空关键词不扫描、不返回全部文件', async () => {
    const root = tmp()
    file(root, 'units/a.ini')
    const result = await searchProjectFiles(root, '   ', false)
    expect(result).toEqual({ entries: [], truncated: false })
  })

  it('符号链接不跟随，不能借搜索枚举根外文件名', async () => {
    const root = tmp()
    const outside = tmp()
    file(outside, 'outside-secret.ini')
    try {
      symlinkSync(outside, path.join(root, 'linked-outside'), 'junction')
    } catch {
      // Windows 未开开发者模式/权限不足时无法建链接；其它搜索边界仍由主进程覆盖。
      return
    }

    expect((await searchProjectFiles(root, 'outside-secret', true)).entries).toEqual([])
  })

  it('mock bridge 与桌面桥接一样支持未展开目录搜索', async () => {
    const bridge = createMockBridge()
    const result = await bridge.project.searchFiles(MOCK_PROJECT_ROOT, 'tank.ini', false)
    expect(result.entries.map((entry) => entry.relativePath)).toContain('units/tank/tank.ini')
    expect(result.truncated).toBe(false)
  })
})
