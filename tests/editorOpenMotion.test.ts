/**
 * 编辑器打开动效回归测试：
 * - CSS 契约：.editor-body 的入场动画只随 EditorPane 的 key=tabId 重挂载播放
 *   （即只在文件身份变化时触发），禁用路径完整（reduced-motion / 低性能模式）。
 * - Store 契约：敲字（updateTabContent）不改变 tab id（不触发重挂载/动画重播）；
 *   重复打开同一文件复用既有标签；切换标签只改 activeTabId 不增删标签。
 * 动效本身纯 CSS，无 JS 计时器，不引入人为加载延迟。
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createWorkspaceStore } from '../src/stores/workspace'
import { createMockBridge, MOCK_PROJECT_ROOT } from '../src/services/mockBridge'

const animations = readFileSync(resolve(__dirname, '../src/styles/animations.css'), 'utf8')
const desktop = readFileSync(resolve(__dirname, '../src/styles/desktop.css'), 'utf8')

describe('editor open motion CSS contract', () => {
  it('animates only the editor content body with a subtle short entrance', () => {
    // 内容级动画：短时长、小位移（≤6px），只挂在 .editor-body 上
    expect(animations).toMatch(/@keyframes ra-editor-in \{[^}]*translateY\(4px\)[^}]*\}/)
    expect(animations).toMatch(/\.editor-body \{ animation: ra-editor-in 0\.14s ease-out backwards; \}/)
    // 动画结束后不留 transform：不给 CodeMirror / 阅读遮罩引入常驻 stacking context
    expect(animations).not.toMatch(/\.editor-body \{[^}]*fill-mode: both/)
    expect(animations).not.toMatch(/\.editor-body \{[^}]*both; \}/)
  })

  it('animates the editor body only (head chrome stays stable)', () => {
    expect(animations).not.toMatch(/\.editor-head \{ animation:/)
    expect(animations).not.toMatch(/\.editor-workspace \{ animation:/)
    expect(animations).not.toMatch(/\.tabbar \{ animation:/)
  })

  it('disables the entrance under low-performance mode', () => {
    expect(animations).toContain('body.ra-low-performance .editor-body { animation: none; }')
  })

  it('is covered by the reduced-motion opt-outs', () => {
    // animations.css 的系统级 prefers-reduced-motion 降级块 + desktop.css 的设置级 ra-reduced-motion 通配
    const reduceBlock = animations.slice(animations.indexOf('@media (prefers-reduced-motion: reduce)'))
    expect(reduceBlock).toContain('.editor-body { animation: none; }')
    expect(desktop).toMatch(/body\.ra-reduced-motion \*,[\s\S]{0,80}animation-duration: \.01ms !important/)
  })
})

describe('editor open motion store contract', () => {
  let store: ReturnType<typeof createWorkspaceStore>

  beforeEach(() => {
    store = createWorkspaceStore(createMockBridge())
  })

  it('typing keeps tab identity so the entrance never replays on keystrokes', async () => {
    await store.getState().init()
    await store.getState().openProject()
    await store.getState().openFile(`${MOCK_PROJECT_ROOT}\\units\\rifle.txt`)
    const tabId = store.getState().activeTabId!
    store.getState().updateTabContent(tabId, store.getState().openTabs[0].content + '\n# a')
    store.getState().updateTabContent(tabId, store.getState().openTabs[0].content + '\n# b')
    // id 不变 → EditorPane 的 key 不变 → 不重挂载 CodeMirror、不重播动画
    expect(store.getState().activeTabId).toBe(tabId)
    expect(store.getState().openTabs).toHaveLength(1)
  })

  it('reopening the same file reuses the existing tab instead of remounting', async () => {
    await store.getState().init()
    await store.getState().openProject()
    await store.getState().openFile(`${MOCK_PROJECT_ROOT}\\units\\rifle.txt`)
    const firstId = store.getState().activeTabId!
    await store.getState().openFile(`${MOCK_PROJECT_ROOT}\\units\\rifle.txt`)
    expect(store.getState().activeTabId).toBe(firstId)
    expect(store.getState().openTabs).toHaveLength(1)
  })

  it('switching tabs only changes activeTabId (one remount per file identity)', async () => {
    await store.getState().init()
    await store.getState().openProject()
    await store.getState().openFile(`${MOCK_PROJECT_ROOT}\\units\\rifle.txt`)
    const a = store.getState().activeTabId!
    await store.getState().openFile(`${MOCK_PROJECT_ROOT}\\units\\tank.txt`)
    const b = store.getState().activeTabId!
    expect(a).not.toBe(b)
    expect(store.getState().openTabs).toHaveLength(2)
    store.getState().setActiveTabId(a)
    expect(store.getState().activeTabId).toBe(a)
    expect(store.getState().openTabs).toHaveLength(2)
  })
})
