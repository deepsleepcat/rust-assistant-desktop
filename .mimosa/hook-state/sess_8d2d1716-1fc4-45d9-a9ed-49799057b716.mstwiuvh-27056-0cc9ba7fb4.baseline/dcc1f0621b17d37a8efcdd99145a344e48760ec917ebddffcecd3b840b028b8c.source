/**
 * M23 社区本地基础测试：
 * - AI 用量统计：估算 token / 追加上限 / 汇总（今日/7天/累计）/ 脏数据清洗
 * - 模板库管理：导入（合法/损坏/同名加序号）/ 删除（越界拒绝）/ 用户 key 列表
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { addUsageRecord, estimateTokens, MAX_USAGE_RECORDS, parseStoredUsage, summarizeUsage, type AiUsageRecord } from '../src/features/ai/usageStats'
import { deleteUserTemplate, importTemplateFile, listUserTemplateKeys } from '../electron/modTools'

describe('usageStats（本地 AI 用量统计）', () => {
  it('estimateTokens：字符数/4 向上取整，空文本 0', () => {
    expect(estimateTokens('')).toBe(0)
    expect(estimateTokens('1234')).toBe(1)
    expect(estimateTokens('12345')).toBe(2)
    expect(estimateTokens('中文内容测试')).toBe(2) // 6 字 / 4 = 1.5 → 2
  })

  it('addUsageRecord：追加并保持上限（丢最旧）', () => {
    let records: AiUsageRecord[] = []
    for (let i = 0; i < MAX_USAGE_RECORDS + 5; i++) {
      records = addUsageRecord(records, { at: i, provider: 'deepseek', model: 'm', inputTokens: 1, outputTokens: 1 })
    }
    expect(records.length).toBe(MAX_USAGE_RECORDS)
    expect(records[0].at).toBe(5) // 最旧的 5 条被丢弃
  })

  it('summarizeUsage：今日（自然日）/近7天/累计 分别计数', () => {
    const now = new Date('2026-08-15T12:00:00').getTime()
    const dayStart = new Date('2026-08-15T00:00:00').getTime()
    const records: AiUsageRecord[] = [
      { at: dayStart + 1000, provider: 'deepseek', model: 'a', inputTokens: 100, outputTokens: 50 }, // 今日
      { at: now - 2 * 24 * 3600 * 1000, provider: 'deepseek', model: 'a', inputTokens: 200, outputTokens: 100 }, // 7 天内非今日
      { at: now - 10 * 24 * 3600 * 1000, provider: 'deepseek', model: 'a', inputTokens: 300, outputTokens: 150 }, // 更早
    ]
    const s = summarizeUsage(records, now)
    expect(s.totalCalls).toBe(3)
    expect(s.totalTokens).toBe(900)
    expect(s.todayCalls).toBe(1)
    expect(s.todayTokens).toBe(150)
    expect(s.weekCalls).toBe(2)
    expect(s.weekTokens).toBe(450)
  })

  it('parseStoredUsage：非数组/损坏条目跳过', () => {
    expect(parseStoredUsage(null)).toEqual([])
    expect(parseStoredUsage('x')).toEqual([])
    const out = parseStoredUsage([
      { at: 1, provider: 'deepseek', model: 'm', inputTokens: 5, outputTokens: 3 },
      { at: 'bad', provider: 'x' },
      { at: 2, inputTokens: -5 },
      'junk',
    ])
    expect(out.length).toBe(2)
    expect(out[1].inputTokens).toBe(0) // 负数清洗为 0
    expect(out[1].provider).toBe('unknown')
  })
})

describe('模板库管理（importTemplateFile / deleteUserTemplate / listUserTemplateKeys）', () => {
  function tmpDir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'tpl-test-'))
  }

  const VALID_TEMPLATE = JSON.stringify({ name: '测试模板', data: '[core]\nname: x\n', language: 'ALL', action: [] })
  const INVALID_TEMPLATE = '{"foo": 1}'

  it('导入合法模板；同名自动加序号；损坏拒绝', async () => {
    const dir = tmpDir()
    // 源文件放子目录，避免与目标目录（同一临时根）重名干扰
    const srcDir = path.join(dir, 'srcfiles')
    fs.mkdirSync(srcDir)
    const src = path.join(srcDir, 'src.json')
    fs.writeFileSync(src, VALID_TEMPLATE)
    const meta = await importTemplateFile(dir, src)
    expect(meta.key).toBe('src')
    expect(meta.name).toBe('测试模板')
    // 同名再次导入 → -2
    const meta2 = await importTemplateFile(dir, src)
    expect(meta2.key).toBe('src-2')
    // 损坏模板拒绝
    fs.writeFileSync(src, INVALID_TEMPLATE)
    await expect(importTemplateFile(dir, src)).rejects.toThrow(/不是有效的模板文件/)
    // key 列表
    expect((await listUserTemplateKeys(dir)).sort()).toEqual(['src', 'src-2'])
  })

  it('导入的文件名消毒（非法字符 → -）', async () => {
    const dir = tmpDir()
    const src = path.join(dir, 'a/b.json')
    fs.mkdirSync(path.dirname(src), { recursive: true })
    fs.writeFileSync(src, VALID_TEMPLATE)
    const meta = await importTemplateFile(dir, src)
    expect(meta.key).not.toContain('/')
    expect(meta.key).toBe('b')
  })

  it('删除：越界 key 拒绝、不存在文件返回 ok（幂等）', async () => {
    const dir = tmpDir()
    expect((await deleteUserTemplate(dir, '../evil')).ok).toBe(false)
    expect((await deleteUserTemplate(dir, 'a\\b')).ok).toBe(false)
    expect((await deleteUserTemplate(dir, '..')).ok).toBe(false)
    const src = path.join(dir, 't.json')
    fs.writeFileSync(src, VALID_TEMPLATE)
    const r = await deleteUserTemplate(dir, 't')
    expect(r.ok).toBe(true)
    expect(fs.existsSync(src)).toBe(false)
    // 幂等：再删不存在也 ok
    expect((await deleteUserTemplate(dir, 't')).ok).toBe(true)
  })

  it('目录不存在时 key 列表为空（不抛错）', async () => {
    expect(await listUserTemplateKeys(path.join(os.tmpdir(), 'no-such-dir-xyz'))).toEqual([])
  })
})
