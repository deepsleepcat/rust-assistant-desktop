/**
 * 统一打开入口的异步竞态回归：
 * 读盘/加载词典期间用户切换项目或连着点了另一个文件时，先发起的慢请求不得
 * 把旧项目的文件写进当前会话（否则界面显示的文件与当前项目/最后一次点击不一致）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createMemoryBridge, type MemoryBridgeHandle } from './fixtures/memoryBridge'
import { useWorkspace } from '../src/stores/workspace'
import { DEFAULT_SETTINGS } from '../src/utils/settings'
import { openFileInEditor } from '../src/features/editor/openFile'

const hoisted = vi.hoisted(() => ({ handle: null as MemoryBridgeHandle | null }))

vi.mock('../src/services/bridge', () => ({ getBridge: () => hoisted.handle!.bridge }))

const ROOT_A = '/app/projects/a'
const ROOT_B = '/app/projects/b'
const PROJECT_A = { id: ROOT_A, name: 'a', rootPath: ROOT_A, createdAt: 1, lastOpenedAt: 1 }
const PROJECT_B = { id: ROOT_B, name: 'b', rootPath: ROOT_B, createdAt: 1, lastOpenedAt: 1 }
const FILE_A = `${ROOT_A}/units/a.ini`
const FILE_SLOW = `${ROOT_A}/units/slow.ini`
const FILE_FAST = `${ROOT_A}/units/fast.ini`
const FILE_B = `${ROOT_B}/units/b.ini`

beforeEach(() => {
  hoisted.handle = createMemoryBridge({
    files: {
      [FILE_A]: '[core]\nname: a\n',
      [FILE_SLOW]: '[core]\nname: slow\n',
      [FILE_FAST]: '[core]\nname: fast\n',
      [FILE_B]: '[core]\nname: b\n',
    },
  })
  useWorkspace.setState({
    ready: true,
    projects: [PROJECT_A, PROJECT_B],
    activeProjectId: PROJECT_A.id,
    activeTab: 'editor',
    editorSession: null,
    editorJump: null,
    settings: { ...DEFAULT_SETTINGS, translateMode: false },
  })
})

describe('openFileInEditor 异步竞态', () => {
  it('正常打开：写入会话并带上文件内容', async () => {
    const result = await openFileInEditor({ path: FILE_A, name: 'a.ini' })
    expect(result.ok).toBe(true)
    expect(useWorkspace.getState().editorSession?.path).toBe(FILE_A)
    expect(useWorkspace.getState().editorSession?.content).toBe('[core]\nname: a\n')
  })

  it('读盘期间切换项目：丢弃旧项目的打开结果', async () => {
    const pending = openFileInEditor({ path: FILE_A, name: 'a.ini' })
    // readFile 已同步发出，此时用户切到项目 B
    useWorkspace.setState({ activeProjectId: PROJECT_B.id })
    const result = await pending
    expect(result).toMatchObject({ ok: false, cancelled: true })
    expect(useWorkspace.getState().editorSession).toBeNull()
  })

  it('连续打开两个文件：先发起的慢请求后返回也不覆盖最后一次', async () => {
    const bridge = hoisted.handle!.bridge
    const originalRead = bridge.project.readFile.bind(bridge.project)
    let releaseSlow: (() => void) | undefined
    bridge.project.readFile = async (rootPath, filePath) => {
      if (filePath === FILE_SLOW) {
        await new Promise<void>((resolve) => { releaseSlow = resolve })
      }
      return originalRead(rootPath, filePath)
    }

    const slow = openFileInEditor({ path: FILE_SLOW, name: 'slow.ini' })
    const fast = await openFileInEditor({ path: FILE_FAST, name: 'fast.ini' })
    expect(fast.ok).toBe(true)
    expect(useWorkspace.getState().editorSession?.path).toBe(FILE_FAST)

    releaseSlow!()
    const late = await slow
    expect(late).toMatchObject({ ok: false, cancelled: true })
    expect(useWorkspace.getState().editorSession?.path).toBe(FILE_FAST)
  })
})
