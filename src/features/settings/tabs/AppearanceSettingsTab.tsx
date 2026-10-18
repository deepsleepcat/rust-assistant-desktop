/**
 * 设置 → 外观：主题、显示动效/低性能模式、鼠标粒子特效（强度/颜色）。
 * 从 SettingsModal 拆出（M39 巨型函数治理）；自订阅工作区 store，无父级 props。
 */
import { useState } from 'react'
import { useWorkspaceStore } from '../../../stores/workspace'
import { CURSOR_EFFECT_COLORS } from '../../../utils/settings'
import { updateDesktopPreferences, useDesktopPreferences } from '../../../components/desktop/desktopPreferences'

export function AppearanceSettingsTab() {
  const settings = useWorkspaceStore((s) => s.settings)
  const updateSettings = useWorkspaceStore((s) => s.updateSettings)
  const desktopPreferences = useDesktopPreferences()
  const [preferenceError, setPreferenceError] = useState<string | null>(null)
  const setPreference = (patch: { lowPerformance?: boolean; reduceMotion?: boolean }) => {
    const error = updateDesktopPreferences(patch)
    setPreferenceError(error)
  }

  return (
    <div className="setting-section">
      <div className="setting-title">外观</div>
      <div className="setting-row">
        <span className="label">
          主题
          <div className="desc">浅色为白色工作区；深色为暗色工作区；跟随系统则随 Windows 深浅色自动切换</div>
        </span>
        <div className="seg-group">
          {([
            { value: 'light', label: '浅色' },
            { value: 'dark', label: '深色' },
            { value: 'system', label: '跟随系统' },
          ] as const).map((opt) => (
            <button
              key={opt.value}
              className={settings.theme === opt.value ? 'active' : ''}
              onClick={() => updateSettings({ theme: opt.value })}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>
      <div className="setting-row">
        <span className="label">
          减少动态效果
          <span className="label-en">Reduce motion</span>
          <div className="desc">关闭页面切换与入场动画，同时仍尊重系统“减少动态效果”设置</div>
        </span>
        <button type="button" className={`switch${desktopPreferences.reduceMotion ? ' on' : ''}`} role="switch"
          aria-label="减少动态效果 Reduce motion" aria-checked={desktopPreferences.reduceMotion} onClick={() => setPreference({ reduceMotion: !desktopPreferences.reduceMotion })}>
          <span className="knob" />
        </button>
      </div>
      <div className="setting-row">
        <span className="label">
          低性能模式
          <span className="label-en">Low performance mode</span>
          <div className="desc">关闭磨砂模糊与过渡动效，功能保持不变；低配设备自动降级</div>
        </span>
        <button type="button" className={`switch${desktopPreferences.lowPerformance ? ' on' : ''}`} role="switch"
          aria-label="低性能模式 Low performance mode" aria-checked={desktopPreferences.lowPerformance} onClick={() => setPreference({ lowPerformance: !desktopPreferences.lowPerformance })}>
          <span className="knob" />
        </button>
      </div>
      {preferenceError && <div className="setting-error">{preferenceError}</div>}
      <div className="setting-row">
        <span className="label">
          鼠标粒子特效
          <div className="desc">移动鼠标时出现柔和光点尾迹（跟随指针，不影响操作）</div>
        </span>
        <button
          className={`switch${settings.cursorEffect ? ' on' : ''}`}
          role="switch"
          aria-label="鼠标粒子特效"
          aria-checked={settings.cursorEffect}
          onClick={() => updateSettings({ cursorEffect: !settings.cursorEffect })}
        >
          <span className="knob" />
        </button>
      </div>
      {settings.cursorEffect && (
        <div className="setting-row">
          <span className="label">
            特效强度
            <div className="desc">光点数量：弱 / 中 / 强</div>
          </span>
          <div className="seg-group">
            {([1, 2, 3] as const).map((level) => (
              <button
                key={level}
                className={settings.cursorEffectIntensity === level ? 'active' : ''}
                onClick={() => updateSettings({ cursorEffectIntensity: level })}
              >
                {level === 1 ? '弱' : level === 2 ? '中' : '强'}
              </button>
            ))}
          </div>
        </div>
      )}
      {settings.cursorEffect && (
        <div className="setting-row">
          <span className="label">
            特效颜色
            <div className="desc">黑色为默认，也可选樱花粉 / 浅海蓝或自定义</div>
          </span>
          <div className="color-presets">
            {CURSOR_EFFECT_COLORS.map((c) => (
              <button
                key={c.value}
                className={`color-swatch${settings.cursorEffectColor.toLowerCase() === c.value.toLowerCase() ? ' active' : ''}`}
                title={c.label}
                aria-label={c.label}
                onClick={() => updateSettings({ cursorEffectColor: c.value })}
                style={{ background: c.value }}
              />
            ))}
            <input
              type="color"
              className="color-custom"
              aria-label="自定义颜色"
              value={settings.cursorEffectColor}
              onChange={(e) => updateSettings({ cursorEffectColor: e.target.value })}
            />
          </div>
        </div>
      )}
    </div>
  )
}
