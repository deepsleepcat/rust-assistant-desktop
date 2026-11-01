/**
 * 背景层回归测试：防止工作区背景再次被多层遮罩"漂白"。
 *
 * 历史问题：设置背景图后（opacity=100、blur=0），工作区仍被漂白 —— 根因是
 * 1) app.css 的 .has-backdrop 半透明混合与 desktop.css 的玻璃混合叠加成多层遮罩；
 * 2) .app::before 的白色径向渐变再压一层；
 * 3) 壳层（titlebar/statusbar/wb-left）的 backdrop-filter 在 blur=0 时仍继续模糊内容图。
 * 本测试锁定修复后的契约，防止回归。
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const stylesDir = resolve(__dirname, '../src/styles')
const read = (file: string) => readFileSync(resolve(stylesDir, file), 'utf8')

const tokens = read('tokens.css')
const app = read('app.css')
const desktop = read('desktop.css')
const layout = read('layout.css')
const community = read('community.css')
const dashboard = read('dashboard.css')

describe('background veil tokens', () => {
  it('defines a single translucent veil per zone that follows both themes', () => {
    for (const token of ['--veil-chrome', '--veil-side', '--veil-panel', '--veil-editor', '--veil-float']) {
      expect(tokens).toContain(token + ': color-mix(in srgb, var(--')
    }
    // 浅色与深色主题各自提供 surface 底色（veil 通过 var 引用自动适配）
    expect(tokens).toMatch(/data-theme="light"[\s\S]*--surface-1:/)
    expect(tokens).toMatch(/data-theme="dark"[\s\S]*--surface-1:/)
  })

  it('keeps the editor veil more opaque so code stays readable over the image', () => {
    const opacityOf = (token: string) => {
      const value = tokens.match(new RegExp(`${token}: color-mix\\(in srgb, var\\(--\\S+\\) (\\d+)%`))
      return Number(value?.[1] ?? NaN)
    }
    expect(opacityOf('--veil-editor')).toBeGreaterThan(opacityOf('--veil-panel'))
    expect(opacityOf('--veil-editor')).toBeGreaterThanOrEqual(80)
    expect(opacityOf('--veil-panel')).toBeLessThanOrEqual(70)
  })
})

describe('no stacked overlays in backdrop mode', () => {
  it('removes the decorative white gradient layer when a backdrop is active', () => {
    expect(desktop).toContain('.app.has-backdrop::before { content: none; }')
  })

  it('routes desktop glass surfaces through --shell-* tokens that point at the veil', () => {
    expect(desktop).toMatch(/\.has-backdrop\s*{[^}]*--shell-panel:\s*var\(--veil-panel\)/)
    expect(desktop).toMatch(/\.has-backdrop\s*{[^}]*--shell-editor:\s*var\(--veil-editor\)/)
    expect(desktop).not.toMatch(/\.desktop-shell \.panel[^{]*{[^}]*color-mix/)
  })

  it('has-backdrop rules use the veil tokens instead of ad-hoc color-mix layers', () => {
    const backdropRules = app.match(/\.has-backdrop[^{]*\{[^}]*\}/g) ?? []
    expect(backdropRules.length).toBeGreaterThan(5)
    for (const rule of backdropRules) {
      expect(rule).not.toContain('color-mix(')
      if (rule.includes('background')) expect(rule).toContain('var(--veil-')
    }
    for (const css of [community, dashboard]) {
      expect(css).not.toMatch(/\.has-backdrop[^{]*{[^}]*color-mix/)
    }
  })
})

describe('shell blur respects the user blur=0 setting', () => {
  it('disables shell backdrop-filter in backdrop mode', () => {
    expect(desktop).toMatch(/\.has-backdrop\s*{[^}]*--shell-blur:\s*0px/)
    expect(desktop).toMatch(/\.has-backdrop \.desktop-shell \.titlebar[\s\S]*?backdrop-filter:\s*none/)
    expect(desktop).toMatch(/\.has-backdrop \.desktop-shell \.wb-left[\s\S]*?backdrop-filter:\s*none/)
  })

  it('disables the desktop rail glass blur too (no second blur layer when blur=0)', () => {
    expect(desktop).toMatch(/\.has-backdrop \.desktop-rail::before\s*{[^}]*backdrop-filter:\s*none/)
    expect(desktop).toMatch(/\.has-backdrop \.desktop-rail::before\s*{[^}]*background:\s*var\(--veil-side\)/)
  })
})

describe('editor toolbar stays quiet', () => {
  it('toolbar buttons drop per-button strong borders in favour of a low-contrast fill', () => {
    expect(layout).toMatch(/\.toolbar > \.btn\s*{[^}]*border-color:\s*transparent/)
    expect(layout).toMatch(/\.toolbar > \.btn\s*{[^}]*background:\s*color-mix\(/)
    expect(layout).toMatch(/\.toolbar > \.btn:hover\s*{[^}]*color-mix\(/)
  })

  it('keeps disabled state and groups actions with whitespace instead of vertical rules', () => {
    expect(layout).toMatch(/\.toolbar > \.btn:disabled\s*{[^}]*opacity:\s*\.45/)
    expect(layout).toContain('.toolbar-group-gap { width: 8px; flex: none; }')
  })

  it('OverflowToolbar renders group gaps between different action groups', () => {
    const source = readFileSync(resolve(__dirname, '../src/components/OverflowToolbar.tsx'), 'utf8')
    expect(source).toContain('toolbar-group-gap')
  })
})

describe('structure is separated by contrast, not dashed borders', () => {
  it('has no dashed structural borders left in the stylesheet', () => {
    for (const [file, css] of Object.entries({ app, desktop, community, dashboard })) {
      expect(css, file).not.toContain('dashed')
    }
  })

  it('keeps inputs, focus rings, splitter feedback and error semantics intact', () => {
    expect(app).toContain('.project-search-wrap:focus-within { border-color: var(--accent)')
    expect(app).toContain('.editor-textarea:focus { box-shadow: inset 2px 0 var(--accent); }')
    expect(app).toContain('.conv-input:focus { border-color: var(--accent)')
    expect(app).toContain('.tree-error {')
    expect(app).toContain('background: var(--danger-bg)')
    expect(layout).toMatch(/\.splitter:hover[^{]*{[^}]*var\(--splitter-hover\)/)
    // 输入框边框没有被全局清零
    expect(app).toMatch(/\.conv-input\s*{[^}]*border: 1px solid/)
  })
})
