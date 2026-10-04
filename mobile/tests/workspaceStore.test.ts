/**
 * 工作区编辑会话的 store 行为测试。
 *
 * 只覆盖不触碰桥（Tauri）的编辑会话与跳转动作：
 * 项目/设置的持久化动作会调用 appDataDir，在 node 环境不可用，不在这里测。
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { useWorkspace } from '../src/stores/workspace'
import { createSession, isDirty, markExternallyChanged } from '../src/features/editor/editSession'
import { makeDict } from '../src/services/translation'

const DICT = makeDict(
  new Map([['name', '名称']]),
  new Map([['名称', 'name']]),
)

function session(chineseMode = false) {
  return createSession({
    projectId: 'p1',
    rootPath: '/data/app/projects/demo',
    path: '/data/app/projects/demo/units/a.ini',
    name: 'a.ini',
    raw: '[core]\nname: a\n',
    hasBom: false,
    mtimeMs: 100,
    chineseMode,
    dict: DICT,
  })
}

beforeEach(() => {
  useWorkspace.setState({ editorSession: null, editorJump: null })
})

describe('工作区 store：编辑会话', () => {
  it('打开会话后内容与基准一致，未修改即不脏', () => {
    useWorkspace.getState().openEditorSession(session())
    const s = useWorkspace.getState().editorSession
    expect(s?.path).toBe('/data/app/projects/demo/units/a.ini')
    expect(isDirty(s)).toBe(false)
  })

  it('编辑内容后变脏，撤销回原内容恢复干净', () => {
    const store = useWorkspace.getState()
    store.openEditorSession(session())
    store.updateEditorContent('changed')
    expect(isDirty(useWorkspace.getState().editorSession)).toBe(true)
    useWorkspace.getState().updateEditorContent('[core]\nname: a\n')
    expect(isDirty(useWorkspace.getState().editorSession)).toBe(false)
  })

  it('没有会话时编辑内容不报错也不创建会话', () => {
    useWorkspace.getState().updateEditorContent('x')
    expect(useWorkspace.getState().editorSession).toBeNull()
  })

  it('applyEditorSaved 推进基准并清理脏标记', () => {
    const store = useWorkspace.getState()
    store.openEditorSession(session())
    useWorkspace.getState().updateEditorContent('v2')
    useWorkspace.getState().applyEditorSaved({ path: '/data/app/projects/demo/units/a.ini', displaySnapshot: 'v2', english: 'v2', mtimeMs: 500 })
    const saved = useWorkspace.getState().editorSession
    expect(isDirty(saved)).toBe(false)
    expect(saved?.mtimeMs).toBe(500)
  })

  it('保存回调针对旧文件时不影响当前会话（回归：串档）', () => {
    useWorkspace.getState().openEditorSession(session())
    useWorkspace.getState().applyEditorSaved({ path: '/data/app/projects/demo/units/other.ini', displaySnapshot: 'x', english: 'x' })
    const current = useWorkspace.getState().editorSession
    expect(current?.path).toBe('/data/app/projects/demo/units/a.ini')
    expect(isDirty(current)).toBe(false)
  })

  it('AI 写入命中当前文件时打上冲突哨兵', () => {
    useWorkspace.getState().openEditorSession(session())
    useWorkspace.getState().markEditorExternallyChanged()
    expect(useWorkspace.getState().editorSession?.mtimeMs).toBe(-1)
  })

  it('markExternallyChanged 纯函数与 store 行为一致', () => {
    expect(markExternallyChanged(session()).mtimeMs).toBe(-1)
  })

  it('关闭编辑器清空会话', () => {
    useWorkspace.getState().openEditorSession(session())
    useWorkspace.getState().closeEditor()
    expect(useWorkspace.getState().editorSession).toBeNull()
  })
})

describe('工作区 store：检查跳转', () => {
  it('请求跳转记录行号，seq 递增保证重复点击同节也触发', () => {
    useWorkspace.getState().requestEditorJump(12)
    const first = useWorkspace.getState().editorJump
    expect(first?.line).toBe(12)
    useWorkspace.getState().requestEditorJump(12)
    const second = useWorkspace.getState().editorJump
    expect(second?.line).toBe(12)
    expect(second!.seq).toBeGreaterThan(first!.seq)
  })

  it('编辑器消费后清空请求', () => {
    useWorkspace.getState().requestEditorJump(7)
    useWorkspace.getState().clearEditorJump()
    expect(useWorkspace.getState().editorJump).toBeNull()
  })

  it('打开新会话时丢弃上一次的跳转请求', () => {
    useWorkspace.getState().requestEditorJump(7)
    useWorkspace.getState().openEditorSession(session())
    expect(useWorkspace.getState().editorJump).toBeNull()
  })

  it('关闭编辑器同时清空跳转请求', () => {
    useWorkspace.getState().requestEditorJump(7)
    useWorkspace.getState().closeEditor()
    expect(useWorkspace.getState().editorJump).toBeNull()
  })
})
