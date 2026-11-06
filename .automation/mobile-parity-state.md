# 手机版功能补齐 · 运行状态

目标：让 `mobile/`（Tauri 手机端）功能逐步对齐桌面端 `src/`。
分支：`automation/mobile-parity`，长期 PR 指向 `main`。

## 差距总览（基于 2026-11-06 运行的初始基线）

### features/ 目录差距

| 桌面端模块 | 手机端状态 | 影响等级 |
| --- | --- | --- |
| features/ai/aiQualityCheck.ts + usageStats.ts | ❌ 缺失 | 高 |
| features/auth/LoginScreen.tsx | ❌ 缺失 | 中（社区功能前置） |
| features/community/（CloudBag 14 个文件） | ❌ 整个缺失 | 高 |
| features/conversation/（对话面板 2 个文件） | ❌ 缺失 | 中 |
| features/dashboard/（仪表盘 3 个文件） | ⚠️ 数据层已补（commit 886bed8），UI 面板缺失 | 中 |
| features/editor/imeCompletion.ts | ✅ 已补（本次 2026-11-06） | - |
| features/editor/bilingualLabels.ts | ❌ 缺失 | 中 |
| features/editor/VersionDiffModal.tsx + CodeTableModal.tsx | ❌ 缺失 | 中 |
| features/editor/AudioViewer.tsx + ImageViewer.tsx | ❌ 缺失 | 低（mobile 无桌面资源查看器） |
| features/editor/UnitLibraryModal.tsx | ❌ 缺失 | 中 |
| features/editor/unitForm/UnitFormPanel.tsx | ❌ 仅存 unitFormFields/unitFormSync，缺 UI 面板 | 中 |
| features/editor/unitPreview/（UnitPreviewModal 等 3 文件） | ❌ 整个缺失 | 低 |
| features/editor/shortcutKeymap.ts | ❌ 缺失 | 低（移动端不走键盘快捷键） |
| features/graph/RelationGraphModal.tsx + relationGraph.ts | ❌ 缺失 | 低 |
| features/map/MapViewer.tsx + tmx.ts | ❌ 缺失 | 低 |
| features/modTools/modals/（9 个 Modal）+ 报告/打包/模板库 | ⚠️ packArchive/templates/modInfo 等底层已有，UI 模态与 modReport 缺失 | 中 |
| features/plugins/（7 文件） | ❌ 整个缺失 | 低（桌面特有插件系统） |
| features/project/ProjectPanel.tsx + GitInfoModal.tsx | ❌ 缺失 | 低（mobile 无 Git 面板） |
| features/settings/（设置面板 15 文件） | ⚠️ 有 SettingsScreen 简化版，缺 ValueTypeModal/GameSettingsTab 等 | 中 |
| features/workspace/（WorkspaceSidebar 等 4 文件） | ❌ 缺失（mobile 用底部导航替代） | 低 |

### stores/ 目录差距

| 桌面端 | 手机端状态 |
| --- | --- |
| stores/workspace.ts | ⚠️ 有简化版，但 slices 全缺 |
| stores/slices/（9 个 slice：project/ai/conversation/ui/…） | ❌ 整个缺失 |
| stores/types.ts | ❌ 缺失 |

### services/ 目录差距

| 桌面端 | 手机端状态 |
| --- | --- |
| services/bridge.ts | ✅ 已有 |
| services/codeData.ts | ✅ 已有 |
| services/translation.ts | ✅ 已有 |
| services/configSyntax.ts | ✅ 已补（commit 6841917 + 49cce2a） |
| services/translationRepair.ts | ✅ 已补（commit 6841917） |
| services/mockBridge.ts | ❌ 缺失（浏览器预览/测试用） |
| services/codeDataLookup.ts | ❌ 缺失 |
| services/codeDataState.ts | ❌ 缺失 |
| services/versionDiff.ts | ❌ 缺失 |
| services/communityApi.ts + cloudBag*.ts（8 文件） | ❌ 整个缺失 |
| services/dashboardApi.ts | ❌ 缺失（仪表盘数据层已补至 mobile/features/dashboard/） |

### components/ 目录差距

| 桌面端 | 手机端状态 |
| --- | --- |
| components/AppIcon.tsx | ✅ 已有 |
| components/MobileDialog.tsx | ✅ 已有 |
| 其余 14 个组件（Modal/StatusBar/TitleBar/…） | ❌ 缺失（mobile UI 风格不同，按需移植） |
| components/desktop/（7 文件） | ❌ 缺失（纯桌面特有） |

---

## 运行记录

### 2026-11-06（首日）

**补齐的功能**：
1. `mobile/src/features/editor/imeCompletion.ts` — 输入法 composition 结束后补全面板重开守护逻辑（17 行，纯函数，与桌面端对齐）

**之前运行已补齐（同分支已有 commit）**：
- commit `6841917`：`mobile/src/services/translationRepair.ts` + `mobile/src/services/configSyntax.ts`
- commit `d00a0e6`：模组工具优化扫描 + 全局操作（mobile/features/modTools/）
- commit `886bed8`：仪表盘数据层（mobile/features/dashboard/dashboardModel.ts）
- commit `49cce2a`：configSyntax 语法解析统一化

**剩余差距**：
- features 层：aiQualityCheck、usageStats、community（整个 CloudBag）、conversation、bilingualLabels、UnitFormPanel UI、unitPreview、modals（modTools）、settings 细化、plugins
- stores 层：slices/ 全部 9 个 slice 缺失
- services 层：mockBridge、versionDiff、communityApi、cloudBag*、dashboardApi、codeDataLookup/State
- 详见上方差距总览表

**检查结果**：`npm run typecheck` ✅（tsc --noEmit 通过），`npm test` ✅（21 test files, 393 tests passed）

**是否已完全对齐**：❌ 否

**下一步计划**：
- 优先补 `features/ai/aiQualityCheck.ts` + `features/editor/bilingualLabels.ts`（二者依赖 codeData，mobile 已有）
- 然后补 `services/versionDiff.ts`（版本差异，modTools 会用）
- 之后考虑 `stores/slices/` 或 `features/settings/` 细化
- 避开桌面特有（community/cloudBag/git/plugins）——依赖量太大，单次运行无法闭环

**备注**：
- 远端分支 `automation/mobile-parity` 已存在，含 5 个 commit 指向 main
- 推送因远端领先 3 commit 被拒，按规则 `git pull --rebase origin automation/mobile-parity` 后成功推送
- GH_TOKEN 未配置，无法用 `gh pr create/comment`；推送本身会自动更新已有 PR
- 今天只新增了 `imeCompletion.ts`（`configSyntax.ts` 和 `translationRepair.ts` 在之前运行已提交）
