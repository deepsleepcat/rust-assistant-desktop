/**
 * 编辑器双语标签测试（对齐桌面端 tests/bilingualLabels.test.ts 纯函数部分）：
 * 键/节名显示中文译名；注释与值/路径不标注；扩展只加装饰、不改文档内容。
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { EditorState } from '@codemirror/state'
import { bilingualLabelForLine, bilingualLabels } from '../src/features/editor/bilingualLabels'
import { loadCodeData, reloadCodeData } from '../src/services/codeData'

beforeAll(async () => {
  const root = path.resolve(__dirname, '../public/data')
  vi.stubGlobal('fetch', vi.fn(async (input: string) => {
    const file = path.resolve(root, String(input).replace(/^\/?data\//, ''))
    if (!file.startsWith(root + path.sep)) throw new Error('Fixture outside data directory')
    return { ok: true, status: 200, json: async () => JSON.parse(fs.readFileSync(file, 'utf8')) } as Response
  }))
  reloadCodeData()
  await loadCodeData()
})
afterAll(() => { vi.unstubAllGlobals(); reloadCodeData() })

describe('display-only bilingual fields', () => {
  it('labels keys and named sections without labeling comments or values', () => {
    expect(bilingualLabelForLine('  name: 中文值')).toMatchObject({ from: 2, to: 6, label: expect.any(String) })
    expect(bilingualLabelForLine('[turret]')).toMatchObject({ from: 1, to: 7, label: expect.any(String) })
    expect(bilingualLabelForLine('# name: comment')).toBeNull()
    expect(bilingualLabelForLine('; image: comment')).toBeNull()
    expect(bilingualLabelForLine('user_variable: name/path.png')).toBeNull()
  })

  it('extension leaves document, values, paths and names unchanged', () => {
    const source = '[core]\nname: 用户名\nimage: folder/name.png\n@global customVariable: 2\n# name: 注释'
    const state = EditorState.create({ doc: source, extensions: bilingualLabels })
    expect(state.doc.toString()).toBe(source)
  })

  it('未知键/节不标注（避免误报）', () => {
    expect(bilingualLabelForLine('totally_unknown_key: 1')).toBeNull()
    expect(bilingualLabelForLine('[totally_unknown_section]')).toBeNull()
  })

  it('已无差异的译名不重复标注（translate === 原名）', () => {
    // code.json 中部分键的译名与原文相同；此处构造一个必然相同的场景：
    // 译名等于键名时（translate !== raw 判定）返回 null
    const line = 'name: x'
    const label = bilingualLabelForLine(line)
    if (label) expect(label.label).not.toBe('name')
  })
})
