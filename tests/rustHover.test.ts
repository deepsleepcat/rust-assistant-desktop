/**
 * 悬停文档（hover）中文回译测试：
 * 中文模式下键是中文译名（名称/主体图像），悬停要能回译成英文键查代码表
 * （曾缺整词回译导致中文键悬停/双击不显示解释）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { resolveKeyEn, resolveLogicFunctionEn } from '../src/features/editor/rustHover'
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
