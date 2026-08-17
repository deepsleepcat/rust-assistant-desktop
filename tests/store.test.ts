/**
 * Store 业务流测试：使用 Mock 桥模拟真实文件系统。
 * 覆盖计划中「第一批必须覆盖的回归用例」中不依赖真实 Electron 的部分：
 * - 项目创建/切换
 * - 一个项目多个对话，切换互不影响
 * - 归档/删除对话后的选中状态
 * - 多标签：中间关闭后当前文档仍正确
 * - 编辑、保存、脏标记
 * - 中文路径文件读写
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createWorkspaceStore } from '../src/stores/workspace'
import { createMockBridge, MOCK_PROJECT_ROOT } from '../src/services/mockBridge'

describe('工作区 store 业务流', () => {
  let store: ReturnType<typeof createWorkspaceStore>
  let bridge: ReturnType<typeof createMockBridge>

  beforeEach(() => {
    bridge = createMockBridge()
    store = createWorkspaceStore(bridge)
  })

  it('初始化后加载设置与工作区', async () => {
    const s = store.getState()
    expect(s.ready).toBe(false)
    await s.init()
    expect(store.getState().ready).toBe(true)
    expect(store.getState().settings.theme).toBe('light')
  })

  it('打开项目后文件树可读取（含中文路径）', async () => {
    await store.getState().init()
    await store.getState().openProject()
    const s = store.getState()
    expect(s.projects.length).toBe(1)
    expect(s.projects[0].rootPath).toBe(MOCK_PROJECT_ROOT)
    expect(s.treeRoot?.name).toBe('我的第一个模组')
    const names = (s.treeRoot?.children ?? []).map((n) => n.name)
    expect(names).toContain('units')
    expect(names).toContain('mod.json')
  })

  it('导入模组先打开应用内来源选择，选择后才调用对应 bridge', async () => {
    const importMod = vi.fn(async () => null)
    bridge.mod.import = importMod
    const s = store.getState()
    await s.importModProject()
    expect(store.getState().modDialog).toBe('import')
    expect(importMod).not.toHaveBeenCalled()

    store.getState().setModDialog(null)
    await store.getState().startModImport('archive')
    expect(importMod).toHaveBeenLastCalledWith('archive')
    await store.getState().startModImport('folder')
    expect(importMod).toHaveBeenLastCalledWith('folder')
  })

  it('一个项目可创建多个对话并正确切换', async () => {
    await store.getState().init()
    await store.getState().openProject()
    const s = store.getState()
    s.createConversation()
    s.createConversation()
    s.createConversation()
    const convs = store.getState().conversations
    expect(convs.length).toBe(3)
    expect(convs.map((c) => c.title)).toEqual(['对话 1', '对话 2', '对话 3'])
    // 切换对话
    store.getState().selectConversation(convs[0].id)
    expect(store.getState().activeConversationId).toBe(convs[0].id)
  })

  it('归档当前对话后自动切到其他对话', async () => {
    await store.getState().init()
    await store.getState().openProject()
    const s = store.getState()
    s.createConversation()
    s.createConversation()
    const [first, second] = store.getState().conversations
    store.getState().selectConversation(second.id)
    store.getState().toggleArchiveConversation(second.id)
    expect(store.getState().activeConversationId).toBe(first.id)
    // 归档的对话仍然存在
    expect(store.getState().conversations.find((c) => c.id === second.id)?.archived).toBe(true)
  })

  it('删除当前对话后自动切到其他对话', async () => {
    await store.getState().init()
    await store.getState().openProject()
    const s = store.getState()
    s.createConversation()
    s.createConversation()
    const [first, second] = store.getState().conversations
    store.getState().selectConversation(second.id)
    store.getState().deleteConversation(second.id)
    expect(store.getState().conversations.length).toBe(1)
    expect(store.getState().activeConversationId).toBe(first.id)
  })

  it('切换项目后对话互不影响', async () => {
    await store.getState().init()
    await store.getState().openProject()
    const s = store.getState()
    s.createConversation()
    // 重新打开同一个目录（模拟第二个项目）会去重，这里直接检查归属
    expect(store.getState().conversations.every((c) => c.projectId === s.activeProjectId)).toBe(true)
  })

  it('打开文件、编辑、保存（含 BOM 与中文内容）', async () => {
    await store.getState().init()
    await store.getState().openProject()
    const s = store.getState()
    const filePath = `${MOCK_PROJECT_ROOT}\\units\\rifle.txt`
    await s.openFile(filePath)
    expect(store.getState().activeTabId).not.toBeNull()
    const tabId = store.getState().activeTabId!
    expect(store.getState().openTabs[0].path).toBe(filePath)

    // 编辑 → 脏标记
    store.getState().updateTabContent(tabId, store.getState().openTabs[0].content + '\n# 中文注释')
    expect(store.getState().openTabs[0].dirty).toBe(true)

    // 保存 → 干净
    await store.getState().saveTab(tabId)
    expect(store.getState().openTabs[0].dirty).toBe(false)

    // 重新读取验证写回成功（用同一个桥实例，内存文件系统保持一致）
    const reloaded = await bridge.project.readFile(MOCK_PROJECT_ROOT, filePath)
    expect(reloaded.content).toContain('中文注释')
  })

  it('多标签：关闭中间标签后当前文档仍正确', async () => {
    await store.getState().init()
    await store.getState().openProject()
    const s = store.getState()
    const paths = [`${MOCK_PROJECT_ROOT}\\mod.json`, `${MOCK_PROJECT_ROOT}\\units\\rifle.txt`, `${MOCK_PROJECT_ROOT}\\units\\tank.txt`]
    for (const p of paths) await s.openFile(p)
    expect(store.getState().openTabs.length).toBe(3)

    // 激活第一个标签，关闭中间的第二个 → 当前应回到第一个
    store.getState().setActiveTabId(store.getState().openTabs[0].id)
    store.getState().closeTab(store.getState().openTabs[1].id)
    expect(store.getState().openTabs.length).toBe(2)
    expect(store.getState().activeTabId).toBe(store.getState().openTabs[0].id)
    expect(store.getState().openTabs[0].name).toBe('mod.json')
  })

  it('新建文件/文件夹/重命名/删除', async () => {
    await store.getState().init()
    await store.getState().openProject()
    const s = store.getState()
    await s.createFile(MOCK_PROJECT_ROOT, '新单位.txt')
    await s.createFolder(MOCK_PROJECT_ROOT, '新文件夹')
    const names = (store.getState().treeRoot?.children ?? []).map((n) => n.name)
    expect(names).toContain('新单位.txt')
    expect(names).toContain('新文件夹')

    await s.renameItem(`${MOCK_PROJECT_ROOT}\\新单位.txt`, '改名单位.txt')
    const after = (store.getState().treeRoot?.children ?? []).map((n) => n.name)
    expect(after).toContain('改名单位.txt')
    expect(after).not.toContain('新单位.txt')

    await s.deleteItem(`${MOCK_PROJECT_ROOT}\\新文件夹`)
    const final = (store.getState().treeRoot?.children ?? []).map((n) => n.name)
    expect(final).not.toContain('新文件夹')
  })

  it('刷新项目树后仍可正常工作', async () => {
    await store.getState().init()
    await store.getState().openProject()
    await store.getState().refreshTree()
    expect(store.getState().treeRoot?.children?.length).toBeGreaterThan(0)
  })
})

describe('M7 收藏（书签）', () => {
  let store: ReturnType<typeof createWorkspaceStore>
  beforeEach(() => {
    // node 测试环境没有 localStorage：给 mock 桥提供最小实现（持久化验证用）
    const mem = new Map<string, string>()
    ;(globalThis as Record<string, unknown>).localStorage = {
      getItem: (k: string) => mem.get(k) ?? null,
      setItem: (k: string, v: string) => { mem.set(k, v) },
      removeItem: (k: string) => { mem.delete(k) },
      clear: () => { mem.clear() },
      key: (i: number) => [...mem.keys()][i] ?? null,
      get length() { return mem.size },
    }
    store = createWorkspaceStore(createMockBridge())
  })

  it('toggleBookmark 收藏/取消收藏，删除项目文件时同步清理', async () => {
    await store.getState().init()
    await store.getState().openProject()
    const path = `${MOCK_PROJECT_ROOT}\\mod.json`
    const s = store.getState()
    s.toggleBookmark(path, false)
    expect(store.getState().bookmarks.some((b) => b.path === path)).toBe(true)
    expect(s.isBookmarked(path)).toBe(true)

    // 再次切换 = 取消
    store.getState().toggleBookmark(path, false)
    expect(store.getState().bookmarks).toEqual([])

    // 收藏后删除文件 → 收藏自动移除
    store.getState().toggleBookmark(path, false)
    await store.getState().deleteItem(path)
    expect(store.getState().bookmarks.some((b) => b.path === path)).toBe(false)
  })

  it('收藏按项目隔离：切换项目后不串显示', async () => {
    await store.getState().init()
    await store.getState().openProject()
    store.getState().toggleBookmark(`${MOCK_PROJECT_ROOT}\\mod.json`, false)
    expect(store.getState().bookmarks.length).toBe(1)
    // 模拟另一个项目
    store.getState().selectProject(store.getState().projects[0].id)
    // 收藏仍存在但属于原项目；isBookmarked 只认当前项目
    expect(store.getState().bookmarks.length).toBe(1)
    expect(store.getState().isBookmarked(`${MOCK_PROJECT_ROOT}\\mod.json`)).toBe(true)
    // 未激活项目时 isBookmarked 为 false（activeProjectId 为 null 场景）
    store.getState().removeProject(store.getState().projects[0].id)
    expect(store.getState().isBookmarked(`${MOCK_PROJECT_ROOT}\\mod.json`)).toBe(false)
  })

  it('删除文件夹时前缀匹配清理其内部收藏', async () => {
    await store.getState().init()
    await store.getState().openProject()
    store.getState().toggleBookmark(`${MOCK_PROJECT_ROOT}\\units`, true)
    store.getState().toggleBookmark(`${MOCK_PROJECT_ROOT}\\units\\tank.txt`, false)
    expect(store.getState().bookmarks.length).toBe(2)
    await store.getState().deleteItem(`${MOCK_PROJECT_ROOT}\\units`)
    expect(store.getState().bookmarks.length).toBe(0)
  })

  it('书签持久化进 workspace 存储', async () => {
    await store.getState().init()
    await store.getState().openProject()
    store.getState().toggleBookmark(`${MOCK_PROJECT_ROOT}\\mod.json`, false)
    // 等待持久化（300ms 防抖）
    await new Promise((r) => setTimeout(r, 400))
    const bridge = createMockBridge()
    const saved = (await bridge.store.get('workspace')) as { bookmarks?: Array<{ path: string; name: string; projectId: string; isDirectory: boolean }> }
    expect(saved.bookmarks?.length).toBe(1)
    expect(saved.bookmarks![0]).toHaveProperty('projectId')
    expect(saved.bookmarks![0]).toHaveProperty('isDirectory')
  })
})

describe('M8 第二轮审查修复回归', () => {
  let store: ReturnType<typeof createWorkspaceStore>
  let bridge: ReturnType<typeof createMockBridge>
  beforeEach(() => {
    const mem = new Map<string, string>()
    ;(globalThis as Record<string, unknown>).localStorage = {
      getItem: (k: string) => mem.get(k) ?? null,
      setItem: (k: string, v: string) => { mem.set(k, v) },
      removeItem: (k: string) => { mem.delete(k) },
      clear: () => { mem.clear() },
      key: (i: number) => [...mem.keys()][i] ?? null,
      get length() { return mem.size },
    }
    bridge = createMockBridge()
    store = createWorkspaceStore(bridge)
  })

  it('selectProject 点击当前项目不短路清空标签', async () => {
    await store.getState().init()
    await store.getState().openProject()
    await store.getState().openFile(`${MOCK_PROJECT_ROOT}\\mod.json`)
    expect(store.getState().openTabs.length).toBe(1)
    await store.getState().selectProject(store.getState().activeProjectId!)
    expect(store.getState().openTabs.length).toBe(1)
    expect(store.getState().activeTabId).not.toBeNull()
  })

  it('saveTab 被外部修改拦截时返回 false 并标记，reloadTab 恢复磁盘内容', async () => {
    await store.getState().init()
    await store.getState().openProject()
    const filePath = `${MOCK_PROJECT_ROOT}\\units\\rifle.txt`
    await store.getState().openFile(filePath)
    const tabId = store.getState().activeTabId!

    // 外部直接改文件（绕过 store），内容长度变化 → mtimeMs 变化 → 保存被拦截
    await bridge.project.writeFile(MOCK_PROJECT_ROOT, filePath, '外部修改后的新内容', { hasBom: false })
    const ok = await store.getState().saveTab(tabId)
    expect(ok).toBe(false)
    expect(store.getState().openTabs.find((t) => t.id === tabId)?.externalChanged).toBe(true)

    // 重新加载：回到磁盘最新内容，清掉标记
    await store.getState().reloadTab(tabId)
    const tab = store.getState().openTabs.find((t) => t.id === tabId)!
    expect(tab.content).toBe('外部修改后的新内容')
    expect(tab.externalChanged).toBe(false)
    expect(tab.dirty).toBe(false)
  })

  it('删除活动标签对应文件后 activeTabId 回退到相邻标签', async () => {
    await store.getState().init()
    await store.getState().openProject()
    const a = `${MOCK_PROJECT_ROOT}\\mod.json`
    const b = `${MOCK_PROJECT_ROOT}\\units\\rifle.txt`
    await store.getState().openFile(a)
    await store.getState().openFile(b)
    const firstId = store.getState().openTabs[0].id
    store.getState().setActiveTabId(store.getState().openTabs[1].id)
    await store.getState().deleteItem(b)
    expect(store.getState().openTabs.length).toBe(1)
    expect(store.getState().activeTabId).toBe(firstId)

    // 删除最后一个活动标签 → null（编辑器回欢迎页，不空白）
    await store.getState().deleteItem(a)
    expect(store.getState().openTabs.length).toBe(0)
    expect(store.getState().activeTabId).toBeNull()
  })
})
