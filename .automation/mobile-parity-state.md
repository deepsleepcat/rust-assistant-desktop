# 手机版功能补齐 · 运行状态

目标：让 `mobile/`（Tauri 手机端）功能逐步对齐桌面端 `src/`。
分支：`automation/mobile-parity`，长期 PR 指向 `main`。

## 差距总览（基于 2026-11-06 运行的初始基线）

### features/ 目录差距

| 桌面端模块 | 手机端状态 | 影响等级 |
| --- | --- | --- |
| features/ai/aiQualityCheck.ts + usageStats.ts | ⚠️ aiQualityCheck 已补（2026-11-09，含自纠闭环）；usageStats 仍缺失 | 高 |
| features/auth/LoginScreen.tsx | ❌ 缺失 | 中（社区功能前置） |
| features/community/（CloudBag 14 个文件） | ❌ 整个缺失 | 高 |
| features/conversation/（对话面板 2 个文件） | ❌ 缺失 | 中 |
| features/dashboard/（仪表盘 3 个文件） | ⚠️ 数据层已补（commit 886bed8），UI 面板缺失 | 中 |
| features/editor/imeCompletion.ts | ✅ 已补（2026-11-06） | - |
| features/editor/bilingualLabels.ts | ❌ 缺失 | 中 |
| features/editor/VersionDiffModal.tsx + CodeTableModal.tsx | ❌ 缺失 | 中 |
| features/editor/AudioViewer.tsx + ImageViewer.tsx | ❌ 缺失 | 低（mobile 无桌面资源查看器） |
| features/editor/UnitLibraryModal.tsx | ❌ 缺失 | 中 |
| features/editor/unitForm/UnitFormPanel.tsx | ✅ 已补（2026-11-07） | - |
| features/editor/unitPreview/（UnitPreviewModal 等 3 文件） | ❌ 整个缺失 | 低 |
| features/editor/shortcutKeymap.ts | ❌ 缺失 | 低（移动端不走键盘快捷键） |
| features/graph/RelationGraphModal.tsx + relationGraph.ts | ❌ 缺失 | 低 |
| features/map/MapViewer.tsx + tmx.ts | ❌ 缺失 | 低 |
| features/modTools/modals/（9 个 Modal）+ 报告/打包/模板库 | ⚠️ 优化/全局操作已补（d00a0e6，ModToolsScreen），packArchive/templates/modInfo 底层已有；CreateUnit/Check/TranslationRepair/Optimize 弹窗 UI 与 modReport 仍缺 | 中 |
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

---

### 2026-11-07

**补齐的功能**：
1. `mobile/src/features/editor/unitForm/UnitFormPanel.tsx` — 手机端单位表单面板（对齐桌面端 `src/features/editor/unitForm/UnitFormPanel.tsx`），补上差距总览表中「仅存 unitFormFields/unitFormSync，缺 UI 面板」一项：
   - 按 Core/Graphics/Attack/Movement/Turret 五组表单编辑单位文件；必填/推荐标注；非法值红框提示且不写回；boolean/enum 字段用下拉选择（手机键盘友好）；图片/音效字段从项目内资源选取（按单位文件目录计算相对路径写回）；缺少必填字段打开即提示；
   - 中文显示层兼容：节名/键名/值三层词典合成回译链（对齐桌面端 zhToEn/zhToEnSection/zhToEnValue 分层语义），写回保持文件原有键名语言；
   - `mobile/src/screens/EditorScreen.tsx`：单位文件在编辑器工具栏显示「单位表单」入口；表单覆盖层打开时返回键/返回按钮先关表单，不误退编辑器、不丢未保存修改；
   - `mobile/src/styles/mobile.css`：新增 `.m-unitform-*` 覆盖层与字段样式（复用主题 tokens）；
   - 测试：新增 `mobile/tests/unitFormPanel.test.tsx` 10 例（入口显隐、表单写回、非法值拦截、枚举下拉、资源选择器空态、返回键接管、中文层写回保持中文键），`mobile/tests/editorScreen.test.tsx` 的 codeData mock 补 `getSectionZhToEnDict`。

**剩余差距**：
- features 层：aiQualityCheck、usageStats、community（整个 CloudBag）、conversation、bilingualLabels、unitPreview、VersionDiffModal、CodeTableModal、UnitLibraryModal、modTools 剩余弹窗（CreateUnit/Check/TranslationRepair/Optimize UI 与 modReport）、settings 细化、plugins
- stores 层：slices/ 全部 9 个 slice 缺失
- services 层：mockBridge、versionDiff、communityApi、cloudBag*、dashboardApi、codeDataLookup/State
- 详见上方差距总览表

**顺带修复远端分支预存问题（commit「修复: 手机端优化扫描与模组工具类型错误」）**：
1. `mobile/src/services/bridge.ts` optimizeScan：plugin-fs 的 readDir 不返回 size，原实现 `e.size ?? 0` 恒为 0，导致所有文件被判成「空文件」并可一键误删——现改为逐文件 `stat` 取真实大小，stat 失败记为 -1（未知，不判空）；同文件 globalOp 与 optimizeScan 的 `DirEntry[]` 误注解（本地富类型 vs plugin-fs 裸类型）改为遍历所需的最小字段类型，修复 mobile 自身 `tsc --noEmit` 的 2 个 TS2322；
2. `mobile/src/screens/ModToolsScreen.tsx`：OptimizeView/GlobalOpView 的 `onBack` prop 从未被使用（TS6133 ×2）——返回入口已由共享顶栏承担，删除冗余 prop。修复后 mobile `npm run check` 首次在本分支全绿（此前 2026-11-06 运行只跑根目录 typecheck，未覆盖 mobile/）。

**检查结果**：`mobile npm run check` ✅（tsc --noEmit + 24 test files / 414 tests passed，含新增 10 例）；根目录 `npm run check` typecheck/lint ✅，vitest 有 4 个预存失败（engineDlc 2、engineDlcSecurity 1、game 1），stash 对比确认在干净 origin/main 上同样存在，与本次改动无关。

**是否已完全对齐**：❌ 否

**下一步计划**：
- 优先补 `mobile/src/features/editor/bilingualLabels.ts`（桌面端 74 行纯函数 + BilingualLabel 组件，依赖 codeData 已就绪）与 `features/ai/aiQualityCheck.ts`（沿用 2026-11-06 计划）
- 然后补 `services/versionDiff.ts` + VersionDiffModal（版本对比）
- 之后考虑 CodeTableModal 码表或 settings 细化
- 避开桌面特有（community/cloudBag/git/plugins）

**备注**：
- 本次运行开始时 `git fetch origin` 未列出该远端分支（本地基线停在 origin/main f0c6450），推送时被拒才发现远端已有 6 个 commit；按规则 `git pull --rebase origin automation/mobile-parity` 完成 rebase，仅状态文件 add/add 冲突（已合并双方内容），代码文件无冲突，rebase 后 mobile 检查全绿
- 本次实现前未读到远端状态文件，选题「单位表单面板」与远端差距表（UnitFormPanel UI 缺失）恰好一致，无重复劳动
- 交付：2 个 commit 已推送至 origin/automation/mobile-parity（f843333..a0020a2），远端分支保持领先 main；GH_TOKEN 仍未配置，无法用 gh 确认/创建/评论 PR——若 PR 已存在，推送已自动更新；若不存在，待配置凭据后用 `gh pr create --repo deepsleepcat/rust-assistant-desktop --base main --head automation/mobile-parity` 创建

---

### 2026-11-08

**补齐的功能**（对齐桌面端 `features/settings/EditorSettingsTab` + `features/project/ProjectPanel` 的相关能力）：
1. `mobile/src/screens/SettingsScreen.tsx` 扩展（缩小 settings 差距行）：
   - 新增「编辑器与文件树」组：编辑器字体选择（fontFamily，FONT_OPTIONS）、文件树排序（fileSort：名称/类型/大小/修改时间）、显示隐藏文件开关（showHiddenFiles）；
   - 新增「语义检查」组：目标游戏版本下拉（targetGameVersion，异步 loadCodeData + getGameVersions，与桌面端同款「跟随最新」语义）、16 条语义检查器独立开关（ALL_SEMANTIC_CHECKERS，复用已有 checker-list 样式）。
2. `mobile/src/features/editor/FileTreePanel.tsx`：新增 `sortEntries`（文件夹始终优先，组内按名称/类型/大小/修改时间，对齐桌面端 `sortChildren`），文件树排序真正生效；此前 fileSort 在手机端是「死设置」（有字段、无 UI、无效果）。`EditorScreen` 接线 `settings.fileSort`。
3. `mobile/src/screens/InspectScreen.tsx`：检查页对齐桌面端检查语义——补上项目自定义规则（rules/*.json，loadProjectRuleSets）与目标游戏版本兼容检查（versionNameToNumber → ctx.targetVersionNumber），与编辑器 rustLintExtension 共用同一套配置。
4. `mobile/src/styles/mobile.css`：新增 `.m-group-desc` 与设置页 checker-list 展开样式（手机页内不裁剪滚动）。

**与远端分支的合并**：本次运行本地基线又停在 origin/main（f0c6450），实现完成后推送被拒才发现远端已有 9 个 commit（11-06/11-07 运行产出）。按规则 `git pull --rebase` 完成合并：仅状态文件 add/add 冲突（已合并双方内容），代码文件无冲突。本次改动的 SettingsScreen/InspectScreen/FileTreePanel 远端均未触及，无重复劳动；EditorScreen/mobile.css 与远端改动（UnitFormPanel 入口等）自动合并成功。

**剩余差距**（结合远端差距总览表更新，本次已补的不重复列）：
- modTools：modReport 模组报告、TranslationRepairModal/CreateUnitModal/CheckModal 弹窗 UI（translationRepair 服务层已补）
- features/editor：bilingualLabels、VersionDiffModal、CodeTableModal、UnitLibraryModal、unitPreview
- features/dashboard：UI 面板（数据层 dashboardModel/dashboardApi 已补）
- settings：ValueTypeModal、GameSettingsTab、项目自定义规则清单展示（EditorSettingsTab 的 rules/*.json 列表部分）
- services：versionDiff、mockBridge、codeDataLookup/State
- features/graph 关系图、plugins 插件系统、ai/usageStats 用量统计
- 桌面特有不对齐项（有意不做）：community/CloudBag、auth、map、Git 面板、workspace 双栏布局

**检查结果**：`mobile npm run check` ✅——实现后 21 test files / 393 tests；rebase 合并远端 9 个 commit 后复跑 24 test files / 414 tests 全绿（tsc --noEmit + vitest），确认合并没有语义冲突。

**是否已完全对齐**：❌ 否

**下一步计划**：
- 优先补 modReport 模组报告（纯前端计算，可挂检查页或 ModToolsScreen 入口）+ TranslationRepairModal 弹窗 UI（服务层已就绪）
- 然后 bilingualLabels 或 settings 项目自定义规则清单
- 之后 VersionDiffModal + services/versionDiff（版本对比）
- 避开桌面特有（community/cloudBag/git/plugins）

---

### 2026-11-09

**补齐的功能**（对齐桌面端 `features/ai/aiQualityCheck.ts`，即 11-06/11-07 既定的最高优先项）：
1. `mobile/src/features/ai/aiQualityCheck.ts`（新增）——AI 写文件后自动质检核心：
   - 基础 lint（lintIniText）+ 16 项语义检查器合并为统一可操作清单（行号/原因/严重度/修复建议/证据），200 条上限折叠为汇总条目（与桌面端同口径，避免大文件数万条诊断拖垮渲染）；
   - 行号用单趟预计算起始偏移表 O(1) 查；`getFreshUnitNames` 单位名扫描 2s 窗口共享缓存（AI 连续写 N 个文件只扫一次，刚写入的单位在引用检查中立即可见）；
   - WebView 适配：无 Buffer，`lintItemsToFeedback` 字节预算改用 TextEncoder（与 applyDiff 同口径）；质检数据层支持测试注入（node 测试环境无内置资源 fetch）；
   - `checkAiWrittenFile` 读取刚写入文件跑质检，非 ini/template/读取失败/超大文件（5MB）返回 null 跳过，绝不影响对话循环；项目自定义规则（rules/*.json）同样生效。
2. `mobile/src/features/ai/aiClient.ts`：runAgentChat 接入质检与自纠闭环——writeFile/applyDiff 成功后自动质检，清单随 onTool 事件挂到工具卡片；本轮问题合并为一条「自动质检反馈」user 消息回传模型自动修复（受 MAX_TOOL_ROUNDS=8 约束；质检异常降级为无清单，不打断对话）。对应桌面端 M26-3 自纠闭环（桌面走主进程 feedbackLint 通道，手机版在客户端循环内实现）。
3. `mobile/src/screens/AiScreen.tsx` + `mobile/src/styles/mobile.css`：写文件工具卡片下方渲染质检清单（行号/严重度配色/建议，warn 图标 + 「已让 AI 自行修复」提示）；质检遵循设置页语义检查开关（settings.semanticCheckers）与目标游戏版本（settings.targetGameVersion，11-08 已补的设置项直接复用）。
4. `mobile/tests/aiQualityCheck.test.ts`（新增）：14 项测试——行号表/偏移换算（含 \r\n）、建议映射、清单折叠（200 上限/汇总计数不失真）、语义合并（ruleId/evidence）、中文显示层回译检出、配置过滤、unitNames 引用检查、dont_load 跳过、超大文件跳过、自纠反馈格式化（30 条截断/字节预算 ≤8KB）。

**与远端分支的合并**：本次本地基线又停在 origin/main（f0c6450），commit 完成后推送被拒才发现远端已领先（11-06/11-07/11-08 三次运行产出）。按规则 `git pull --rebase origin automation/mobile-parity` 完成合并：**代码文件零冲突**（本次改动的 aiClient/AiScreen/mobile.css ai-tools 区段远端均未触及；选题与远端差距表「aiQualityCheck ❌ 缺失·高」一致，无重复劳动）；状态文件为本地新建与远端冲突，删除本地版后以远端为准追加本条记录。rebase 后复跑 `mobile npm run check` ✅（25 test files / 434 tests 全绿 + tsc --noEmit），确认与远端演进无语义冲突。

**剩余差距**（结合远端差距总览表更新，本次已补的不重复列）：
- features/ai：usageStats 本地用量统计（调用次数/估算 token/今日与近 7 天汇总，桌面端设置页 AI 页签可见）——手机端 aiClient 直连无记录入口
- modTools：modReport 模组报告、CreateUnitModal/CheckModal/TranslationRepairModal 弹窗 UI（translationRepair 服务层已补）
- features/editor：bilingualLabels、VersionDiffModal、CodeTableModal、UnitLibraryModal、unitPreview
- features/dashboard：UI 面板（数据层已补）；settings：ValueTypeModal、GameSettingsTab、自定义规则清单展示
- services：versionDiff、mockBridge、codeDataLookup/State；features/graph 关系图、plugins 插件系统
- 桌面特有不对齐项（有意不做）：community/CloudBag、auth、map、Git 面板、workspace 双栏布局

**是否已完全对齐**：❌ 否

**下一步计划**：
- 优先补 usageStats 用量统计（纯逻辑 + aiClient 记录 + SettingsScreen AI 组展示，工作量小、与本次质检同属 AI 差距行收尾）
- 然后 modReport 模组报告（11-08 既定计划）或 bilingualLabels
- 之后 VersionDiffModal + services/versionDiff（版本对比）
- 避开桌面特有（community/cloudBag/git/plugins）

**备注**：
- 交付：2 个 commit 已推送至 origin/automation/mobile-parity（54f5bdc..51f96bf：73f7fb8 功能 + 51f96bf 文档）；GH_TOKEN 仍未配置，无法用 gh 确认/创建/评论 PR——若 PR 已存在，推送已自动更新；若不存在，待配置凭据后用 `gh pr create --repo deepsleepcat/rust-assistant-desktop --base main --head automation/mobile-parity` 创建
- git 身份沿用仓库既有提交作者（repo 级配置，沙箱无全局身份）

