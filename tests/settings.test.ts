import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, clamp, sanitizeSettings } from '../src/utils/settings'
import { DEFAULT_COMMUNITY_ENDPOINT } from '../src/services/communityApi'
import type { AppSettings } from '../src/types/domain'
import { createWorkspaceStore } from '../src/stores/workspace'
import { createMockBridge } from '../src/services/mockBridge'

describe('设置清洗', () => {
  it('空输入返回默认设置', () => {
    expect(sanitizeSettings(null)).toEqual(DEFAULT_SETTINGS)
    expect(sanitizeSettings({})).toEqual(DEFAULT_SETTINGS)
  })

  it('数字被限制在合法范围', () => {
    const s = sanitizeSettings({ leftWidth: 5, rightWidth: 9999, fontSize: 99, background: { opacity: 150, blur: -5 } })
    expect(s.leftWidth).toBe(180)
    expect(s.rightWidth).toBe(760)
    expect(s.fontSize).toBe(20)
    expect(s.background.opacity).toBe(100)
    expect(s.background.blur).toBe(0)
  })

  it('非法主题和背景类型回退默认值', () => {
    const s = sanitizeSettings({ theme: 'neon', background: { kind: 'weird' } })
    expect(s.theme).toBe('light')
    expect(s.background.kind).toBe('none')
  })

  it('合法主题值被保留（light/dark/system）', () => {
    expect(sanitizeSettings({ theme: 'dark' }).theme).toBe('dark')
    expect(sanitizeSettings({ theme: 'system' }).theme).toBe('system')
    expect(sanitizeSettings({ theme: 'light' }).theme).toBe('light')
  })

  it('非法颜色回退默认值', () => {
    const s = sanitizeSettings({ background: { color: 'red; x' } })
    expect(s.background.color).toBe(DEFAULT_SETTINGS.background.color)
  })

  it('旧配置及损坏的编辑器颜色配置默认跟随主题', () => {
    expect(sanitizeSettings({ fontSize: 16 }).editorColors).toEqual({})
    for (const editorColors of [undefined, null, 'red', 42, ['#123456']]) {
      expect(sanitizeSettings({ editorColors }).editorColors).toEqual({})
    }
  })

  it('仅保留七类白名单颜色，接受大小写六位十六进制', () => {
    const colors = { text: '#123456', label: '#aBcDeF', comment: '#888888', section: '#ABCDEF', key: '#333333', animation: '#7a3e00', graphic: '#3d5a80' }
    expect(sanitizeSettings({ editorColors: { ...colors, background: '#ffffff', '--text-primary': '#000000' } }).editorColors).toEqual(colors)
    for (const value of ['red', '#123', '#12345678', ' #123456', '#123456;', 'var(--text-primary)', 123456, null]) {
      expect(sanitizeSettings({ editorColors: { text: value, label: '#ABCDEF' } }).editorColors).toEqual({ label: '#ABCDEF' })
    }
    expect(sanitizeSettings({ editorColors: Object.create({ text: '#123456' }) }).editorColors).toEqual({})
  })

  it('颜色覆盖通过设置存储持久化，单项及全部恢复后继续跟随主题', async () => {
    const bridge = createMockBridge()
    const saved = new Map<string, unknown>()
    bridge.store.get = async (key) => saved.get(key) ?? null
    bridge.store.set = async (key, value) => { saved.set(key, JSON.parse(JSON.stringify(value))) }
    const store = createWorkspaceStore(bridge)
    await store.getState().init()
    const colors = { text: '#123456', label: '#123456', comment: '#123456', section: '#123456', key: '#123456', animation: '#123456', graphic: '#123456' }
    store.getState().updateSettings({ editorColors: colors })
    await store.getState().flushPersist()
    const restored = createWorkspaceStore(bridge)
    await restored.getState().init()
    expect(restored.getState().settings.editorColors).toEqual(colors)
    restored.getState().updateSettings({ theme: 'dark' })
    expect(restored.getState().settings.editorColors).toEqual(colors)
    const singleReset = { ...restored.getState().settings.editorColors }
    delete singleReset.label
    restored.getState().updateSettings({ editorColors: singleReset })
    await restored.getState().flushPersist()
    expect((saved.get('settings') as AppSettings).editorColors).toEqual(singleReset)
    expect(singleReset.label).toBeUndefined()
    expect(singleReset.key).toBe('#123456')
    restored.getState().updateSettings({ editorColors: {} })
    await restored.getState().flushPersist()
    const reset = createWorkspaceStore(bridge)
    await reset.getState().init()
    expect(reset.getState().settings.editorColors).toEqual({})
  })

  it('合法值被保留', () => {
    const input: Partial<AppSettings> = { theme: 'dark', fontSize: 16, leftWidth: 300, rightWidth: 400 }
    const s = sanitizeSettings(input)
    expect(s.theme).toBe('dark')
    expect(s.fontSize).toBe(16)
    expect(s.leftWidth).toBe(300)
    expect(s.rightWidth).toBe(400)
  })

  it('M6 鼠标特效字段：默认关闭、强度限制在 1-3、颜色默认黑', () => {
    expect(DEFAULT_SETTINGS.cursorEffect).toBe(false)
    expect(DEFAULT_SETTINGS.cursorEffectIntensity).toBe(1)
    expect(DEFAULT_SETTINGS.cursorEffectColor).toBe('#000000')
    const s = sanitizeSettings({ cursorEffect: true, cursorEffectIntensity: 9, cursorEffectColor: '#FFB7C5' })
    expect(s.cursorEffect).toBe(true)
    expect(s.cursorEffectIntensity).toBe(3)
    expect(s.cursorEffectColor).toBe('#FFB7C5')
    const off = sanitizeSettings({ cursorEffect: 'yes' as never, cursorEffectIntensity: 0, cursorEffectColor: 'red; x' })
    expect(off.cursorEffect).toBe(false)
    expect(off.cursorEffectIntensity).toBe(1)
    expect(off.cursorEffectColor).toBe('#000000')
  })

  it('clamp 正确处理 NaN 与边界', () => {
    expect(clamp(Number.NaN, 1, 10)).toBe(1)
    expect(clamp(0, 1, 10)).toBe(1)
    expect(clamp(42, 1, 10)).toBe(10)
    expect(clamp(7, 1, 10)).toBe(7)
  })

  it('M29 布局字段：比例夹紧、布尔校验、损坏数据回退', () => {
    expect(DEFAULT_SETTINGS.layout).toEqual({
      leftARatio: 0.3,
      leftACollapsed: false,
      rightARatio: 0.38,
      rightACollapsed: false,
      leftCollapsed: false,
      rightCollapsed: false,
      outlineHeight: 180,
      outlineCollapsed: true,
    })
    const s = sanitizeSettings({
      layout: {
        leftARatio: 9,
        leftACollapsed: 'yes',
        rightARatio: 0,
        rightACollapsed: true,
        leftCollapsed: true,
        rightCollapsed: false,
        outlineHeight: 5,
        outlineCollapsed: 1,
      },
    })
    expect(s.layout.leftARatio).toBe(0.8)
    expect(s.layout.leftACollapsed).toBe(false)
    expect(s.layout.rightARatio).toBe(0.15)
    expect(s.layout.rightACollapsed).toBe(true)
    expect(s.layout.leftCollapsed).toBe(true)
    expect(s.layout.rightCollapsed).toBe(false)
    expect(s.layout.outlineHeight).toBe(80)
    expect(s.layout.outlineCollapsed).toBe(true)
  })

  it('M29 布局字段：合法值被保留', () => {
    const s = sanitizeSettings({
      layout: { leftARatio: 0.4, rightARatio: 0.5, outlineHeight: 240, outlineCollapsed: true },
    })
    expect(s.layout.leftARatio).toBe(0.4)
    expect(s.layout.rightARatio).toBe(0.5)
    expect(s.layout.outlineHeight).toBe(240)
    expect(s.layout.outlineCollapsed).toBe(true)
  })

  it('M29 布局字段：layout 为非对象（字符串/数组）时回退默认', () => {
    expect(sanitizeSettings({ layout: 'oops' }).layout).toEqual(DEFAULT_SETTINGS.layout)
    expect(sanitizeSettings({ layout: [1, 2] }).layout).toEqual(DEFAULT_SETTINGS.layout)
    expect(sanitizeSettings({ layout: 42 }).layout).toEqual(DEFAULT_SETTINGS.layout)
  })

  it('旧版本本地头像设置会被忽略', () => {
    const legacy = sanitizeSettings({
      avatar: { source: 'local', localPath: 'C:\\legacy\\avatar.png', remoteUrl: 'https://example.invalid/avatar.png' },
    })
    expect('avatar' in legacy).toBe(false)
  })

  it('社区服务器固定为内置地址，旧明文令牌不再进入渲染层设置', () => {
    expect(DEFAULT_SETTINGS.ai.communityEndpoint).toBe(DEFAULT_COMMUNITY_ENDPOINT)
    const saved = sanitizeSettings({ ai: { communityEndpoint: 'https://example.invalid', communityToken: '  sk-test  ' } })
    expect(saved.ai.communityEndpoint).toBe(DEFAULT_COMMUNITY_ENDPOINT)
    // 令牌只在主进程安全存储（safeStorage）中留存；清洗后的设置绝不包含明文令牌
    expect('communityToken' in saved.ai).toBe(false)
  })
})
