// @vitest-environment jsdom
/**
 * 单位表单面板测试（真实组件 + 内存桥）。
 *
 * 覆盖「页面编排」而不是纯函数（纯函数在 unitForm.test.ts）：
 * - 编辑器入口：只有单位文件显示「单位表单」按钮；
 * - 表单编辑实时同步进编辑会话（非法值不写回）；
 * - 枚举下拉写回、资源选择器空态；
 * - 返回键/返回按钮先关表单，不误退出编辑器；
 * - 中文显示层下写回保持文件原有键名语言。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createMemoryBridge, type MemoryBridgeHandle } from './fixtures/memoryBridge'
import { useWorkspace } from '../src/stores/workspace'
import { DEFAULT_SETTINGS } from '../src/utils/settings'
import { EditorScreen } from '../src/screens/EditorScreen'
import { openFileInEditor } from '../src/features/editor/openFile'

const hoisted = vi.hoisted(() => ({ handle: null as MemoryBridgeHandle | null }))

vi.mock('../src/services/bridge', () => ({
  getBridge: () => hoisted.handle!.bridge,
  appPath: async (...parts: string[]) => ['/app', ...parts].join('/'),
  uniqueProjectDir: async (name: string) => `/app/projects/${name}`,
  deleteProject: async () => {},
  importMod: async () => null,
  writeProjectBinary: async () => {},
}))

// 词典只给最小命中集：名称↔name、核心↔core（中文显示层用例要真能回译）
vi.mock('../src/services/codeData', () => ({
  loadCodeData: async () => {},
  getEnToZhDict: () => new Map([['name', '名称']]),
  getZhToEnDict: () => new Map([['名称', 'name']]),
  getKeyZhToEnDict: () => new Map([['名称', 'name']]),
  getSectionZhToEnDict: () => new Map([['核心', 'core']]),
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
const RAW = `[core]\nname: myTank\nprice: 300\nmaxHp: 500\n\n[graphics]\nimage: tank.png\n\n[movement]\nmovementType: LAND\n`
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

/** 直接经统一入口打开单位文件（文件树交互不在本测试范围） */
async function openUnit() {
  render(<EditorScreen />)
  const result = await openFileInEditor({ path: UNIT })
  expect(result.ok).toBe(true)
  await screen.findByText('a.ini')
}

describe('单位表单：编辑器入口', () => {
  it('单位文件显示「单位表单」按钮，打开后关闭回到代码视图', async () => {
    await openUnit()
    fireEvent.click(screen.getByLabelText('单位表单'))
    expect(await screen.findByText(/单位表单 · a\.ini/)).toBeTruthy()
    fireEvent.click(screen.getByLabelText('返回编辑器'))
    await waitFor(() => expect(screen.queryByText(/单位表单 · a\.ini/)).toBeNull())
    // 会话还在（没有误退出编辑器）
    expect(useWorkspace.getState().editorSession?.path).toBe(UNIT)
  })

  it('非单位文件（mod-info.txt）不显示入口按钮', async () => {
    render(<EditorScreen />)
    await openFileInEditor({ path: `${ROOT}/mod-info.txt` })
    await screen.findByText('mod-info.txt')
    expect(screen.queryByLabelText('单位表单')).toBeNull()
  })
})

describe('单位表单：编辑与写回', () => {
  it('分组渲染字段，值来自文件内容', async () => {
    await openUnit()
    fireEvent.click(screen.getByLabelText('单位表单'))
    expect(await screen.findByText('单位名（唯一标识）')).toBeTruthy()
    expect(screen.getByDisplayValue('myTank')).toBeTruthy()
    expect(screen.getByDisplayValue('300')).toBeTruthy()
    expect(screen.getByDisplayValue('tank.png')).toBeTruthy()
  })

  it('改数字字段实时同步进会话（尚未写盘）', async () => {
    await openUnit()
    fireEvent.click(screen.getByLabelText('单位表单'))
    fireEvent.change(screen.getByDisplayValue('300'), { target: { value: '400' } })
    await waitFor(() => expect(useWorkspace.getState().editorSession?.content).toContain('price: 400'))
    // 没有落盘：保存仍由编辑器负责
    expect(hoisted.handle!.readText(UNIT)).toBe(RAW)
  })

  it('非法值不写回，显示错误提示', async () => {
    await openUnit()
    fireEvent.click(screen.getByLabelText('单位表单'))
    fireEvent.change(screen.getByDisplayValue('500'), { target: { value: '0' } })
    expect(await screen.findByText('不能小于 1')).toBeTruthy()
    expect(useWorkspace.getState().editorSession?.content).toContain('maxHp: 500')
  })

  it('枚举字段用下拉选择，写回选中的值', async () => {
    await openUnit()
    fireEvent.click(screen.getByLabelText('单位表单'))
    // getByDisplayValue 对 select 匹配的是选中 option 的文本（k · 中文标签）
    const select = screen.getByDisplayValue('LAND · 陆地') as HTMLSelectElement
    fireEvent.change(select, { target: { value: 'WATER' } })
    await waitFor(() => expect(useWorkspace.getState().editorSession?.content).toContain('movementType: WATER'))
  })

  it('资源选择器无匹配资源时给出空态提示', async () => {
    await openUnit()
    fireEvent.click(screen.getByLabelText('单位表单'))
    // 图形组有多个资源字段，第一个「选择…」是单位图片
    fireEvent.click(screen.getAllByText('选择…')[0])
    expect(await screen.findByText('项目内没有匹配的资源文件')).toBeTruthy()
  })

  it('缺少必填字段时打开面板即提示', async () => {
    await openUnit()
    act(() => {
      useWorkspace.getState().updateEditorContent('[core]\nname: myTank\n')
    })
    fireEvent.click(screen.getByLabelText('单位表单'))
    expect(await screen.findByText(/缺少必填字段/)).toBeTruthy()
  })
})

describe('单位表单：返回键接管', () => {
  it('面板开着时触发返回（popstate）只关表单，不退编辑器', async () => {
    await openUnit()
    fireEvent.click(screen.getByLabelText('单位表单'))
    await screen.findByText(/单位表单 · a\.ini/)
    act(() => {
      window.dispatchEvent(new PopStateEvent('popstate'))
    })
    await waitFor(() => expect(screen.queryByText(/单位表单 · a\.ini/)).toBeNull())
    expect(useWorkspace.getState().editorSession?.path).toBe(UNIT)
  })
})

describe('单位表单：中文显示层', () => {
  beforeEach(() => {
    useWorkspace.setState({ settings: { ...DEFAULT_SETTINGS, translateMode: true } })
  })

  it('中文键按表单渲染，修改后写回保持中文键名', async () => {
    await openUnit()
    // 中文显示层：name → 名称（词典 mock 提供）
    await waitFor(() => expect(useWorkspace.getState().editorSession?.content).toContain('名称: myTank'))
    fireEvent.click(screen.getByLabelText('单位表单'))
    const input = await screen.findByDisplayValue('myTank')
    fireEvent.change(input, { target: { value: 'myTank2' } })
    await waitFor(() => expect(useWorkspace.getState().editorSession?.content).toContain('名称: myTank2'))
    // 写回后仍是中文键（不是 name: myTank2）
    expect(useWorkspace.getState().editorSession?.content).not.toContain('name: myTank2')
  })
})
