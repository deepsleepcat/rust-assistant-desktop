import { describe, expect, it } from 'vitest'
import { basename, extname, isRustConfigFile, truncateMiddle } from '../src/utils/paths'

describe('路径工具', () => {
  it('提取文件名', () => {
    expect(basename('C:\\模组\\units\\rifle.txt')).toBe('rifle.txt')
    expect(basename('units/tank.ini')).toBe('tank.ini')
    expect(basename('C:\\模组\\')).toBe('模组')
  })

  it('提取扩展名（小写）', () => {
    expect(extname('rifle.TXT')).toBe('.txt')
    expect(extname('mod.json')).toBe('.json')
    expect(extname('README')).toBe('')
  })

  it('识别铁锈战争配置类文件', () => {
    expect(isRustConfigFile('a.txt')).toBe(true)
    expect(isRustConfigFile('b.ini')).toBe(true)
    expect(isRustConfigFile('c.cfg')).toBe(true)
    expect(isRustConfigFile('d.md')).toBe(false)
    expect(isRustConfigFile('e.png')).toBe(false)
  })

  it('长路径中间截断', () => {
    const p = 'C:\\很长的目录\\又一段很长的目录\\铁锈战争模组\\正式单位目录\\units\\rifle.txt'
    const out = truncateMiddle(p, 40)
    expect(out.length).toBeLessThanOrEqual(40)
    expect(out).toContain('…')
    expect(truncateMiddle('短路径.txt')).toBe('短路径.txt')
  })
})
