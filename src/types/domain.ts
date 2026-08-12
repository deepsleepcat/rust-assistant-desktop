/**
 * 领域模型：项目、文件、对话、设置的数据结构。
 * 这些类型是「整个应用的地基」，界面、存储、未来的 AI 接入都围绕它们展开。
 */

/** 主题模式 */
export type ThemeMode = 'light' | 'dark' | 'system'

/** 背景类型 */
export type BackgroundKind = 'none' | 'color' | 'gradient' | 'image'

export interface BackgroundSettings {
  kind: BackgroundKind
  /** 纯色背景的颜色 */
  color: string
  /** 渐变背景的 CSS 值 */
  gradient: string
  /** 图片背景的文件路径（由 Electron 读取并转成 data URL 显示） */
  imagePath: string | null
  /** 背景透明度 0-100 */
  opacity: number
  /** 背景模糊 0-40 */
  blur: number
}

export interface AppSettings {
  theme: ThemeMode
  /** 是否启用 Google 彩虹装饰效果 */
  rainbow: boolean
  background: BackgroundSettings
  /** 是否启用中文翻译显示层 */
  translateMode: boolean
  /** 头像配置（本地选择 / 社区后端上传预留） */
  avatar: import('./ai').AvatarProvider
  /** AI 设置（M4） */
  ai: {
    provider: 'deepseek' | 'community'
    deepseekApiKey: string
    deepseekModel: string
    communityEndpoint: string
    communityToken: string
    communityModel: string
  }
  /** 编辑器字体族名称 */
  fontFamily: string
  /** 编辑器字号 12-20 */
  fontSize: number
  /** 左侧项目栏宽度 */
  leftWidth: number
  /** 右侧对话栏宽度 */
  rightWidth: number
  /** 文件树是否显示隐藏文件（以 . 开头） */
  showHiddenFiles: boolean
}

/** 一个项目 = 一个铁锈战争模组目录 */
export interface ProjectInfo {
  id: string
  name: string
  rootPath: string
  createdAt: number
  lastOpenedAt: number
}

export type MessageRole = 'user' | 'assistant' | 'system'

/** 对话中的一条消息；可引用某个文件的具体行 */
export interface ConversationMessage {
  id: string
  role: MessageRole
  content: string
  /** AI 思考过程（DeepSeek V4 思考型模型的 reasoning，界面灰色显示） */
  reasoning?: string
  refPath?: string
  refStartLine?: number
  refEndLine?: number
  createdAt: number
}

/** AI 工具调用记录（显示在对话里） */
export interface ToolEvent {
  id: string
  type: 'tool_start' | 'tool_end'
  name: string
  summary?: string
  ok?: boolean
  createdAt: number
}

/** 一段 AI 对话，永远属于某一个项目 */
export interface Conversation {
  id: string
  projectId: string
  title: string
  createdAt: number
  updatedAt: number
  archived: boolean
  messages: ConversationMessage[]
  /** AI 工具调用历史（按对话保存，界面展示卡片） */
  toolEvents?: ToolEvent[]
}

/** 编辑器中打开的标签页 */
export interface EditorTab {
  id: string
  path: string
  name: string
  /** 当前显示内容（翻译模式下为中文显示层） */
  content: string
  /** 磁盘上的英文原文快照（保存基准） */
  original: string
  /** 上次保存/打开时的显示层快照，用于脏标记判断 */
  lastSavedView: string
  hasBom: boolean
  dirty: boolean
  /** 是否启用中文显示层（显示中文、保存转英文） */
  translationEnabled: boolean
  /** 读取文件时的大小（仅供展示） */
  size: number
  /** 磁盘快照时间与外部修改标记 */
  mtimeMs: number
  externalChanged?: boolean
}

/** 文件树节点 */
export interface TreeNode {
  name: string
  path: string
  isDirectory: boolean
  size: number
  mtimeMs: number
  expanded: boolean
  /** children === undefined 表示尚未加载（懒加载） */
  children?: TreeNode[]
  loading?: boolean
  error?: string
}

/** 工作区状态（持久化到本地） */
export interface WorkspaceState {
  projects: ProjectInfo[]
  activeProjectId: string | null
  conversations: Conversation[]
  /** 每个项目记住上次选中的对话 */
  lastActiveConversationByProject: Record<string, string | null>
}
