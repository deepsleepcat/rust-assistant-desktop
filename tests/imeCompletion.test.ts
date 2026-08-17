import { describe, expect, it } from 'vitest'
import { shouldReopenAfterComposition } from '../src/features/editor/imeCompletion'

describe('中文输入法提交后的补全重开守卫', () => {
  const base = {
    startedDoc: 'name: ',
    endedDoc: 'name: 飞',
    hasFocus: true,
    now: 1000,
    suppressReopenUntil: 0,
  }

  it('真实提交且编辑器聚焦时允许查询补全', () => {
    expect(shouldReopenAfterComposition(base)).toBe(true)
  })

  it('组合未改变文档时不重开', () => {
    expect(shouldReopenAfterComposition({ ...base, endedDoc: base.startedDoc })).toBe(false)
  })

  it('失焦时不重开', () => {
    expect(shouldReopenAfterComposition({ ...base, hasFocus: false })).toBe(false)
  })

  it('Esc 抑制窗口内不重开', () => {
    expect(shouldReopenAfterComposition({ ...base, suppressReopenUntil: 1200 })).toBe(false)
    expect(shouldReopenAfterComposition({ ...base, suppressReopenUntil: 1000 })).toBe(true)
  })

  it('没有 compositionstart 快照时不重开', () => {
    expect(shouldReopenAfterComposition({ ...base, startedDoc: null })).toBe(false)
  })
})
