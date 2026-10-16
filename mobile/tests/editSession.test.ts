/**
 * 编辑会话纯逻辑测试：
 * 覆盖中文显示层的保存回译、保存期间继续输入、切换文件后的过期回调、
 * 撤销回保存状态、外部修改检测等数据保护行为。
 */
import { describe, expect, it } from 'vitest'
import { makeDict } from '../src/services/translation'
import {
  acceptOverwrite,
  applyEdit,
  applyReload,
  applySaveResult,
  checkExternalChange,
  createSession,
  isDirty,
  markExternallyChanged,
  prepareSave,
  type EditSession,
} from '../src/features/editor/editSession'

function dict() {
  return makeDict(
    new Map([
      ['name', '名称'],
      ['price', '价格'],
      ['maxhp', '最大生命'],
    ]),
    new Map([
      ['名称', 'name'],
      ['价格', 'price'],
      ['最大生命', 'maxHp'],
    ]),
  )
}

const RAW = `[core]
name: rifleman
price: 300
`

function open(overrides: Partial<Parameters<typeof createSession>[0]> = {}) {
  return createSession({
    projectId: 'p1',
    rootPath: '/data/app/projects/demo',
    path: '/data/app/projects/demo/units/rifleman.ini',
    name: 'rifleman.ini',
    raw: RAW,
    hasBom: false,
    mtimeMs: 1000,
    chineseMode: false,
    dict: dict(),
    ...overrides,
  })
}

describe('编辑会话：打开', () => {
  it('原文模式：显示内容即磁盘内容，且初始不脏', () => {
    const s = open()
    expect(s.content).toBe(RAW)
    expect(s.savedDisplay).toBe(RAW)
    expect(s.displayMode).toBe('plain')
    expect(s.translationTrack).toBeNull()
    expect(isDirty(s)).toBe(false)
  })

  it('中文模式：显示中文、原文留存、追踪表建立，且初始不脏', () => {
    const s = open({ chineseMode: true })
    expect(s.content).not.toBe(RAW)
    expect(s.content).toContain('名称')
    expect(s.original).toBe(RAW)
    expect(s.displayMode).toBe('zh')
    expect(s.translationTrack?.get('名称')).toBe('name')
    expect(isDirty(s)).toBe(false)
  })
})

describe('编辑会话：脏判定', () => {
  it('编辑后变脏', () => {
    const s = applyEdit(open(), 'changed')
    expect(isDirty(s)).toBe(true)
  })

  it('撤销回保存状态后恢复干净（内容相等即干净）', () => {
    const s = open()
    const edited = applyEdit(s, 'changed')
    expect(isDirty(edited)).toBe(true)
    expect(isDirty(applyEdit(edited, RAW))).toBe(false)
  })

  it('null 会话不脏', () => {
    expect(isDirty(null)).toBe(false)
  })
})

describe('编辑会话：保存', () => {
  it('中文模式准备保存时精确回译为英文', () => {
    const s = open({ chineseMode: true })
    const { displaySnapshot, english } = prepareSave(s, dict())
    expect(displaySnapshot).toBe(s.content)
    expect(english).toBe(RAW)
  })

  it('用户手写的中文在保存时保留（追踪表只还原翻译层产生的中文）', () => {
    const s = open({ chineseMode: true })
    const edited = applyEdit(s, s.content + '自定义说明: 我的部队\n')
    const { english } = prepareSave(edited, dict())
    expect(english).toContain('自定义说明: 我的部队')
    expect(english).toContain('name: rifleman')
  })

  it('保存期间没有继续输入 → 收敛为干净，基准推进', () => {
    const s = open()
    const edited = applyEdit(s, 'v2')
    const pending = prepareSave(edited, dict())
    const saved = applySaveResult(edited, { path: edited.path, ...pending })
    expect(isDirty(saved)).toBe(false)
    expect(saved.savedDisplay).toBe('v2')
    expect(saved.original).toBe('v2')
  })

  it('写盘后推进修改时间基准（否则下次保存会误判为自己造成的冲突）', () => {
    const s = open()
    const edited = applyEdit(s, 'v2')
    const pending = prepareSave(edited, dict())
    const saved = applySaveResult(edited, { path: edited.path, ...pending, mtimeMs: 7777 })
    expect(saved.mtimeMs).toBe(7777)
    expect(checkExternalChange(saved, 7777)).toBe('ok')
  })

  it('未提供修改时间时保留原基准', () => {
    const s = open()
    const saved = applySaveResult(s, { path: s.path, ...prepareSave(s, dict()) })
    expect(saved.mtimeMs).toBe(1000)
  })

  it('保存期间继续输入 → 保存基准推进，但会话仍然是脏的', () => {
    const s = open()
    const atSave = applyEdit(s, 'v2')
    const pending = prepareSave(atSave, dict())
    // 用户写盘期间又敲了内容
    const meanwhile = applyEdit(atSave, 'v3')
    const saved = applySaveResult(meanwhile, { path: atSave.path, ...pending })
    expect(saved.content).toBe('v3')
    expect(saved.savedDisplay).toBe('v2')
    expect(isDirty(saved)).toBe(true)
  })

  it('保存回调返回时已切换到别的文件 → 原样返回，不污染新会话', () => {
    const a = applyEdit(open(), 'a-v2')
    const pending = prepareSave(a, dict())
    const other = open({ path: '/data/app/projects/demo/units/other.ini', name: 'other.ini' })
    const result = applySaveResult(other, { path: a.path, ...pending })
    expect(result).toBe(other)
    expect(isDirty(result)).toBe(false)
  })

  it('中文模式保存后显示内容保持中文（不被英文覆盖）', () => {
    const s = open({ chineseMode: true })
    const edited = applyEdit(s, s.content.replace('价格: 300', '价格: 500'))
    const pending = prepareSave(edited, dict())
    const saved = applySaveResult(edited, { path: edited.path, ...pending })
    expect(saved.content).toContain('价格: 500')
    expect(saved.content).not.toContain('price')
    expect(saved.original).toContain('price: 500')
    expect(isDirty(saved)).toBe(false)
  })

  it('中文模式连续两次保存都不丢内容（回归：旧实现第二次会把显示内容换成英文）', () => {
    const s = open({ chineseMode: true })
    const first = applyEdit(s, s.content.replace('价格: 300', '价格: 400'))
    const p1 = prepareSave(first, dict())
    const afterFirst = applySaveResult(first, { path: first.path, ...p1 })
    const second = applyEdit(afterFirst, afterFirst.content.replace('价格: 400', '价格: 600'))
    const p2 = prepareSave(second, dict())
    expect(p2.english).toContain('price: 600')
    expect(p2.english).toContain('name: rifleman')
    const afterSecond = applySaveResult(second, { path: second.path, ...p2 })
    expect(afterSecond.content).toContain('价格: 600')
    expect(isDirty(afterSecond)).toBe(false)
  })
})

describe('编辑会话：外部修改', () => {
  it('修改时间一致视为无冲突', () => {
    expect(checkExternalChange(open(), 1000)).toBe('ok')
  })

  it('修改时间变化视为外部修改', () => {
    expect(checkExternalChange(open(), 2000)).toBe('external-changed')
  })

  it('任一侧修改时间未知（0）时不做误判', () => {
    expect(checkExternalChange(open({ mtimeMs: 0 }), 2000)).toBe('ok')
    expect(checkExternalChange(open(), 0)).toBe('ok')
  })

  it('选择覆盖后基准推进到磁盘当前值', () => {
    const s = acceptOverwrite(open(), 2000)
    expect(s.mtimeMs).toBe(2000)
    expect(checkExternalChange(s, 2000)).toBe('ok')
  })

  it('AI 等应用内写入打上哨兵后判定为冲突（即使 mtime 未知）', () => {
    const s = markExternallyChanged(open())
    expect(checkExternalChange(s, 0)).toBe('external-changed')
    expect(checkExternalChange(s, 1000)).toBe('external-changed')
    // 用户选择覆盖后哨兵被真实 mtime 取代，重新回到正常判定
    expect(checkExternalChange(acceptOverwrite(s, 3000), 3000)).toBe('ok')
  })
})

describe('编辑会话：重新载入', () => {
  it('重新载入丢弃本地修改并重建追踪表', () => {
    const s: EditSession = applyEdit(open({ chineseMode: true }), '本地乱改')
    const reloaded = applyReload(s, {
      raw: '[core]\nname: scout\n',
      hasBom: false,
      mtimeMs: 5000,
      chineseMode: true,
      dict: dict(),
    })
    expect(reloaded.projectId).toBe(s.projectId)
    expect(reloaded.rootPath).toBe(s.rootPath)
    expect(reloaded.path).toBe(s.path)
    expect(reloaded.mtimeMs).toBe(5000)
    expect(isDirty(reloaded)).toBe(false)
    expect(reloaded.content).toContain('名称')
    expect(reloaded.content).not.toContain('本地乱改')
  })

  it('重新载入为原文模式时清理追踪表', () => {
    const s = open({ chineseMode: true })
    const reloaded = applyReload(s, {
      raw: RAW,
      hasBom: false,
      mtimeMs: 6000,
      chineseMode: false,
      dict: dict(),
    })
    expect(reloaded.displayMode).toBe('plain')
    expect(reloaded.translationTrack).toBeNull()
    expect(reloaded.content).toBe(RAW)
  })
})
