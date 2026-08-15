import { describe, expect, it } from 'vitest'
import { classifyLine, collectLocalVariables, findSectionOfLine, isUnclosedSection, keyOfLine, smartEnterInsert } from '../src/features/editor/rustLanguage'

describe('Rust 配置行分类（高亮规则）', () => {
  it('注释行', () => {
    expect(classifyLine('# 这是一条注释')).toEqual({ kind: 'comment' })
    expect(classifyLine('  # 带缩进注释')).toEqual({ kind: 'comment' })
  })

  it('节名行', () => {
    expect(classifyLine('[core]')).toEqual({ kind: 'section' })
    expect(classifyLine('[attack]')).toEqual({ kind: 'section' })
  })

  it('键值行', () => {
    const r = classifyLine('name: 步枪兵')
    expect(r.kind).toBe('keyvalue')
    if (r.kind === 'keyvalue') {
      expect(r.key).toBe('name')
      expect(r.value).toBe('步枪兵')
    }
  })

  it('普通行', () => {
    expect(classifyLine('some free text')).toEqual({ kind: 'plain' })
    expect(classifyLine('')).toEqual({ kind: 'plain' })
  })

  it('未闭合节判断', () => {
    expect(isUnclosedSection('[core')).toBe(true)
    expect(isUnclosedSection('[core]')).toBe(false)
    expect(isUnclosedSection('name: x')).toBe(false)
  })

  it('行内 key 提取', () => {
    expect(keyOfLine('name: 值')).toBe('name')
    expect(keyOfLine('damage : 12')).toBe('damage')
    expect(keyOfLine('没有冒号')).toBeNull()
  })

  it('向上扫描最近的节', () => {
    const lines = ['[core]', 'name: x', '[attack]', 'range: 100']
    expect(findSectionOfLine(lines, 0)).toBe('core')
    expect(findSectionOfLine(lines, 1)).toBe('core')
    expect(findSectionOfLine(lines, 2)).toBe('attack')
    expect(findSectionOfLine(lines, 3)).toBe('attack')
    expect(findSectionOfLine(['无节'], 0)).toBe('')
  })
})

describe('智能换行（节头回车自动补 ]）', () => {
  it('未闭合节头回车补 ]', () => {
    expect(smartEnterInsert('[core')).toBe(']\n')
    expect(smartEnterInsert('[attack')).toBe(']\n')
  })

  it('以 _ 结尾补 name]（needName 节）', () => {
    expect(smartEnterInsert('[turret_')).toBe('name]\n')
    expect(smartEnterInsert('[projectile_')).toBe('name]\n')
  })

  it('已闭合节头不补（正常换行）', () => {
    expect(smartEnterInsert('[core]')).toBeNull()
    expect(smartEnterInsert('[core] name: x')).toBeNull()
  })

  it('非节头行不补', () => {
    expect(smartEnterInsert('name: ')).toBeNull()
    expect(smartEnterInsert('')).toBeNull()
    expect(smartEnterInsert('# 注释')).toBeNull()
  })

  it('行首带空格也识别', () => {
    expect(smartEnterInsert('  [core')).toBe(']\n')
  })

  it('光标在行中（前有内容）仍按节头规则', () => {
    expect(smartEnterInsert('[core] # 注释，光标后')).toBeNull()
    expect(smartEnterInsert('[core x')).toBe(']\n')
  })

  it('光标后还有内容（行中回车）不补，避免破坏行', () => {
    expect(smartEnterInsert('[turr', 'et_0]')).toBeNull()
    expect(smartEnterInsert('[core', ']')).toBeNull()
    expect(smartEnterInsert('[core', ' # 注释')).toBeNull()
  })

  it('光标在行尾（无后续内容）才补', () => {
    expect(smartEnterInsert('[core', '')).toBe(']\n')
    expect(smartEnterInsert('[turret_', '')).toBe('name]\n')
  })
})

describe('局部变量收集（${}）', () => {
  it('收集中文/英文变量名并去重', () => {
    expect(collectLocalVariables(['name: ${坦克名}', 'x: ${坦克名} ${价格}'])).toEqual(['坦克名', '价格'])
    expect(collectLocalVariables(['a: ${hp}', 'b: ${hp} ${mp}'])).toEqual(['hp', 'mp'])
  })

  it('${节.键} 引用与空变量不收集', () => {
    expect(collectLocalVariables(['a: ${core.name}'])).toEqual([])
    expect(collectLocalVariables(['a: ${}'])).toEqual([])
  })

  it('无变量返回空数组', () => {
    expect(collectLocalVariables(['[core]', 'name: x'])).toEqual([])
  })
})
