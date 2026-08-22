/**
 * 领域模型：项目、文件、对话、设置的数据结构。
 * 这些类型是「整个应用的地基」，界面、存储、未来的 AI 接入都围绕它们展开。
 */

/** 主题模式 */
export type ThemeMode = 'light' | 'dark' | 'system'

/** 文件树排序方式 */
export type FileSort = 'name' | 'type' | 'size' | 'mtime'

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

/** M29：工作区布局持久化（可拖动分隔条的比例/折叠状态；左/右主栏宽度沿用 leftWidth/rightWidth） */
export interface WorkbenchLayoutSettings {
  /** 左栏内部「项目列表」比例（0-1；0.3 = 30%），文件树占剩余 */
  leftARatio: number
  /** 左栏「项目列表」折叠（展开时恢复 leftARatio） */
  leftACollapsed: boolean
  /** 右栏内部「对话列表」比例（0-1；0.38 = 38%），消息区占剩余 */
  rightARatio: number
  /** 右栏「对话列表」折叠 */
  rightACollapsed: boolean
  /** 左栏整体折叠（重新展开恢复 leftWidth） */
  leftCollapsed: boolean
  /** 右栏整体折叠（重新展开恢复 rightWidth） */
  rightCollapsed: boolean
  /** 编辑器「大纲」面板高度 px */
  outlineHeight: number
  /** 大纲折叠 */
  outlineCollapsed: boolean
}

export interface AppSettings {
  theme: ThemeMode
  background: BackgroundSettings
  /** 是否启用中文翻译显示层 */
  translateMode: boolean
  /** AI 设置（M4；Key 本体只存主进程 safeStorage，这里只有「已配置」标志） */
  ai: {
    provider: 'deepseek' | 'community'
    deepseekKeyConfigured: boolean
    deepseekModel: string
    communityEndpoint: string
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
  /** M29：工作区布局（分隔条比例/折叠状态） */
  layout: WorkbenchLayoutSettings
  /** 文件树是否显示隐藏文件（以 . 开头） */
  showHiddenFiles: boolean
  /** M8：文件树排序方式（名称/类型/大小/修改时间；文件夹始终优先） */
  fileSort: FileSort
  /** M6：鼠标粒子特效开关 */
  cursorEffect: boolean
  /** M6：鼠标粒子特效强度 1-3（粒子数量） */
  cursorEffectIntensity: number
  /** M6：鼠标粒子特效颜色（hex，默认黑，可选樱花粉/浅海蓝等预设） */
  cursorEffectColor: string
  /** M8：铁锈战争安装目录（用户手动配置；自动检测作为兜底） */
  gamePath: string
  /** M10：语义检查器开关（ruleId → 是否启用；缺省全部开启） */
  semanticCheckers: Record<string, boolean>
  /** M11：当前项目目标游戏版本（版本兼容提示用；空 = 跟随最新） */
  targetGameVersion: string
  /** M12：上次运行前检查结果（at=0 表示从未检查过） */
  gameLastCheck: { at: number; ok: boolean; message: string }
  /** M18：知识包数据源（http/https URL；空 = 未配置，用内置包） */
  knowledgeSourceUrl: string
  /** M18：可选镜像源列表（用户添加；下拉切换用） */
  knowledgeSources: string[]
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
  /** 工具参数（界面展示路径等信息） */
  args?: Record<string, unknown>
  summary?: string
  ok?: boolean
  createdAt: number
  /** writeFile 目标相对路径（质检/历史入口用，仅 tool_end） */
  path?: string
  /** writeFile 写盘前快照 id（撤销入口用；新文件/快照超限时不存在） */
  snapshotId?: string
  /** 快照被跳过（文件过大等）：本次写入不可撤销 */
  snapshotSkipped?: boolean
  /** 写盘后自动质检结果（仅 writeFile 成功且发现问题时填充） */
  lint?: import('./ai').AiLintItem[]
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
  hasBom: boolean
  dirty: boolean
  /** 是否启用中文显示层（显示中文、保存转英文） */
  translationEnabled: boolean
  /** 翻译追踪表（中文显示串 → 原始英文串）：保存时精确还原，未追踪中文保留 */
  translationMap?: Map<string, string>
  /** 打开时只在内存规范化了已知中文键；必须用户明确保存才写回磁盘。 */
  pendingRepair?: boolean
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
