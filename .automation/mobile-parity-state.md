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
