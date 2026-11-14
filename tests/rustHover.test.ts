/**
 * 悬停文档（hover）中文回译测试：
 * 中文模式下键是中文译名（名称/主体图像），悬停要能回译成英文键查代码表
 * （曾缺整词回译导致中文键悬停/双击不显示解释）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { EditorState } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'
import { resolveKeyEn, resolveLogicFunctionEn, rustTooltipAt } from '../src/features/editor/rustHover'
import { findLogicBoolean, loadCodeData } from '../src/services/codeData'

describe('resolveKeyEn（hover 键位置中文回译）', () => {
  const DATA_DIR = path.resolve(__dirname, '../public/data')

  beforeEach(async () => {
    // 用本地数据文件 mock fetch（vitest node 无网络；数据是应用内置的）
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        const rel = String(url).replace(/^\.?\//, '')
        const file = path.resolve(DATA_DIR, rel.replace(/^data\//, ''))
        if (file !== DATA_DIR && !file.startsWith(DATA_DIR + path.sep)) throw new Error('测试夹具：路径越出数据目录')
        const content = fs.readFileSync(file, 'utf8')
        return { ok: true, status: 200, json: async () => JSON.parse(content) } as unknown as Response
      }),
    )
    await loadCodeData()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  async function help(source: string, token: string, offset = 0) {
    vi.stubGlobal('document', { createElement: () => ({ className: '', innerHTML: '' }) })
    const view = { state: EditorState.create({ doc: source }) } as EditorView
    const pos = source.indexOf(token, offset)
    const tooltip = await rustTooltipAt(view, pos + Math.min(1, token.length))
    return { tooltip, html: tooltip?.create(view).dom.innerHTML, pos }
  }

  it.each(['true', 'false', 'True', 'FALSE', '真', '假', '是', '否'])('布尔值 %s 在后续行使用正确文档坐标', async (token) => {
    const source = `[core]\nname: test\n[hiddenAction_ai]\nai_isHighPriority: ${token}`
    const { tooltip, html, pos } = await help(source, token)
    expect(tooltip).toMatchObject({ pos, end: pos + token.length })
    expect(html).toMatch(/真|假/)
  })

  it.each(['self.isControlledByAI', 'self.isControlledByAI()', 'self.血量()'])('识别无括号与中文逻辑函数 %s', async (token) => {
    const source = `[hiddenAction_ai]\nautoTrigger: if ${token}`
    const { tooltip, pos } = await help(source, token)
    expect(tooltip).toMatchObject({ pos, end: pos + token.replace(/\(\)$/, '').length })
  })

  it('不在注释和完整标识符中的 true 子串上显示解释', async () => {
    for (const source of ['# autoTrigger: true', '  ; autoTrigger: true', 'autoTrigger: trueValue']) {
      expect((await help(source, 'true')).tooltip).toBeNull()
    }
  })

  it('自由值和引号字符串中的逻辑词保持为用户数据', async () => {
    for (const source of ['name: true', 'image: true.png', 'autoTrigger: "true"', "autoTrigger: 'true'", 'autoTrigger: " # true"', 'autoTrigger: "true']) {
      expect((await help(source, 'true')).tooltip).toBeNull()
    }
  })

  it('后续行枚举值范围排除缩进空格并使用文档坐标', async () => {
    const source = '[movement]\nmovementType:   LAND  '
    const { tooltip, html, pos } = await help(source, 'LAND')
    expect(tooltip).toMatchObject({ pos, end: pos + 4 })
    expect(html).toContain('陆地')
    expect((await help(`${source}# true`, 'LAND')).tooltip).toBeNull()
  })

  it('空格后的颜色仍有色卡，且颜色字段中的其他文字不当作布尔', async () => {
    const source = '[effect_test]\ncolor: #8E8E8E # true'
    const { tooltip, html, pos } = await help(source, '#8E8E8E')
    expect(tooltip).toMatchObject({ pos, end: pos + 7 })
    expect(html).toContain('#8E8E8E')
    expect((await help(source, 'true')).tooltip).toBeNull()
  })

  it('行内井号不截断逻辑值，后续词仍按实际文档位置提供释义', async () => {
    const source = '[hiddenAction_ai]\nautoTrigger: false # true'
    const { tooltip, pos } = await help(source, 'true')
    expect(tooltip).toMatchObject({ pos, end: pos + 4 })
  })

  it('缩进节头范围不包含行尾注释', async () => {
    const source = '  [core] # true'
    expect((await help(source, 'core')).tooltip).toMatchObject({ pos: 2, end: 8 })
    expect((await help(source, 'true')).tooltip).toBeNull()
  })

  it('数据异步加载期间文档改变时丢弃旧位置', async () => {
    const view = { state: EditorState.create({ doc: 'autoTrigger: true' }) }
    const pending = rustTooltipAt(view as EditorView, 14)
    view.state = EditorState.create({ doc: 'autoTrigger: false' })
    expect(await pending).toBeNull()
  })

  it('英文键原样返回', () => {
    expect(resolveKeyEn('name')).toBe('name')
  })

  it('中文译名整词回译（名称 → name）', () => {
    expect(resolveKeyEn('名称')).toBe('name')
  })

  it('中文译名多词回译（主体图像 → image）', () => {
    expect(resolveKeyEn('主体图像')).toBe('image')
  })

  it('分段宏字段回译（建造自_1_名称 → builtFrom_1_name，保留规范驼峰）', () => {
    expect(resolveKeyEn('建造自_1_名称')).toBe('builtFrom_1_name')
  })

  it('未知中文保持原样（词典没有的词不猜）', () => {
    expect(resolveKeyEn('不存在的键名')).toBe('不存在的键名')
  })

  it('首尾空白修剪', () => {
    expect(resolveKeyEn(' 名称 ')).toBe('name')
  })
})

describe('resolveLogicFunctionEn（逻辑表达式中文显示层回译）', () => {
  it('self 后的中文逻辑函数回译为英文函数名', () => {
    expect(resolveLogicFunctionEn('血量')).toBe('hp')
  })

  it('未知中文逻辑函数保持原样，避免猜测用户数据', () => {
    expect(resolveLogicFunctionEn('自定义函数')).toBe('自定义函数')
  })

  it('英文短函数名能命中 logicboolean 数据中的 self.hp()', () => {
    expect(findLogicBoolean('hp')?.name).toBe('self.hp()')
  })
})
