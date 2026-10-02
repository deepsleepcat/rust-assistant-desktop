import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

interface ElectronBuildConfig {
  files?: string[]
  extraFiles?: unknown
  extraResources?: unknown
  asarUnpack?: string[]
}

interface PackageJson {
  build?: ElectronBuildConfig
}

const projectRoot = path.win32.resolve(process.cwd())
const packageJson = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8')) as PackageJson
const externalResearchRoots = [
  'W:\\mao\\tx\\AbyssStars深渊星辰0.7.10',
  'W:\\mao\\tx\\ASEU深渊星辰-深渊扩展DLCX',
  'W:\\mao\\tx\\模组加载器',
  'W:\\mao\\tx\\模组实例',
  'W:\\mao\\tx\\模组实例\\特殊',
]

function isOutsideProject(absolutePath: string): boolean {
  const relative = path.win32.relative(projectRoot, absolutePath)
  return relative === '..' || relative.startsWith(`..${path.win32.sep}`) || path.win32.isAbsolute(relative)
}

describe('桌面应用发行边界', () => {
  it('Electron builder only includes controlled application outputs', () => {
    const build = packageJson.build
    expect(build).toBeDefined()
    expect(build?.files).toEqual([
      'dist/**',
      'dist-electron/**',
      'public/**',
      'build/icon.ico',
      'vendor/pi/LICENSE',
      'package.json',
    ])
    expect(build?.extraResources).toBeUndefined()
    expect(build?.extraFiles).toBeUndefined()
    expect(build?.asarUnpack).toEqual(['node_modules/ffmpeg-static/**'])
  })

  it('does not map external Rusted Warfare research corpora into the desktop package', () => {
    const filePatterns = packageJson.build?.files ?? []
    for (const corpusPath of externalResearchRoots) {
      expect(path.win32.isAbsolute(corpusPath)).toBe(true)
      expect(isOutsideProject(corpusPath)).toBe(true)
      expect(filePatterns).not.toContain(corpusPath)
      expect(filePatterns).not.toContain(`${corpusPath}/**`)
    }
    expect(filePatterns.some((pattern) => /模组实例|AbyssStars|ASEU|模组加载器|\.rwmod|\.zip/i.test(pattern))).toBe(false)
  })

  it('keeps the project-local research skill out of desktop resource roots', () => {
    const filePatterns = packageJson.build?.files ?? []
    expect(filePatterns.some((pattern) => pattern === '.agents/**' || pattern.startsWith('.agents/'))).toBe(false)
    expect(filePatterns.some((pattern) => pattern === 'assets/ai/**' || pattern.startsWith('assets/ai/'))).toBe(false)
  })

  // M42：examples/ 是给用户看的可复制示例，不是运行时资源。
  // 打进包里既没必要，也会让「宿主不含任何引擎相关可执行物」这句话变得难以自证。
  it('M42：示例 DLC 目录不进入发行包，且包内不含任何引擎渲染程序', () => {
    const filePatterns = packageJson.build?.files ?? []
    expect(filePatterns.some((pattern) => pattern === 'examples/**' || pattern.startsWith('examples/'))).toBe(false)
    expect(filePatterns.some((pattern) => pattern.startsWith('ENGINE-DLC'))).toBe(false)
    // 发行包里不该出现任何 DLC 清单/入口（它们只应由用户自己放进 userData/engine-dlc）
    expect(filePatterns.some((pattern) => /dlc\.json|engine-dlc/i.test(pattern))).toBe(false)
  })
})
