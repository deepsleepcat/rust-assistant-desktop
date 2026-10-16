/** 文件名与路径边界校验测试 */
import { describe, expect, it } from 'vitest'
import { isPathInsideRoot, validateEntryName } from '../src/utils/entryName'

const ROOT = '/data/user/0/app/files/projects/demo'

describe('文件名校验', () => {
  it('合法名称通过', () => {
    expect(validateEntryName('rifleman.ini').ok).toBe(true)
    expect(validateEntryName('新建单位').ok).toBe(true)
    expect(validateEntryName('unit_1.template').ok).toBe(true)
  })

  it('空名称与纯空白被拒绝', () => {
    expect(validateEntryName('').ok).toBe(false)
    expect(validateEntryName('   ').ok).toBe(false)
  })

  it('点号本身与上级目录引用被拒绝', () => {
    expect(validateEntryName('.').ok).toBe(false)
    expect(validateEntryName('..').ok).toBe(false)
  })

  it('路径分隔符被拒绝（防止写到别的目录）', () => {
    expect(validateEntryName('a/b.ini').ok).toBe(false)
    expect(validateEntryName('..\\evil.ini').ok).toBe(false)
  })

  it('Windows 保留字符与控制字符被拒绝', () => {
    expect(validateEntryName('a:b.ini').ok).toBe(false)
    expect(validateEntryName('a*b.ini').ok).toBe(false)
    expect(validateEntryName('a\u0000b.ini').ok).toBe(false)
    expect(validateEntryName('a\nb.ini').ok).toBe(false)
  })

  it('超长名称被拒绝', () => {
    expect(validateEntryName('a'.repeat(101)).ok).toBe(false)
    expect(validateEntryName('a'.repeat(100)).ok).toBe(true)
  })

  it('以点号结尾的名称被拒绝', () => {
    expect(validateEntryName('name.').ok).toBe(false)
  })

  it('同目录重名被拒绝（不区分大小写，避免 Windows 端冲突）', () => {
    expect(validateEntryName('Rifleman.ini', ['rifleman.ini']).ok).toBe(false)
    expect(validateEntryName('rifleman.ini', ['rifleman.ini']).ok).toBe(false)
    expect(validateEntryName('scout.ini', ['rifleman.ini']).ok).toBe(true)
  })

  it('输入两端空白先被裁剪再判定', () => {
    expect(validateEntryName('  scout.ini  ').ok).toBe(true)
    expect(validateEntryName('  rifleman.ini ', ['rifleman.ini']).ok).toBe(false)
  })

  it('失败时给出可读原因', () => {
    expect(validateEntryName('a/b').error).toContain('\\')
    expect(validateEntryName('').error).toContain('不能为空')
    expect(validateEntryName('x', ['x']).error).toContain('同名')
  })
})

describe('路径边界校验', () => {
  it('根目录内路径通过', () => {
    expect(isPathInsideRoot(ROOT, `${ROOT}/units/rifleman.ini`)).toBe(true)
  })

  it('根目录自身通过', () => {
    expect(isPathInsideRoot(ROOT, ROOT)).toBe(true)
  })

  it('根目录外路径被拒绝', () => {
    expect(isPathInsideRoot(ROOT, '/data/user/0/app/files/projects/other/units/a.ini')).toBe(false)
    expect(isPathInsideRoot(ROOT, '/storage/emulated/0/x.ini')).toBe(false)
  })

  it('前缀相似的兄弟目录不被误判为根内', () => {
    expect(isPathInsideRoot(ROOT, `${ROOT}-backup/units/a.ini`)).toBe(false)
  })

  it('含 .. 的逃逸路径被拒绝', () => {
    expect(isPathInsideRoot(ROOT, `${ROOT}/../other/a.ini`)).toBe(false)
    expect(isPathInsideRoot(ROOT, `${ROOT}/./units/a.ini`)).toBe(true)
  })

  it('反斜杠与重复分隔符按段归一', () => {
    expect(isPathInsideRoot(ROOT, `${ROOT}//units\\\\a.ini`)).toBe(true)
  })

  it('空项目根或空目标一律判为越界（fail-closed，避免边界整体失效）', () => {
    // 空 root 归一后是空数组，前缀检查会被整体跳过；必须显式拒绝
    expect(isPathInsideRoot('', '/any/path.ini')).toBe(false)
    expect(isPathInsideRoot(ROOT, '')).toBe(false)
    expect(isPathInsideRoot('', '')).toBe(false)
    expect(isPathInsideRoot('.', '/abs/path.ini')).toBe(false)
  })
})
