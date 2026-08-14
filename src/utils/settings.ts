/**
 * 设置：默认值与清洗逻辑。所有外部输入（本地存储、界面操作）都必须先经过清洗，
 * 防止损坏的数据进入应用。
 */
import type { AppSettings, BackgroundKind, FileSort, ThemeMode } from '../types/domain'
import type { AiProviderType } from '../types/ai'

export const FONT_OPTIONS = [
  { label: '系统默认', value: 'system' },
  { label: '等宽字体（Cascadia Code）', value: 'mono' },
  { label: '楷体', value: 'kaiti' },
] as const

/** 文件树排序方式 */
export const FILE_SORTS: FileSort[] = ['name', 'type', 'size', 'mtime']

/** 鼠标特效颜色预设：默认黑（贴合黑白主题）+ 樱花粉 + 浅海蓝，另支持自定义 */
export const CURSOR_EFFECT_COLORS = [
  { label: '黑色', value: '#000000' },
  { label: '樱花粉', value: '#FFB7C5' },
  { label: '浅海蓝', value: '#A5D8F3' },
] as const

export const DEFAULT_SETTINGS: AppSettings = {
  // 白色 Google Material 是默认主视觉；深色 / 跟随系统为可选主题
  theme: 'light',
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
  rightWidth: 430,
  showHiddenFiles: false,
  /** M8：文件树排序方式（名称/类型/大小/修改时间；文件夹始终优先） */
  fileSort: 'name',
  cursorEffect: false,
  cursorEffectIntensity: 1,
  cursorEffectColor: '#000000',
  /** M8：铁锈战争安装目录（用户手动配置；自动检测作为兜底） */
  gamePath: '',
  avatar: { source: 'default', localPath: null, remoteUrl: null, updatedAt: 0 },
  ai: {
    provider: 'deepseek',
    deepseekApiKey: '',
    deepseekModel: 'deepseek-v4-flash',
    communityEndpoint: '',
    communityToken: '',
    communityModel: '',
  },
}

const AI_PROVIDERS: AiProviderType[] = ['deepseek', 'community']

const BACKGROUND_KINDS: BackgroundKind[] = ['none', 'color', 'gradient', 'image']

const THEME_MODES: ThemeMode[] = ['light', 'dark', 'system']

export function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min
  return Math.min(max, Math.max(min, value))
}

export function sanitizeSettings(input: unknown): AppSettings {
  const raw = (input && typeof input === 'object' ? input : {}) as Partial<AppSettings>
  const bgRaw = (raw.background && typeof raw.background === 'object' ? raw.background : {}) as Partial<AppSettings['background']>

  return {
    theme: THEME_MODES.includes(raw.theme as ThemeMode) ? (raw.theme as ThemeMode) : DEFAULT_SETTINGS.theme,
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
    avatar: sanitizeAvatar(raw.avatar),
    leftWidth: clamp(typeof raw.leftWidth === 'number' ? raw.leftWidth : DEFAULT_SETTINGS.leftWidth, 220, 420),
    rightWidth: clamp(typeof raw.rightWidth === 'number' ? raw.rightWidth : DEFAULT_SETTINGS.rightWidth, 260, 640),
    showHiddenFiles: typeof raw.showHiddenFiles === 'boolean' ? raw.showHiddenFiles : DEFAULT_SETTINGS.showHiddenFiles,
    fileSort: FILE_SORTS.includes(raw.fileSort as FileSort) ? (raw.fileSort as FileSort) : DEFAULT_SETTINGS.fileSort,
    cursorEffect: typeof raw.cursorEffect === 'boolean' ? raw.cursorEffect : DEFAULT_SETTINGS.cursorEffect,
    cursorEffectIntensity: clamp(
      typeof raw.cursorEffectIntensity === 'number' ? raw.cursorEffectIntensity : DEFAULT_SETTINGS.cursorEffectIntensity,
      1,
      3,
    ),
    cursorEffectColor:
      typeof raw.cursorEffectColor === 'string' && /^#[0-9a-fA-F]{6}$/.test(raw.cursorEffectColor)
        ? raw.cursorEffectColor
        : DEFAULT_SETTINGS.cursorEffectColor,
    gamePath: typeof raw.gamePath === 'string' ? raw.gamePath.trim() : DEFAULT_SETTINGS.gamePath,
    ai: sanitizeAi(raw.ai),
  }
}

/** 头像配置清洗：旧版本没有头像字段时使用默认头像 */
function sanitizeAvatar(raw: unknown): AppSettings['avatar'] {
  const input = (raw && typeof raw === 'object' ? raw : {}) as Partial<AppSettings['avatar']>
  const source = input.source === 'local' || input.source === 'community' ? input.source : 'default'
  return {
    source,
    localPath: typeof input.localPath === 'string' ? input.localPath : null,
    remoteUrl: typeof input.remoteUrl === 'string' ? input.remoteUrl : null,
    updatedAt: typeof input.updatedAt === 'number' ? input.updatedAt : 0,
  }
}

/** AI 设置清洗：兼容旧配置，保证字段完整 */
function sanitizeAi(raw: unknown): AppSettings['ai'] {
  const input = (raw && typeof raw === 'object' ? raw : {}) as Partial<AppSettings['ai']>
  return {
    provider: AI_PROVIDERS.includes(input.provider as AiProviderType) ? (input.provider as AiProviderType) : DEFAULT_SETTINGS.ai.provider,
    deepseekApiKey: typeof input.deepseekApiKey === 'string' ? input.deepseekApiKey : '',
    deepseekModel: typeof input.deepseekModel === 'string' && input.deepseekModel ? migrateModel(input.deepseekModel) : DEFAULT_SETTINGS.ai.deepseekModel,
    communityEndpoint: typeof input.communityEndpoint === 'string' ? input.communityEndpoint : '',
    communityToken: typeof input.communityToken === 'string' ? input.communityToken : '',
    communityModel: typeof input.communityModel === 'string' ? input.communityModel : '',
  }
}

/** 旧模型名迁移到 V4（deepseek-chat/deepseek-reasoner 已停推） */
function migrateModel(model: string): string {
  if (model === 'deepseek-chat') return 'deepseek-v4-flash'
  if (model === 'deepseek-reasoner') return 'deepseek-v4-pro'
  return model
}
