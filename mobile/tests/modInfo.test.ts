/**
 * mod-info.txt 保留写回测试：
 * 只改表单动过的键，注释 / 未知键 / 其它节 / 换行风格必须原样保留。
 */
import { describe, expect, it } from 'vitest'
import { readModInfoKey, updateModInfoText } from '../src/features/modTools/modInfo'

const SAMPLE = `# 我的模组说明（手写注释，别弄丢）
[mod]
title: 旧标题
description: 一段描述
author: 老王
version: 1.0
minVersion: 1.15
customUnknownKey: 未知键的值

[other]
note: 其它节的内容
`

describe('模组信息保留写回', () => {
  it('更新已有键，保留注释与其它节', () => {
    const out = updateModInfoText(SAMPLE, [{ key: 'title', value: '新标题' }])
    expect(out).toContain('title: 新标题')
    expect(out).not.toContain('旧标题')
    expect(out).toContain('# 我的模组说明（手写注释，别弄丢）')
    expect(out).toContain('customUnknownKey: 未知键的值')
    expect(out).toContain('[other]')
    expect(out).toContain('note: 其它节的内容')
  })

  it('未传入的键不会被清空（回归：旧实现会重置音乐/地图字段）', () => {
    const withMusic = `[mod]\ntitle: x\nmusic: a.ogg\nmaps: m.tmx\n`
    const out = updateModInfoText(withMusic, [{ key: 'title', value: 'y' }])
    expect(out).toContain('music: a.ogg')
    expect(out).toContain('maps: m.tmx')
  })

  it('多个键一起更新互不干扰', () => {
    const out = updateModInfoText(SAMPLE, [
      { key: 'author', value: '新作者' },
      { key: 'version', value: '2.0' },
    ])
    expect(out).toContain('author: 新作者')
    expect(out).toContain('version: 2.0')
    expect(out).toContain('title: 旧标题')
  })

  it('新键插入到 [mod] 节末尾，不挤进其它节', () => {
    const out = updateModInfoText(SAMPLE, [{ key: 'updateUrl', value: 'https://example.com' }])
    const lines = out.split('\n')
    const modEnd = lines.findIndex((l) => l.trim() === '[other]')
    const urlLine = lines.findIndex((l) => l.startsWith('updateUrl:'))
    expect(urlLine).toBeGreaterThan(-1)
    expect(urlLine).toBeLessThan(modEnd)
    expect(out).toContain('customUnknownKey: 未知键的值')
  })

  it('value 为 null 时删除该键', () => {
    const out = updateModInfoText(SAMPLE, [{ key: 'description', value: null }])
    expect(out).not.toContain('description:')
    expect(out).toContain('title: 旧标题')
  })

  it('删除不存在的键不报错也不改动内容', () => {
    expect(updateModInfoText(SAMPLE, [{ key: 'nope', value: null }])).toBe(SAMPLE)
  })

  it('没有 [mod] 节时补一个并写入', () => {
    const out = updateModInfoText('version: 1\n', [{ key: 'title', value: 'T' }])
    expect(out).toContain('[mod]')
    expect(out).toContain('title: T')
    expect(out).toContain('version: 1')
  })

  it('空文件也能写入', () => {
    const out = updateModInfoText('', [{ key: 'title', value: '标题' }])
    expect(out).toContain('[mod]')
    expect(out).toContain('title: 标题')
  })

  it('保留 CRLF 换行风格', () => {
    const crlf = '[mod]\r\ntitle: a\r\nauthor: b\r\n'
    const out = updateModInfoText(crlf, [{ key: 'title', value: 'c' }])
    expect(out).toContain('\r\n')
    expect(out.split('\r\n').filter(Boolean).length).toBe(3)
    expect(out.endsWith('\r\n')).toBe(true)
  })

  it('保留原有键行的缩进', () => {
    const indented = '[mod]\n    title: a\n'
    const out = updateModInfoText(indented, [{ key: 'title', value: 'b' }])
    expect(out).toContain('    title: b')
  })

  it('键名匹配不区分大小写（沿用 readModInfo 的解析口径）', () => {
    const out = updateModInfoText('[mod]\nTitle: a\n', [{ key: 'title', value: 'b' }])
    expect(out).not.toContain('Title: a')
    expect(out.toLowerCase()).toContain('title: b')
  })

  it('注释里的同名键不会被误改', () => {
    const text = '[mod]\n# title: 注释里的\n title: 真值\n'
    const out = updateModInfoText(text, [{ key: 'title', value: '新值' }])
    expect(out).toContain('# title: 注释里的')
    expect(out).toContain('title: 新值')
  })

  it('键名前缀相近不会互相命中', () => {
    const text = '[mod]\ntitle2: x\ntitle: y\n'
    const out = updateModInfoText(text, [{ key: 'title', value: 'z' }])
    expect(out).toContain('title2: x')
    expect(out).toContain('title: z')
  })

  it('readModInfoKey 读回当前值', () => {
    expect(readModInfoKey(SAMPLE, 'author')).toBe('老王')
    expect(readModInfoKey(SAMPLE, 'missing')).toBeUndefined()
  })

  it('更新结果可被再次读取（表单往返一致）', () => {
    const out = updateModInfoText(SAMPLE, [{ key: 'updateUrl', value: 'https://a.b' }])
    expect(readModInfoKey(out, 'updateUrl')).toBe('https://a.b')
  })
})
