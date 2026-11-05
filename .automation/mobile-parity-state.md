# 手机端 / 桌面端功能对齐状态

本文件由自动化任务维护，每次运行追加一条记录。分支：`automation/mobile-parity`。

## 功能差距清单（2026-11-02 基线）

### features 层差距
| 模块 | 桌面端有 | 手机端有 | 备注 |
|---|---|---|---|
| ai | aiQualityCheck, usageStats | aiClient, diff, applyDiff, rustAgentTools | 手机端独立实现 AI 客户端 |
| auth | LoginScreen | — | 手机端无登录 |
| community | CloudBag* 系列 14 文件 | — | 云仓库/社区完整缺失 |
| conversation | ConversationPanel, RightColumn | — | 会话面板缺失 |
| dashboard | DashboardPanel, dashboardModel | — | 仪表盘缺失 |
| editor | EditorArea, IMECompletion, bilingualLabels, shortcutKeymap, UnitPreviewModal, unitPreview/, AudioViewer, ImageViewer, CodeTableModal, VersionDiffModal, UnitLibraryModal | EditorToolbar, FileTreePanel, AssetPreview, openFile, editSession | UI 形态不同，手机端补 toolbar + 全屏 screen |
| graph | RelationGraphModal, relationGraph | — | 关系图缺失 |
| map | MapViewer, tmx | — | 地图查看缺失 |
| modTools | ModToolModals, modals/* (9), modReport, ModPackProgress, TemplateLibraryModal, TurretEditorView | templates, packArchive, packWorker, sampleProject, modInfo | 桌面端 modal 化；手机端走 screen |
| plugins | adapterRegistry, index, manifest, renderer, rendererSelection, runtimeData, state | — | 插件系统完整缺失 |
| project | ProjectPanel, GitInfoModal | — | 项目面板/ Git 信息缺失 |
| settings | SettingsModal, SettingsPage, ValueTypeModal, GameSettingsTab, SettingsContent, tabs/* (10) | SettingsScreen.tsx（1 屏） | 设置 tabs 大量缺失 |
| workspace | SurfaceNav, WorkspaceSidebar, LeftColumn, CommandPalette | — | 命令面板/侧边栏导航缺失 |
| semanticChecks | 22 文件 | 22 文件 | ✅ 已对齐 |
| unitForm | unitFormFields, unitFormSync, UnitFormPanel | unitFormFields, unitFormSync | 缺 UnitFormPanel（桌面 UI） |

### components 层差距
桌面端 16+7 组件，手机端仅 AppIcon + MobileDialog。关键缺失：BilingualLabel, Modal/Confirm/Approval, WorkbenchLayout, icons, StatusBar, Backdrop, TitleBar, CommunityAvatar, CloudBagAutoSyncService 等。

### services 层差距
| 文件 | 桌面端 | 手机端 |
|---|---|---|
| bridge.ts | ✅ Electron + mock | ✅ Tauri + 完整桥 |
| codeData.ts | 拆成 3 个文件 + state | ✅ 合并成 1 个更完整 |
| translation.ts | ✅ | ✅ |
| cloudBag*.ts | ✅ 5 个 | — |
| community*.ts | ✅ 2 个 | — |
| codeDataLookup.ts / codeDataState.ts | ✅ | —（合并进 codeData.ts） |
| configSyntax.ts | ✅ | — |
| dashboardApi.ts | ✅ | — |
| mockBridge.ts | ✅ | — |
| translationRepair.ts | ✅ | — |
| versionDiff.ts | ✅ | — |

### stores 层差距
桌面端 workspace + 9 slices（ai, conversation, project*, ui）；手机端仅 workspace（单文件，无 slices）。

---

## 对齐记录

### 2026-11-02（第 1 次运行）

**补齐功能**：
- `mobile/src/services/translationRepair.ts` — 已翻译 INI 的保守恢复（212 行，纯逻辑，无外部依赖）
- `mobile/src/services/configSyntax.ts` — 配置语法标点兼容（52 行，纯工具）
- `mobile/tests/translationRepair.test.ts` — 6 条测试（节名前缀恢复/混合键回译/布尔值恢复/CRLF 保留/真实单位回归）
- `mobile/tests/configSyntax.test.ts` — 4 条测试（分隔符识别/逗号分段/全角冒号规范化/多行保留）

**剩余差距**：services 层仍缺 cloudBag*, community*, dashboardApi, mockBridge, versionDiff；features 层 auth/community/conversation/dashboard/graph/map/plugins/project/workspace/settings/tabs 大量缺失；components 层和 stores 层差距最大。

**是否完全对齐**：否

**下一步计划**：
1. 搬运 versionDiff.ts（需先在 mobile/codeData 补 getAliasDict，或从桌面端 codeDataState 合并 alias 数据）
2. 搬运 modReport.ts + ModToolModals 的 screen 化
3. 视精力搬运 configSyntax + translationRepair 已完成，可以继续 versionDiff
4. 长期：settings/tabs → SettingsScreen 分项展开

---

### 2026-11-03（第 2 次运行）

**补齐功能**：

1. **bridge 层实现** — `mobile/src/services/bridge.ts`
   - `optimizeScan(rootPath)`：从 stub（空数组）改为真实实现。扫描项目内空文件(0字节)、空文件夹、备份文件(.bak/.old/.tmp/~)、.ini 文件末尾空行(≥2行)、.ini 注释行(# 开头)。
   - `optimizeApply(rootPath, ids)`：从 stub(done=0) 改为真实实现。按 id 逐个执行：删除空文件/备份文件、递归删除空文件夹、清理 .ini 末尾多余空行、移除 .ini 中 # 注释行并合并多余空行。全部走 `assertInsideProject` 路径校验。
   - `globalOp(rootPath, params)`：从 stub 返回零值改为真实实现。遍历项目内全部 .ini / .template 文件，支持三种模式：replace（查找→替换，find 可空=删除）、prepend（头部附加，保留 BOM）、append（尾部追加，自动补换行）。结果返回 files/changed/skipped。

2. **UI 入口** — `mobile/src/screens/ModToolsScreen.tsx`（新建）
   - 新增「工具」Tab（底部导航第 6 个），图标 `tools`。
   - 子页面：优化扫描（分组展示各类可优化项、逐项勾选/整类全选、确认弹窗、进度提示）+ 全局操作（三种模式切换、文本输入、执行预览）。
   - `ConfirmModal` 走现有 mobile dialog 组件，路径校验复用 bridge 层 assertInsideProject。

3. **导航与类型**
   - `MobileTab` 类型新增 `'modTools'`。
   - `App.tsx` TABS 数组插入「工具」Tab 并渲染 `<ModToolsScreen />`。

**剩余差距**：
- services 层：cloudBag*（5）、community*（2）、dashboardApi、mockBridge、versionDiff、codeDataLookup/State 仍缺失
- bridge `translationRepairScan` / `translationRepairApply`：仍是 stub（返回空）
- features 层：auth/community/conversation/dashboard/graph/map/plugins/project/workspace 仍缺失；settings 缺 tabs；modTools 缺 ReportModal、TranslationRepairModal
- components 层和 stores 层差距最大（手机端 UI 范式不同，部分差距可接受）

**是否完全对齐**：否

**下一步计划**：
1. 实现 `translationRepairScan` / `translationRepairApply`（翻译损坏修复）——补齐 modTools 最后一个重要功能，bridge 已有接口
2. 实现 `versionDiff.ts`（版本差异可视化）——需在 mobile/codeData 补 alias 数据
3. 评估 ReportModal（模组质量报告）是否需要：InspectScreen 已是简化版质量检查
4. 长期：settings/tabs → SettingsScreen 分项展开

---

### 2026-11-04（第 3 次运行）

**补齐功能**：
- `mobile/src/services/communityConfig.ts` — 社区端点配置（getCommunityEndpoint / isAllowedCommunityEndpoint）
- `mobile/src/services/communityApi.ts` — CommunityApiError 类 + normalizeCommunityEndpoint（dashboardApi 依赖）
- `mobile/src/services/dashboardApi.ts` — 仪表盘 API 客户端（完整契约，defaultDashboardFetch 适配 Tauri 环境，去掉 Electron bridge 分支）
- `mobile/src/features/dashboard/dashboardModel.ts` — 仪表盘纯函数逻辑层（formatCount / cachePieSegments / balanceText / swapSlots / normalizeLayout / chartValues 等）
- `mobile/src/features/dashboard/dashboardModel.test.ts` — 对应单元测试（从桌面端同步，2 条用例）

**Check 结果**：
- `npm run typecheck` ✅ 零错误
- `npm test` ✅ 393 tests passed（21 files），dashboardModel.test.ts 新增 2 用例通过

**剩余差距（更新 2026-11-02 基线）**：
- services 层：cloudBag*（5）、mockBridge、versionDiff、codeDataLookup/State 仍缺失；communityConfig/communityApi/dashboardApi 已补齐
- features 层：auth/community/conversation/dashboard(DashboardPanel)/graph/map/plugins/project/workspace 仍缺失；settings 缺 tabs；modTools 缺 ReportModal、TranslationRepairModal
- stores 层：桌面端 workspace + 9 slices；手机端仅 workspace 单文件
- components 层和 styles 层差距最大

**是否完全对齐**：否

**下一步计划**：
1. 延续之前计划：补齐 `translationRepairScan` / `translationRepairApply` bridge 实现，或补齐 `versionDiff.ts`
2. 或另起优先级更高的：conversation store（mobile domain.ts 已有 Conversation 类型但 store 完全无对话状态管理）
3. 长期：settings/tabs → SettingsScreen 分项展开

---

### 2026-11-05（第 4 次运行）

**背景**：`automation/mobile-parity` 此前已在 11-02/11-03/11-04 完成 3 次补齐，今天运行首次从 `origin/main` 切出新分支后发现远端已存在 parity 分支（3 个历史提交）。本地新建 commit（configSyntax + rustLint）经 `git pull --rebase origin automation/mobile-parity` 与远端对齐：configSyntax.ts 在 11-02 已补齐（保留远端版本），rustLint.ts 接入 configSyntax 的改动是本次真正的增量。

**补齐功能**：
- `mobile/src/features/editor/rustLint.ts`：移除内联的 `splitTopLevel` 函数（40 行），改为 `import { splitTopLevelConfigValue } from '../../services/configSyntax'` 并通过别名 `const splitTopLevel = splitTopLevelConfigValue` 保持原调用点不变。

**增量健壮性**：原函数只按英文逗号 `,` 做顶层分段；现在委托 `splitTopLevelConfigValue` 后，值中的中文逗号 `，` 也会被正确作为顶层分隔符（spawnUnits 参数值、枚举列表值里出现中文逗号时不再整段误校验）。

**Check 结果**：
- `mobile/` 目录下 `npx tsc --noEmit` ✅ 通过
- `npm test` ✅ 21 files / 393 tests passed（与 11-04 相同基线）
- 注意：首次运行时误判 parity 分支不存在，走 `git checkout -b ... origin/main` 创建本地新分支 → 直接 push 被拒（远端已有 parity）→ 按任务指令 `git pull --rebase origin automation/mobile-parity` 对齐，冲突手动解决。

**剩余差距（更新 2026-11-02 基线）**：
- services 层：cloudBag*（5）、mockBridge、versionDiff、codeDataLookup/State 仍缺失；translationRepair、configSyntax、communityConfig/communityApi/dashboardApi 已补齐
- bridge 接口仍待补：`translationRepairScan` / `translationRepairApply`（modTools 翻译修复功能未贯通）
- features 层：auth/community/conversation/dashboard(DashboardPanel)/graph/map/plugins/project/workspace 仍缺失；settings 缺 tabs；modTools 缺 ReportModal、TranslationRepairModal
- stores 层：桌面端 workspace + 9 slices；手机端仅 workspace 单文件
- components 层和 styles 层差距最大（手机端 UI 范式不同）

**是否完全对齐**：否

**下一步计划**：
1. 补齐 bridge 的 `translationRepairScan` / `translationRepairApply`（纯文件扫描 + 保守修复，mobile 已有 services/translationRepair.ts）—— 打通 modTools 翻译修复流程
2. 或补齐 `versionDiff.ts`（版本差异可视化，需要 mobile/codeData 已有 alias 数据支持）
3. 长期：settings/tabs → SettingsScreen 分项展开

---
