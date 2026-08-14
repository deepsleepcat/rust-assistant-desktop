/**
 * 离线知识包（M16，任务 6）测试：数据版本信息与一致性校验。
 */
import { describe, expect, it } from 'vitest'
import { getDataVersionInfo } from '../src/services/codeData'

describe('getDataVersionInfo（离线数据版本）', () => {
  it('未加载时返回 loaded=false 且计数为 0（不抛错）', () => {
    const info = getDataVersionInfo()
    expect(info.loaded).toBe(false)
    expect(info.codeCount).toBe(0)
    expect(info.versionCount).toBe(0)
    expect(info.consistent).toBe(true) // 空数据视为一致
  })

  it('字段版本上限与版本表一致性语义（maxAddVersion ≤ latest）', () => {
    // 纯逻辑验证：加载数据前的边界（数据加载后由集成测试覆盖）
    const info = getDataVersionInfo()
    expect(info.maxAddVersion).toBeUndefined()
    expect(info.latestVersionNumber).toBeUndefined()
  })
})
