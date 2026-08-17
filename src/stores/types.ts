/**
 * 工作区 store 的类型定义（M26：从 workspace.ts 拆出，供各 slice 与组合根共用，避免循环依赖）。
 */
import type { AppSettings, Conversation, EditorTab, ProjectInfo, TreeNode } from '../types/domain'
import type { DiffLine } from '../types/diff'
import type { ModImportKind } from '../types/bridge'
import type { CommunityTab } from '../features/community/communityData'

export interface ConfirmRequest {
  title: string
  message: string
  danger?: boolean
  confirmText?: string
  cancelText?: string
  /** 可选：「保存后继续」按钮（如切换项目前的「保存并切换」）。
   * save 返回 false 表示保存失败（中止，保留弹窗）；done 在保存成功后执行切换。 */
  saveThen?: { label: string; save: () => Promise<boolean>; done: () => void }
  /** 可选：用户取消（点取消/Escape）时回调（如 resolve 挂起的调用方） */
  onCancel?: () => void
  onConfirm: () => void
}

export interface EditorPosition {
  line: number
  col: number
}

export interface WorkspaceStoreState {
  ready: boolean
  version: string
  settings: AppSettings
  projects: ProjectInfo[]
  activeProjectId: string | null
  conversations: Conversation[]
  lastActiveConversationByProject: Record<string, string | null>
  activeConversationId: string | null
  treeRoot: TreeNode | null
  treeError: string | null
  /** M7：收藏的文件/文件夹（快速跳转；归属项目，避免跨项目串显示） */
  bookmarks: Array<{ path: string; name: string; projectId: string; isDirectory: boolean }>
  openTabs: EditorTab[]
  activeTabId: string | null
  editorPos: EditorPosition
  settingsOpen: boolean
  commandOpen: boolean
  /** M29：紧凑窗口下打开的抽屉（'left' | 'right'；null = 关闭） */
  drawerSide: 'left' | 'right' | null
  /** M33-社区：当前中心工作区（编辑器 / 社区；切换不丢标签与光标） */
  activeSurface: 'editor' | 'community'
  /** 社区当前页签（推荐/关注/排行/我的） */
  communityTab: CommunityTab
  /** 社区关注的创作者 id（会话内状态，不持久化；服务器上线后并入账号数据） */
  communityFollowing: string[]
  /** M7：代码表浏览弹窗 */
  codeTableOpen: boolean
  /** M17：版本差异对比弹窗（P2 任务 1） */
  versionDiffOpen: boolean
  /** M20：关系图弹窗（P2 任务 4） */
  relationGraphOpen: boolean
  /** M23：模板库管理弹窗（P3 任务 2） */
  templateLibraryOpen: boolean
  /** M25：本地 git 历史/回滚弹窗（P3 任务 4） */
  gitInfoOpen: boolean
  /** M7：单位库弹窗 */
  unitLibraryOpen: boolean
  /** M8：值类型管理弹窗 */
  valueTypeOpen: boolean
  /** M12：炮塔编辑器弹窗 */
  turretEditorOpen: boolean
  confirm: ConfirmRequest | null
  toast: string | null
  /** 当前正在流式回复的对话（null 表示没有） */
  aiStreamingConversationId: string | null
  /** 待审批的写文件请求 */
  pendingApproval: {
    id: string
    path: string
    contentPreview: string
    contentLength?: number
    /** 行级 diff（null = 无法计算，退回纯预览） */
    diff?: DiffLine[] | null
    /** 完整增删统计（截断前计算：即使 diff 因行数上限折叠，数字也反映全部改动） */
    diffSummary?: { added: number; deleted: number } | null
    oldExists?: boolean
    /** 目标文件当前不存在（本次写入是新建） */
    newFile?: boolean
  } | null
  /** 「定位到文件行」请求（质检清单跳转用）：{ path, line, seq }，seq 递增保证重复跳转同位置也生效 */
  editorJump: { path: string; line: number; seq: number } | null
  /** M5：模组工具弹窗（null 表示关闭） */
  modDialog: 'createMod' | 'createUnit' | 'check' | 'optimize' | 'pack' | 'globalOp' | 'report' | 'import' | null
  /** M5：单位检查结果 */
  modCheckResult: { issues: Array<{ file: string; level: 'error' | 'warning' | 'info'; message: string }>; unitCount: number; fileCount: number } | null
  /** M13：模组质量报告（生成中为 null；reportOpen 控制弹窗） */
  modReport: import('../features/modTools/modReport').ModReport | null
  modReportOpen: boolean
  modReportBusy: boolean
  /** 报告生成失败信息（保留弹窗内联展示，不突然关闭） */
  modReportError: string | null
  /** 报告生成进度（done/total 为可检查文件数） */
  modReportProgress: { done: number; total: number } | null
  /** M7：优化工具扫描结果 */
  optimizeItems: Array<{ id: string; kind: 'emptyFile' | 'emptyFolder' | 'backupFile' | 'emptyLine' | 'comment'; rel: string; detail?: string }> | null
  /** M8：优化扫描失败信息（null 表示无失败；重试入口由弹窗提供） */
  optimizeError: string | null
  /** M6：自动更新状态（设置 → 关于 展示） */
  updateState: {
    status: 'idle' | 'checking' | 'available' | 'downloading' | 'downloaded' | 'not_available' | 'error'
    version?: string
    percent?: number
    message?: string
  }
}

export interface WorkspaceStoreActions {
  init(): Promise<void>
  openProject(): Promise<void>
  /** 打开应用内导入类型选择框。 */
  importModProject(): Promise<void>
  /** 按用户选择的来源执行导入。 */
  startModImport(kind: ModImportKind): Promise<void>
  /** M8：把已存在的目录注册为新项目（游戏示例/游戏模组导入用）：
   * 确认未保存编辑 → 切到新项目 → 刷新树 → 通知；用户取消返回 false */
  addImportedProject(rootPath: string, name: string, message: string): Promise<boolean>
  selectProject(id: string): Promise<void>
  removeProject(id: string): void
  refreshTree(): Promise<void>
  loadDir(node: TreeNode): Promise<void>
  /** 局部刷新目录节点（其下增删改后调用；未加载过子项的目录跳过） */
  reloadDirNode(path: string): Promise<void>
  toggleDir(path: string): void
  openFile(path: string): Promise<void>
  updateTabContent(id: string, content: string): void
  /** 保存标签页：返回是否保存成功（外部修改拦截/失败时返回 false，调用方据此决定是否关闭标签）；
   * force=true 跳过外部修改检查（用户明确「覆盖保存」） */
  saveTab(id: string, opts?: { force?: boolean }): Promise<boolean>
  /** 重新加载标签页内容（丢弃本地修改，用于文件被外部修改后） */
  reloadTab(id: string): Promise<void>
  closeTab(id: string): void
  /** 带脏确认的关闭（有未保存修改时弹全局确认，命令面板等无标签栏上下文入口用） */
  closeTabChecked(id: string): void
  setActiveTabId(id: string): void
  toggleTranslation(id: string): void
  checkExternalChanges(): Promise<void>
  createFile(parentPath: string, name: string): Promise<void>
  createFolder(parentPath: string, name: string): Promise<void>
  renameItem(targetPath: string, newName: string): Promise<void>
  deleteItem(targetPath: string): Promise<void>
  /** M7：收藏/取消收藏（文件或文件夹） */
  toggleBookmark(path: string, isDirectory: boolean): void
  isBookmarked(path: string): boolean
  createConversation(): void
  renameConversation(id: string, title: string): void
  toggleArchiveConversation(id: string): void
  deleteConversation(id: string): void
  selectConversation(id: string): void
  updateSettings(patch: Partial<AppSettings>): void
  setEditorPos(pos: EditorPosition): void
  /** 打开文件并跳到指定行（质检清单「定位」按钮用） */
  jumpToFileLine(path: string, line: number): void
  /** 消费跳转请求（EditorPane 跳转成功后调用，防止切标签重挂载后陈旧跳转再次触发） */
  consumeEditorJump(): void
  /** 恢复到指定历史版本（快照 id；打开标签有未保存修改时先确认） */
  aiRestoreFileVersion(relPath: string, snapshotId: string): Promise<void>
  setSettingsOpen(open: boolean): void
  setCommandOpen(open: boolean): void
  /** M29：紧凑窗口抽屉开关 */
  setDrawerSide(side: 'left' | 'right' | null): void
  /** M33-社区：切换中心工作区（编辑器 ↔ 社区） */
  setActiveSurface(surface: 'editor' | 'community'): void
  /** M33-社区：切换社区页签 */
  setCommunityTab(tab: CommunityTab): void
  /** M33-社区：关注/取消关注创作者（会话内状态） */
  toggleCommunityFollow(creatorId: string): void
  setCodeTableOpen(open: boolean): void
  setVersionDiffOpen(open: boolean): void
  setRelationGraphOpen(open: boolean): void
  setTemplateLibraryOpen(open: boolean): void
  setGitInfoOpen(open: boolean): void
  setUnitLibraryOpen(open: boolean): void
  /** M8：值类型管理弹窗 */
  setValueTypeOpen(open: boolean): void
  /** M12：炮塔编辑器弹窗 */
  setTurretEditorOpen(open: boolean): void
  requestConfirm(req: ConfirmRequest): void
  dismissConfirm(): void
  /** 有未保存编辑时先确认再执行动作（切项目/导模组前调用，防止静默丢编辑）。
   * resolve true=已执行；false=用户取消或失败 */
  confirmDirtySwitch(action: () => Promise<void> | void): Promise<boolean>
  notify(message: string): void
  /** LOW-3b：应用关闭前同步落盘（取消防抖立即写入） */
  flushPersist(): Promise<void>
  dismissToast(): void
  /** M4：向 AI 发送消息（流式） */
  sendAiMessage(conversationId: string, text: string): Promise<void>
  respondApproval(approved: boolean): Promise<void>
  /** M5：模组工具 */
  setModDialog(kind: 'createMod' | 'createUnit' | 'check' | 'optimize' | 'pack' | 'globalOp' | 'import' | null): void
  createModProject(params: { title: string; description?: string; author?: string; version?: string; musicFiles?: string[]; musicExclusive?: boolean; updateUrl?: string }): Promise<void>
  /** M7：编辑模组自述文件（mod-info.txt 读写，包含 thumbnail/music/maps） */
  saveModInfo(data: { title: string; description?: string; author?: string; version?: string; thumbnail?: string; minVersion?: string; musicFiles: string[]; musicExclusive: boolean; mapsFiles: string[]; mapsExtra: boolean; musicSourceFolder?: string; mapsSourceFolder?: string; updateUrl?: string }): Promise<void>
  /** M7：把当前打开的文件保存为模板 */
  saveActiveFileAsTemplate(name: string): Promise<void>
  createUnitFile(params: { name: string; templateKey: string; values: Record<string, string> }): Promise<void>
  packModProject(): Promise<void>
  packModWithOptions(options: { removeEmptyFiles?: boolean; removeEmptyFolders?: boolean; removeEmptyLines?: boolean; removeComments?: boolean; formatCode?: boolean }): Promise<void>
  checkModProject(): Promise<void>
  /** M13：生成模组质量报告 */
  generateModReport(): Promise<void>
  /** M13：导出质量报告（text/json；系统保存对话框） */
  exportModReport(kind: 'text' | 'json'): Promise<void>
  /** M13：打开/关闭质量报告弹窗 */
  setModReportOpen(open: boolean): void
  /** M7：优化工具 */
  scanOptimizeProject(): Promise<void>
  applyOptimizeProject(ids: string[]): Promise<void>
  /** 全局操作：批量替换/头部附加/尾部附加（返回结果供弹窗展示；失败返回 null） */
  globalOpProject(params: { kind: 'replace' | 'prepend' | 'append'; find?: string; text?: string }): Promise<{ files: number; changed: number; skipped: number } | null>
  /** M6：自动更新 */
  checkUpdate(): Promise<void>
  downloadUpdate(): Promise<void>
  installUpdate(): void
}

export type WorkspaceStore = WorkspaceStoreState & WorkspaceStoreActions
