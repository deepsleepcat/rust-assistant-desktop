// @vitest-environment jsdom
/**
 * 项目页交互测试（真实组件 + 内存桥）。
 * 覆盖：新建项目、重名拒绝、删除确认、（删除时）关闭对应编辑会话、打包结果提示。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createMemoryBridge, type MemoryBridgeHandle } from './fixtures/memoryBridge'
import { useWorkspace } from '../src/stores/workspace'
import { DEFAULT_SETTINGS } from '../src/utils/settings'
import { ProjectsScreen } from '../src/screens/ProjectsScreen'
import { createSession } from '../src/features/editor/editSession'
import { makeDict } from '../src/services/translation'

const hoisted = vi.hoisted(() => ({
  handle: null as MemoryBridgeHandle | null,
  deleted: [] as string[],
  createdDirs: [] as string[],
}))

vi.mock('../src/services/bridge', () => ({
  getBridge: () => hoisted.handle!.bridge,
  appPath: async (...parts: string[]) => ['/app', ...parts].join('/'),
  uniqueProjectDir: async (name: string) => {
    const dir = `/app/projects/${name}`
    hoisted.createdDirs.push(dir)
    return dir
  },
  deleteProject: async (rootPath: string) => {
    hoisted.deleted.push(rootPath)
  },
  importMod: async () => null,
  writeProjectBinary: async () => {},
}))

vi.mock('../src/features/editor/completion', () => ({
  invalidateResourceCache: () => {},
  rustCompletionSource: () => null,
  setCompletionChineseMode: () => {},
  setCompletionTracker: () => {},
}))

const ROOT = '/app/projects/demo'
const EXISTING = { id: ROOT, name: 'demo', rootPath: ROOT, createdAt: 1, lastOpenedAt: 1 }

beforeEach(() => {
  hoisted.deleted = []
  hoisted.createdDirs = []
  hoisted.handle = createMemoryBridge({
    dirs: [ROOT],
    files: { [`${ROOT}/mod-info.txt`]: '[mod]\ntitle: demo\n' },
  })
  useWorkspace.setState({
    ready: true,
    projects: [],
    activeProjectId: null,
    activeTab: 'projects',
    editorSession: null,
    editorJump: null,
    settings: { ...DEFAULT_SETTINGS, translateMode: false },
  })
})

afterEach(() => {
  cleanup()
})

describe('项目页：空状态与新建', () => {
  it('没有项目时给出新建、导入、示例项目三个入口', () => {
    render(<ProjectsScreen />)
    expect(screen.getByText('新建项目')).toBeTruthy()
    expect(screen.getByText('导入模组')).toBeTruthy()
    expect(screen.getByText('创建示例项目')).toBeTruthy()
  })

  it('新建项目写入最小 mod-info.txt 并登记到列表', async () => {
    render(<ProjectsScreen />)
    fireEvent.click(screen.getByText('新建项目'))
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '我的模组' } })
    fireEvent.click(screen.getByText('创建'))
    await waitFor(() => expect(useWorkspace.getState().projects).toHaveLength(1))
    expect(useWorkspace.getState().projects[0].name).toBe('我的模组')
    expect(hoisted.handle!.readText('/app/projects/我的模组/mod-info.txt')).toContain('title: 我的模组')
    // 创建后直接进入编辑器
    expect(useWorkspace.getState().activeTab).toBe('editor')
  })

  it('名称非法或与已有项目重名时给出错误且不创建', async () => {
    useWorkspace.setState({ projects: [EXISTING] })
    render(<ProjectsScreen />)
    fireEvent.click(screen.getByText('新建'))
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'demo' } })
    fireEvent.click(screen.getByText('创建'))
    expect(await screen.findByText('同目录下已存在同名文件或文件夹')).toBeTruthy()
    expect(useWorkspace.getState().projects).toHaveLength(1)
  })

  it('名称为空时不提交', async () => {
    render(<ProjectsScreen />)
    fireEvent.click(screen.getByText('新建项目'))
    fireEvent.click(screen.getByText('创建'))
    expect(await screen.findByText('不能为空')).toBeTruthy()
    expect(useWorkspace.getState().projects).toHaveLength(0)
  })
})

describe('项目页：删除', () => {
  it('删除需要二次确认，确认后从列表移除并调用删除', async () => {
    useWorkspace.setState({ projects: [EXISTING], activeProjectId: ROOT })
    render(<ProjectsScreen />)
    fireEvent.click(screen.getByLabelText('删除 demo'))
    expect(await screen.findByText('删除项目「demo」？')).toBeTruthy()
    fireEvent.click(screen.getByText('删除'))
    await waitFor(() => expect(useWorkspace.getState().projects).toHaveLength(0))
    expect(hoisted.deleted).toEqual([ROOT])
  })

  it('取消确认时项目与目录都不动', async () => {
    useWorkspace.setState({ projects: [EXISTING], activeProjectId: ROOT })
    render(<ProjectsScreen />)
    fireEvent.click(screen.getByLabelText('删除 demo'))
    fireEvent.click(await screen.findByText('取消'))
    await waitFor(() => expect(screen.queryByText('删除项目「demo」？')).toBeNull())
    expect(useWorkspace.getState().projects).toHaveLength(1)
    expect(hoisted.deleted).toEqual([])
  })

  it('删除正在编辑的项目时关闭编辑会话（避免会话指向已删除文件）', async () => {
    const session = createSession({
      projectId: ROOT,
      rootPath: ROOT,
      path: `${ROOT}/units/a.ini`,
      name: 'a.ini',
      raw: '[core]\nname: a\n',
      hasBom: false,
      mtimeMs: 1,
      chineseMode: false,
      dict: makeDict(new Map(), new Map()),
    })
    useWorkspace.setState({ projects: [EXISTING], activeProjectId: ROOT, editorSession: session })
    render(<ProjectsScreen />)
    fireEvent.click(screen.getByLabelText('删除 demo'))
    fireEvent.click(await screen.findByText('删除'))
    await waitFor(() => expect(useWorkspace.getState().editorSession).toBeNull())
  })

  it('有未保存修改时删除提示里明确警告', async () => {
    const session = createSession({
      projectId: ROOT,
      rootPath: ROOT,
      path: `${ROOT}/units/a.ini`,
      name: 'a.ini',
      raw: '[core]\nname: a\n',
      hasBom: false,
      mtimeMs: 1,
      chineseMode: false,
      dict: makeDict(new Map(), new Map()),
    })
    const dirty = { ...session, content: '改过了' }
    useWorkspace.setState({ projects: [EXISTING], activeProjectId: ROOT, editorSession: dirty })
    render(<ProjectsScreen />)
    fireEvent.click(screen.getByLabelText('删除 demo'))
    expect(await screen.findByText(/未保存的编辑内容/)).toBeTruthy()
  })
})

describe('项目页：打包', () => {
  it('打包完成给出结果提示', async () => {
    useWorkspace.setState({ projects: [EXISTING], activeProjectId: ROOT })
    render(<ProjectsScreen />)
    fireEvent.click(screen.getByLabelText('打包导出 demo'))
    expect(await screen.findByText('导出完成')).toBeTruthy()
    expect(screen.getByText(/打包完成：3 个文件/)).toBeTruthy()
  })
})
