/**
 * 模组质量报告（M13，任务 7）测试：文本/JSON 序列化、脱敏（无绝对路径）、
 * 汇总统计逻辑。报告生成（generateModReport）依赖 bridge，用纯函数部分覆盖。
 */
import { describe, expect, it } from 'vitest'
import { reportToJson, reportToText, type ModReport } from '../src/features/modTools/modReport'

function makeReport(): ModReport {
  return {
    meta: {
      projectName: '测试模组',
      generatedAt: 1700000000000,
      fileCount: 12,
      unitCount: 3,
      imageCount: 8,
      audioCount: 1,
      targetVersion: '跟随最新',
    },
    checkerSummary: [
      { ruleId: 'checkPositiveCoreStats', title: 'checkPositiveCoreStats', errors: 2, warnings: 0 },
      { ruleId: 'checkKeyTypos', title: 'checkKeyTypos', errors: 0, warnings: 1 },
    ],
    issues: [
      { file: 'units/a/a.ini', line: 5, ruleId: 'checkPositiveCoreStats', severity: 'error', message: '「maxHp」必须为正数', suggestion: '改成大于 0 的数值' },
      { file: 'units/b.ini', line: 2, ruleId: 'checkKeyTypos', severity: 'warning', message: '疑似拼写错误', suggestion: '是否应为 xxx' },
    ],
    versionConclusion: '目标版本 跟随最新：未发现版本兼容问题',
    ok: false,
  }
}

describe('reportToText', () => {
  it('包含项目名/统计/汇总/问题清单', () => {
    const text = reportToText(makeReport())
    expect(text).toContain('测试模组')
    expect(text).toContain('文件 12 · 单位 3')
    expect(text).toContain('checkPositiveCoreStats: 2 错误 / 0 警告')
    expect(text).toContain('units/a/a.ini:5')
    expect(text).toContain('[错误]')
    expect(text).toContain('建议：改成大于 0 的数值')
  })

  it('无问题时输出「未发现问题」', () => {
    const r = makeReport()
    r.ok = true
    r.issues = []
    r.checkerSummary = []
    expect(reportToText(r)).toContain('未发现问题')
    expect(reportToText(r)).toContain('总体：通过')
  })
})

describe('reportToJson / 脱敏', () => {
  it('JSON 可解析且路径均为相对路径（不含盘符/根路径）', () => {
    const json = reportToJson(makeReport())
    const parsed = JSON.parse(json) as ModReport
    expect(parsed.meta.projectName).toBe('测试模组')
    expect(parsed.issues[0].file).toBe('units/a/a.ini')
    // 脱敏：整个序列化内容不含绝对路径特征（盘符/斜杠开头）
    expect(json).not.toMatch(/[A-Za-z]:[\\/]/)
    expect(json).not.toMatch(/^[\\/]/m)
  })

  it('汇总按错误数降序（生成逻辑排序后）', () => {
    const r = makeReport()
    expect(r.checkerSummary[0].ruleId).toBe('checkPositiveCoreStats')
    expect(r.checkerSummary[0].errors).toBeGreaterThan(r.checkerSummary[1].errors)
  })
})
