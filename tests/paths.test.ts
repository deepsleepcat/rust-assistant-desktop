import { describe, expect, it } from 'vitest'
import { basename, extname, isRustConfigFile, truncateMiddle } from '../src/utils/paths'
import { isAbsolutePath, normalizeOpenPath } from '../src/utils/projectPath'
import { pathStartsWith, replacePathPrefix } from '../src/stores/slices/projectSlice'

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

describe('openFile 路径归一化（单位库相对路径契约）', () => {
  it('isAbsolutePath：盘符/UNC/根路径判定', () => {
    expect(isAbsolutePath('C:\\mod\\units\\tank.ini')).toBe(true)
    expect(isAbsolutePath('C:/mod/units/tank.ini')).toBe(true)
    expect(isAbsolutePath('\\\\server\\share\\a.ini')).toBe(true)
    expect(isAbsolutePath('/posix/a.ini')).toBe(true)
    expect(isAbsolutePath('units/tank/tank.ini')).toBe(false)
    expect(isAbsolutePath('mod-info.txt')).toBe(false)
  })

  it('normalizeOpenPath：绝对路径原样，相对路径拼项目根', () => {
    expect(normalizeOpenPath('W:\\模组\\我的模组', 'units/tank/tank.ini')).toBe('W:\\模组\\我的模组/units/tank/tank.ini')
    expect(normalizeOpenPath('W:\\模组\\我的模组', 'W:\\模组\\我的模组\\units\\tank\\tank.ini')).toBe('W:\\模组\\我的模组\\units\\tank\\tank.ini')
    // 绝对路径原样放行（安全边界在 bridge 的 requireRealInsideRoot，不在这里二次拦截）
    expect(normalizeOpenPath('W:/模组', 'C:/evil.txt')).toBe('C:/evil.txt')
  })

  it('pathStartsWith：目录前缀匹配对分隔符/大小写不敏感（标签改名/删除用）', () => {
    expect(pathStartsWith('C:\\proj\\units\\a.txt', 'C:\\proj\\units')).toBe(true)
    expect(pathStartsWith('C:/proj/units/a.txt', 'C:\\proj\\units')).toBe(true) // 正斜杠标签 + 反斜杠目录
    expect(pathStartsWith('C:\\proj\\units', 'C:\\proj\\units')).toBe(true) // 自身
    expect(pathStartsWith('C:\\proj\\units2\\a.txt', 'C:\\proj\\units')).toBe(false) // 同名前缀不误配
    expect(pathStartsWith('c:\\proj\\units\\a.txt', 'C:\\PROJ\\UNITS')).toBe(true) // 大小写
  })

  it('replacePathPrefix：混合分隔符下替换仍落在正确位置', () => {
    expect(replacePathPrefix('C:/proj/units/a.txt', 'C:\\proj\\units', 'C:\\proj\\renamed')).toBe('C:\\proj\\renamed/a.txt')
    expect(replacePathPrefix('C:\\proj\\units\\a.txt', 'C:\\proj\\units', 'C:\\proj\\renamed')).toBe('C:\\proj\\renamed\\a.txt')
    expect(replacePathPrefix('C:\\other\\x.txt', 'C:\\proj\\units', 'C:\\new')).toBe('C:\\other\\x.txt') // 不匹配原样
  })
})
