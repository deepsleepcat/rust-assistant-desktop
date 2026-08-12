/**
 * 设置：默认值与清洗逻辑。所有外部输入（本地存储、界面操作）都必须先经过清洗，
 * 防止损坏的数据进入应用。
 */
import type { AppSettings, BackgroundKind } from '../types/domain'

export const FONT_OPTIONS = [
  { label: '系统默认', value: 'system' },
  { label: '等宽字体（Cascadia Code）', value: 'mono' },
  { label: '楷体', value: 'kaiti' },
] as const

export const DEFAULT_SETTINGS: AppSettings = {
  // 白色 Google Material 是默认主视觉，深色仅作为备用主题。
  // 保留字段以兼容旧配置，但界面始终采用白色主题。
  theme: 'light',
  rainbow: true,
  background: {
    kind: 'none',
    color: '#e8f0fe',
    gradient:
      'linear-gradient(135deg, #e8f0fe 0%, #fce8e6 33%, #fef7e0 66%, #e6f4ea 100%)',
    imagePath: null,
    opacity: 55,
    blur: 12,
  },
  fontFamily: 'system',
  fontSize: 14,
  translateMode: true,
  leftWidth: 280,
  rightWidth: 340,
  showHiddenFiles: false,
}

const BACKGROUND_KINDS: BackgroundKind[] = ['none', 'color', 'gradient', 'image']

export function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min
  return Math.min(max, Math.max(min, value))
}

export function sanitizeSettings(input: unknown): AppSettings {
  const raw = (input && typeof input === 'object' ? input : {}) as Partial<AppSettings>
  const bgRaw = (raw.background && typeof raw.background === 'object' ? raw.background : {}) as Partial<AppSettings['background']>

  return {
    theme: 'light',
    rainbow: typeof raw.rainbow === 'boolean' ? raw.rainbow : DEFAULT_SETTINGS.rainbow,
    background: {
      kind: BACKGROUND_KINDS.includes(bgRaw.kind as BackgroundKind) ? (bgRaw.kind as BackgroundKind) : DEFAULT_SETTINGS.background.kind,
      color: typeof bgRaw.color === 'string' && /^#[0-9a-fA-F]{6}$/.test(bgRaw.color) ? bgRaw.color : DEFAULT_SETTINGS.background.color,
      gradient: typeof bgRaw.gradient === 'string' ? bgRaw.gradient : DEFAULT_SETTINGS.background.gradient,
      imagePath: typeof bgRaw.imagePath === 'string' ? bgRaw.imagePath : null,
      opacity: clamp(typeof bgRaw.opacity === 'number' ? bgRaw.opacity : DEFAULT_SETTINGS.background.opacity, 0, 100),
      blur: clamp(typeof bgRaw.blur === 'number' ? bgRaw.blur : DEFAULT_SETTINGS.background.blur, 0, 40),
    },
    fontFamily: FONT_OPTIONS.some((f) => f.value === raw.fontFamily) ? (raw.fontFamily as string) : DEFAULT_SETTINGS.fontFamily,
    fontSize: clamp(typeof raw.fontSize === 'number' ? raw.fontSize : DEFAULT_SETTINGS.fontSize, 12, 20),
    translateMode: typeof raw.translateMode === 'boolean' ? raw.translateMode : DEFAULT_SETTINGS.translateMode,
    leftWidth: clamp(typeof raw.leftWidth === 'number' ? raw.leftWidth : DEFAULT_SETTINGS.leftWidth, 220, 420),
    rightWidth: clamp(typeof raw.rightWidth === 'number' ? raw.rightWidth : DEFAULT_SETTINGS.rightWidth, 260, 520),
    showHiddenFiles: typeof raw.showHiddenFiles === 'boolean' ? raw.showHiddenFiles : DEFAULT_SETTINGS.showHiddenFiles,
  }
}
