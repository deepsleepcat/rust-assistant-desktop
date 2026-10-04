// @vitest-environment jsdom
/**
 * 编辑器页交互测试（真实组件 + 内存桥）。
 *
 * 验证的是「页面编排」而不是纯函数：未保存保护、保存写盘内容、保存失败不退出、
 * 外部修改冲突、图片走预览不进编辑器、删除/新建后文件树刷新。
 * 这些正是单元测试覆盖不到、而真机上最容易丢数据的地方。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createMemoryBridge, type MemoryBridgeHandle } from './fixtures/memoryBridge'
import { useWorkspace } from '../src/stores/workspace'
import { DEFAULT_SETTINGS } from '../src/utils/settings'
import { EditorScreen } from '../src/screens/EditorScreen'

const hoisted = vi.hoisted(() => ({ handle: null as MemoryBridgeHandle | null }))

vi.mock('../src/services/bridge', () => ({
  getBridge: () => hoisted.handle!.bridge,
  appPath: async (...parts: string[]) => ['/app', ...parts].join('/'),
  uniqueProjectDir: async (name: string) => `/app/projects/${name}`,
  deleteProject: async () => {},
  importMod: async () => null,
  writeProjectBinary: async () => {},
}))

// 知识库用 fetch 拉 public/data：jsdom 里不需要，给最小词条即可
// （中文显示层的翻译/回译要真的能命中，所以这里给 name↔名称）
vi.mock('../src/services/codeData', () => ({
  loadCodeData: async () => {},
  getEnToZhDict: () => new Map([['name', '名称']]),
  getZhToEnDict: () => new Map([['名称', 'name']]),
  getKeyZhToEnDict: () => new Map([['名称', 'name']]),
  findCodeByCode: () => undefined,
  findValueType: () => undefined,
  getAllCodes: () => [],
  getValueType: () => undefined,
}))

vi.mock('../src/features/editor/completion', () => ({
  invalidateResourceCache: () => {},
  rustCompletionSource: () => null,
  setCompletionChineseMode: () => {},
  setCompletionTracker: () => {},
}))

const ROOT = '/app/projects/demo'
const UNIT = `${ROOT}/units/a.ini`
const RAW = '[core]\nname: a\n'
const PROJECT = { id: ROOT, name: 'demo', rootPath: ROOT, createdAt: 1, lastOpenedAt: 1 }

function setupBridge(extra: Parameters<typeof createMemoryBridge>[0] = {}) {
  hoisted.handle = createMemoryBridge({
    files: {
      [`${ROOT}/mod-info.txt`]: '[mod]\ntitle: 示例\n',
      [UNIT]: RAW,
      ...(extra.files ?? {}),
    },
    binaries: {
      [`${ROOT}/units/tank.png`]: new Uint8Array([1, 2, 3]),
      ...(extra.binaries ?? {}),
    },
    ...extra,
  })
  return hoisted.handle
}

beforeEach(() => {
  setupBridge()
  useWorkspace.setState({
    ready: true,
    projects: [PROJECT],
    activeProjectId: PROJECT.id,
    activeTab: 'editor',
    editorSession: null,
    editorJump: null,
    settings: { ...DEFAULT_SETTINGS, translateMode: false },
  })
})

afterEach(() => {
  cleanup()
})

/** 展开 units 目录并打开 a.ini */
async function openUnit() {
  render(<EditorScreen />)
  const units = await screen.findByText('units')
  fireEvent.click(units)
  const file = await screen.findByText('a.ini')
  fireEvent.click(file)
  await waitFor(() => expect(useWorkspace.getState().editorSession).not.toBeNull())
}

/** 模拟用户在编辑器里敲字 */
function typeContent(value: string) {
  act(() => {
    useWorkspace.getState().updateEditorContent(value)
  })
}

describe('编辑器页：文件树', () => {
  it('列出项目文件，配置文件与图片都在', async () => {
    render(<EditorScreen />)
    expect(await screen.findByText('mod-info.txt')).toBeTruthy()
    expect(await screen.findByText('units')).toBeTruthy()
  })

  it('点击图片进只读预览，不进编辑器', async () => {
    render(<EditorScreen />)
    fireEvent.click(await screen.findByText('units'))
    fireEvent.click(await screen.findByText('tank.png'))
    // 预览页有像素尺寸信息；会话保持为空
    expect(await screen.findByText('文件大小')).toBeTruthy()
    expect(useWorkspace.getState().editorSession).toBeNull()
  })
})

describe('编辑器页：未保存保护', () => {
  it('修改后点返回弹出确认，会话仍在（内容不会静默丢失）', async () => {
    await openUnit()
    typeContent('改过的内容')
    fireEvent.click(screen.getByLabelText('返回'))
    expect(await screen.findByText('还有未保存的修改')).toBeTruthy()
    expect(useWorkspace.getState().editorSession?.content).toBe('改过的内容')
  })

  it('选择「放弃修改」才关闭会话', async () => {
    await openUnit()
    typeContent('改过的内容')
    fireEvent.click(screen.getByLabelText('返回'))
    fireEvent.click(await screen.findByText('放弃修改'))
    await waitFor(() => expect(useWorkspace.getState().editorSession).toBeNull())
    // 磁盘内容没被改动
    expect(hoisted.handle!.readText(UNIT)).toBe(RAW)
  })

  it('选择「保存并继续」先写盘再关闭', async () => {
    await openUnit()
    typeContent('[core]\nname: b\n')
    fireEvent.click(screen.getByLabelText('返回'))
    fireEvent.click(await screen.findByText('保存并继续'))
    await waitFor(() => expect(useWorkspace.getState().editorSession).toBeNull())
    expect(hoisted.handle!.readText(UNIT)).toBe('[core]\nname: b\n')
  })

  it('取消后可以继续编辑，再点保存直接落盘', async () => {
    await openUnit()
    typeContent('[core]\nname: c\n')
    fireEvent.click(screen.getByLabelText('返回'))
    fireEvent.click(await screen.findByText('取消'))
    // 弹层关闭，会话还在
    await waitFor(() => expect(screen.queryByText('还有未保存的修改')).toBeNull())
    expect(useWorkspace.getState().editorSession?.content).toBe('[core]\nname: c\n')
    fireEvent.click(screen.getByLabelText('保存'))
    await waitFor(() => expect(hoisted.handle!.readText(UNIT)).toBe('[core]\nname: c\n'))
  })

  it('未修改时点返回直接退出，不打扰用户', async () => {
    await openUnit()
    fireEvent.click(screen.getByLabelText('返回'))
    await waitFor(() => expect(useWorkspace.getState().editorSession).toBeNull())
    expect(screen.queryByText('还有未保存的修改')).toBeNull()
  })
})

describe('编辑器页：保存失败与冲突', () => {
  it('保存失败时留在编辑器并给出错误，内容不丢', async () => {
    await openUnit()
    typeContent('会被拒绝的内容')
    hoisted.handle!.failNextWrite('磁盘写入失败（测试注入）')
    fireEvent.click(screen.getByLabelText('保存'))
    expect(await screen.findByText('磁盘写入失败（测试注入）')).toBeTruthy()
    expect(useWorkspace.getState().editorSession?.content).toBe('会被拒绝的内容')
    expect(hoisted.handle!.readText(UNIT)).toBe(RAW)
  })

  it('保存失败时「保存并继续」不会退出编辑器', async () => {
    await openUnit()
    typeContent('会被拒绝的内容')
    hoisted.handle!.failNextWrite()
    fireEvent.click(screen.getByLabelText('返回'))
    fireEvent.click(await screen.findByText('保存并继续'))
    await waitFor(() => expect(screen.getByText(/磁盘写入失败/)).toBeTruthy())
    expect(useWorkspace.getState().editorSession).not.toBeNull()
  })

  it('磁盘被外部改动时保存先提示冲突', async () => {
    await openUnit()
    typeContent('本地修改')
    hoisted.handle!.externalEdit(UNIT, '[core]\nname: external\n')
    fireEvent.click(screen.getByLabelText('保存'))
    expect(await screen.findByText('文件已被外部修改')).toBeTruthy()
    // 未确认前不写盘
    expect(hoisted.handle!.readText(UNIT)).toBe('[core]\nname: external\n')
  })

  it('冲突时选「重新载入」用磁盘内容替换本地修改', async () => {
    await openUnit()
    typeContent('本地修改')
    hoisted.handle!.externalEdit(UNIT, '[core]\nname: external\n')
    fireEvent.click(screen.getByLabelText('保存'))
    fireEvent.click(await screen.findByText('重新载入'))
    await waitFor(() => expect(useWorkspace.getState().editorSession?.content).toBe('[core]\nname: external\n'))
    expect(useWorkspace.getState().editorSession?.content).not.toBe('本地修改')
  })

  it('冲突时选「仍然覆盖」按本地内容写盘', async () => {
    await openUnit()
    typeContent('[core]\nname: mine\n')
    hoisted.handle!.externalEdit(UNIT, '[core]\nname: external\n')
    fireEvent.click(screen.getByLabelText('保存'))
    fireEvent.click(await screen.findByText('仍然覆盖'))
    await waitFor(() => expect(hoisted.handle!.readText(UNIT)).toBe('[core]\nname: mine\n'))
  })

  it('保存成功后再次保存不再误报冲突', async () => {
    await openUnit()
    typeContent('[core]\nname: d\n')
    fireEvent.click(screen.getByLabelText('保存'))
    await waitFor(() => expect(hoisted.handle!.readText(UNIT)).toBe('[core]\nname: d\n'))
    typeContent('[core]\nname: e\n')
    fireEvent.click(screen.getByLabelText('保存'))
    await waitFor(() => expect(hoisted.handle!.readText(UNIT)).toBe('[core]\nname: e\n'))
    expect(screen.queryByText('文件已被外部修改')).toBeNull()
  })
})

describe('编辑器页：文件树操作', () => {
  it('新建文件后出现在树里，且操作菜单自动收起', async () => {
    render(<EditorScreen />)
    fireEvent.click(await screen.findByText('units'))
    fireEvent.click(await screen.findByLabelText('units 的更多操作'))
    fireEvent.click(await screen.findByText('新建文件'))
    // 菜单已收起：此时页面上只有一个 textbox（输入弹层的）
    expect(screen.queryByText('新建文件夹')).toBeNull()
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'b.ini' } })
    fireEvent.click(screen.getByText('创建'))
    expect(await screen.findByText('b.ini')).toBeTruthy()
    expect(hoisted.handle!.has(`${ROOT}/units/b.ini`)).toBe(true)
  })

  it('新建同名文件被拒绝且不覆盖', async () => {
    render(<EditorScreen />)
    fireEvent.click(await screen.findByText('units'))
    fireEvent.click(await screen.findByLabelText('units 的更多操作'))
    fireEvent.click(await screen.findByText('新建文件'))
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'a.ini' } })
    fireEvent.click(screen.getByText('创建'))
    expect(await screen.findByText('同目录下已存在同名文件或文件夹')).toBeTruthy()
    expect(hoisted.handle!.readText(UNIT)).toBe(RAW)
  })

  it('重命名文件后旧名消失、新名出现', async () => {
    render(<EditorScreen />)
    fireEvent.click(await screen.findByText('units'))
    fireEvent.click(await screen.findByLabelText('a.ini 的更多操作'))
    fireEvent.click(await screen.findByText('重命名'))
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'c.ini' } })
    // 标题也是「重命名」，必须按按钮角色定位，否则匹配到两个节点
    fireEvent.click(screen.getByRole('button', { name: '重命名' }))
    expect(await screen.findByText('c.ini')).toBeTruthy()
    await waitFor(() => expect(hoisted.handle!.has(`${ROOT}/units/a.ini`)).toBe(false))
    expect(hoisted.handle!.readText(`${ROOT}/units/c.ini`)).toBe(RAW)
  })

  it('删除文件需要确认，确认后文件消失', async () => {
    render(<EditorScreen />)
    fireEvent.click(await screen.findByText('units'))
    fireEvent.click(await screen.findByLabelText('a.ini 的更多操作'))
    fireEvent.click(await screen.findByText('删除'))
    expect(await screen.findByText('删除「a.ini」？')).toBeTruthy()
    fireEvent.click(screen.getByText('删除'))
    await waitFor(() => expect(hoisted.handle!.has(`${ROOT}/units/a.ini`)).toBe(false))
  })

  it('取消删除时文件保留', async () => {
    render(<EditorScreen />)
    fireEvent.click(await screen.findByText('units'))
    fireEvent.click(await screen.findByLabelText('a.ini 的更多操作'))
    fireEvent.click(await screen.findByText('删除'))
    fireEvent.click(await screen.findByText('取消'))
    await waitFor(() => expect(screen.queryByText('删除「a.ini」？')).toBeNull())
    expect(hoisted.handle!.has(`${ROOT}/units/a.ini`)).toBe(true)
  })
})

describe('编辑器页：中文显示层往返', () => {
  beforeEach(() => {
    useWorkspace.setState({ settings: { ...DEFAULT_SETTINGS, translateMode: true } })
  })

  it('打开显示中文、保存写回英文、界面保持中文（连续两次保存都不丢）', async () => {
    await openUnit()
    const session = useWorkspace.getState().editorSession!
    expect(session.displayMode).toBe('zh')
    expect(session.content).toContain('名称')
    expect(session.content).not.toContain('name:')

    // 第一次保存：改中文值
    typeContent(session.content.replace('名称: a', '名称: b'))
    fireEvent.click(screen.getByLabelText('保存'))
    await waitFor(() => expect(hoisted.handle!.readText(UNIT)).toBe('[core]\nname: b\n'))
    // 磁盘是英文，界面仍是中文
    expect(hoisted.handle!.readText(UNIT)).not.toContain('名称')
    await waitFor(() => expect(useWorkspace.getState().editorSession?.content).toContain('名称: b'))

    // 第二次保存：再改一次，仍不能把中文显示层换成英文
    typeContent('名称: c\n[core]\n')
    fireEvent.click(screen.getByLabelText('保存'))
    await waitFor(() => expect(hoisted.handle!.readText(UNIT)).toContain('name: c'))
    expect(useWorkspace.getState().editorSession?.content).toContain('名称: c')
    expect(useWorkspace.getState().editorSession?.content).not.toContain('name: c')
  })

  it('关闭编辑器再打开，磁盘内容仍是英文原文（没有被中文写坏）', async () => {
    await openUnit()
    typeContent('名称: z\n[core]\n')
    fireEvent.click(screen.getByLabelText('保存'))
    await waitFor(() => expect(hoisted.handle!.readText(UNIT)).toContain('name: z'))
    fireEvent.click(screen.getByLabelText('返回'))
    await waitFor(() => expect(useWorkspace.getState().editorSession).toBeNull())
    // 重新打开：文件树是重新挂载的，需要重新展开目录
    fireEvent.click(await screen.findByText('units'))
    fireEvent.click(await screen.findByText('a.ini'))
    await waitFor(() => expect(useWorkspace.getState().editorSession?.displayMode).toBe('zh'))
    expect(useWorkspace.getState().editorSession?.content).toContain('名称')
    expect(hoisted.handle!.readText(UNIT)).toContain('name: z')
  })
})

describe('编辑器页：状态提示与防重入', () => {
  it('保存后继续编辑，「已保存」提示消失（不与脏标记同时误导用户）', async () => {
    await openUnit()
    typeContent('[core]\nname: p\n')
    fireEvent.click(screen.getByLabelText('保存'))
    expect(await screen.findByText('已保存')).toBeTruthy()
    typeContent('[core]\nname: q\n')
    await waitFor(() => expect(screen.queryByText('已保存')).toBeNull())
    // 内容确实还没落盘，脏标记应当在场
    expect(hoisted.handle!.readText(UNIT)).toBe('[core]\nname: p\n')
    expect(screen.getByLabelText('有未保存的修改')).toBeTruthy()
  })

  it('连续触发保存只写一次盘（防重入，避免基准回退导致误报冲突）', async () => {
    await openUnit()
    typeContent('[core]\nname: r\n')
    const saveBtn = screen.getByLabelText('保存')
    // 模拟快捷键与按钮在同一拍内重复触发
    fireEvent.click(saveBtn)
    fireEvent.click(saveBtn)
    fireEvent.click(saveBtn)
    await waitFor(() => expect(hoisted.handle!.readText(UNIT)).toBe('[core]\nname: r\n'))
    expect(hoisted.handle!.writes).toHaveLength(1)
    expect(useWorkspace.getState().editorSession?.mtimeMs).toBeGreaterThan(1000)
  })
})
