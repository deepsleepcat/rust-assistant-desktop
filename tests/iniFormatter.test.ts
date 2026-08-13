import { describe, expect, it } from 'vitest'
import { formatIni } from '../src/features/editor/iniFormatter'

describe('INI 格式化', () => {
  it('冒号前不加空格（修复 name : w bug）', () => {
    expect(formatIni('名称 : w')).toBe('名称: w')
    // 冒号前空格去掉；冒号后无空格则保持无空格
    expect(formatIni('name :w')).toBe('name:w')
    expect(formatIni('name : w')).toBe('name: w')
  })

  it('保留冒号后的原空格风格（不新增空格）', () => {
    expect(formatIni('名称:零级限制')).toBe('名称:零级限制')
    expect(formatIni('名称: 零级限制')).toBe('名称: 零级限制')
    expect(formatIni('name:w')).toBe('name:w')
    expect(formatIni('name: w')).toBe('name: w')
  })

  it('等号同理', () => {
    expect(formatIni('a=b')).toBe('a=b')
    expect(formatIni('a = b')).toBe('a= b')
  })

  it('注释、节、空行保持原样', () => {
    const input = '# 注释\n[core]\n\nname: test'
    expect(formatIni(input)).toBe('# 注释\n[core]\n\nname: test')
  })

  it('引号内的冒号不动', () => {
    expect(formatIni('desc: "a:b"')).toBe('desc: "a:b"')
  })

  it('保留 CRLF 换行风格', () => {
    expect(formatIni('a: b\r\nc: d\r\n')).toBe('a: b\r\nc: d\r\n')
  })
})
