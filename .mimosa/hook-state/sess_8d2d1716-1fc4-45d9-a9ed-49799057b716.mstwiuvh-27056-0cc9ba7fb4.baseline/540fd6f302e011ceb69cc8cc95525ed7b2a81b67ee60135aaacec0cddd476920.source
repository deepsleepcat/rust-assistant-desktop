/**
 * 主进程路径安全测试：链接逃逸校验（junction/符号链接）与真实路径缓存。
 * Windows 下用 mklink /J 创建真实 junction 验证；非 Windows 跳过。
 */
import { describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { assertNoLinkEscape, invalidateRealRoot, isPathInside, normalizePath, realRootOf } from '../electron/paths'

const isWin = process.platform === 'win32'

function makeTempDir(): string {
  return mkdtempSync(path.join(tmpdir(), 'rust-paths-'))
}

/** 创建 junction（Windows）；非 Windows 环境用符号链接代替（可能失败则跳过） */
function makeLink(target: string, link: string): boolean {
  try {
    if (isWin) {
      execFileSync('cmd', ['/c', 'mklink', '/J', link, target], { stdio: 'pipe' })
    } else {
      execFileSync('ln', ['-s', target, link], { stdio: 'pipe' })
    }
    return existsSync(link)
  } catch {
    return false
  }
}

describe('electron/paths 链接逃逸校验', () => {
  it('isPathInside/normalizePath 基础行为', () => {
    expect(isPathInside('C:\\mod', 'C:\\mod\\units\\a.ini')).toBe(true)
    expect(isPathInside('C:\\mod', 'C:\\mod2\\a.ini')).toBe(false)
    if (isWin) {
      expect(normalizePath('C:\\Mod\\A') === normalizePath('c:\\mod\\a')).toBe(true)
    } else {
      expect(normalizePath('/Mod/A') === normalizePath('/mod/a')).toBe(false)
    }
  })

  it('根内链接指向根外 → 拒绝；根内正常路径 → 放行', async () => {
    const root = makeTempDir()
    const outside = makeTempDir()
    try {
      const link = path.join(root, 'units')
      // 链接创建失败（受限环境）视为测试环境不支持，明确失败而非静默通过
      if (!makeLink(outside, link)) throw new Error('当前环境无法创建符号链接/junction，链接校验用例无法执行')
      writeFileSync(path.join(outside, 'secret.txt'), 'x', 'utf8')
      // 指向根外的链接：拒绝
      await expect(assertNoLinkEscape(root, path.join(link, 'secret.txt'))).rejects.toThrow('链接')
      // 根内正常路径：放行
      mkdirSync(path.join(root, 'normal'), { recursive: true })
      await expect(assertNoLinkEscape(root, path.join(root, 'normal', 'a.txt'))).resolves.toBeUndefined()
    } finally {
      rmSync(root, { recursive: true, force: true })
      rmSync(outside, { recursive: true, force: true })
    }
  })

  it('项目根本身是链接时以真实根为基准，不误拒（文件实际在根外也放行）', async () => {
    const real = makeTempDir()
    const linkRoot = makeTempDir()
    const linkPath = path.join(linkRoot, 'proj')
    try {
      if (!makeLink(real, linkPath)) throw new Error('当前环境无法创建符号链接/junction，链接校验用例无法执行')
      writeFileSync(path.join(real, 'a.ini'), 'x', 'utf8')
      // 根是链接：目标是「根的真实路径」内的文件，应放行（用户主动选择的项目）
      await expect(assertNoLinkEscape(linkPath, path.join(linkPath, 'a.ini'))).resolves.toBeUndefined()
    } finally {
      rmSync(real, { recursive: true, force: true })
      rmSync(linkRoot, { recursive: true, force: true })
    }
  })

  it('invalidateRealRoot 清缓存后重新解析（根被删除重建后基准更新）', async () => {
    const root = makeTempDir()
    const outside = makeTempDir()
    try {
      // 缓存真实路径后把根删除重建为指向外部的 junction
      const r1 = await realRootOf(root)
      expect(typeof r1).toBe('string')
      rmSync(root, { recursive: true, force: true })
      if (!makeLink(outside, root)) throw new Error('当前环境无法创建符号链接/junction，链接校验用例无法执行')
      // 未失效前：缓存旧真实路径 → 指向外部 junction 的文件被误拒
      await expect(assertNoLinkEscape(root, path.join(root, 'x.txt'))).rejects.toThrow('链接')
      // 失效后：以新真实根为基准 → 放行
      invalidateRealRoot(root)
      await expect(assertNoLinkEscape(root, path.join(root, 'x.txt'))).resolves.toBeUndefined()
    } finally {
      rmSync(root, { recursive: true, force: true })
      rmSync(outside, { recursive: true, force: true })
    }
  })
})
