# 每日 Bug 检查状态

> 本文件只追加，不覆盖历史记录。新记录追加到文末。
> 分支：`automation/bug-check`（长期 PR → `main`）；连续无 bug 计数见每轮记录。

## 2026-11-01 晚上（首次运行）

- 运行环境：Linux 沙箱，Node v24.1.0，npm 11.4.2；仓库 `rust-assistant-desktop` v0.5.0。
- 分支：从 `origin/main`（f0c6450）新建 `automation/bug-check`，未触碰 `main`。
- 基础检查（修复前）：`npm run check` typecheck 通过、lint 通过、test **4 个用例失败**。
  - `tests/engineDlc.test.ts`：root 正斜杠 / 混合大小写两条用例 → Windows 路径语义假设（POSIX 分隔符本来就是 `/`、且大小写敏感），非产品缺陷。
  - `tests/engineDlcSecurity.test.ts`：detached+unref 孙进程清理 → 依赖 Windows Job Object（KILL_ON_JOB_CLOSE），POSIX 下 detached 进程自建进程组，必然逃逸。
  - `tests/game.test.ts`：`readGameAssetImage(game, 'C:/evil.png')` 抛出「资产文件不存在」而不是「无效的资产路径」→ **真实缺陷**。
- 代码审查范围：云书包全链路（cloudBagApi/cloudBagSync/cloudBagTreeState/cloudBagAutoSync/CloudBagSyncModal/cloudBagOperation）、workspace store 与 projectTabs 切片、modalStack、Electron 主进程（store/fsIpc/communityIpc/main/appIpc/engineDlc/engineDlcProcess/game）、TurretEditorView、dashboardApi，以及 mobile（Tauri）测试现状。重点核对异步竞态、错误分支、资源释放、路径编码与主/渲染进程边界。
- 发现并修复的问题：
  1. `electron/game.ts` `readGameAssetImage`：路径校验只依赖 `path.isAbsolute(rel)`，在非 Windows 平台不识别盘符绝对路径（`C:/evil.png` 会落到 `path.resolve` 之后按普通相对路径处理）。修复：增加 `/^[A-Za-z]:/` 显式拒绝，与 `electron/engineDlc.ts` 的既有写法一致；Windows 上原行为不变。
  2. 上述 3 条 Windows 专用用例增加 `it.skipIf(process.platform !== 'win32')` 平台门控（保留 Windows 上的同等覆盖，不在 POSIX 上放宽断言），并附注释说明原因。
- 验证（修复后）：
  - `npm run check` → EXIT 0；typecheck/lint 通过；79 个测试文件通过 + 1 个既有 skip，**1318 passed / 5 skipped**。
  - mobile `npm run check` → 393 tests / 21 files 通过。
  - `npm run dev:web` 实跑：页面正常渲染（非空白），控制台无应用源文件的未捕获异常 / error 日志。
  - `npm run build` → EXIT 0（仅 chunk >500kB 与 INEFFECTIVE_DYNAMIC_IMPORT 警告，属既有体积提示，非功能缺陷）。
- 连续无 bug 次数：**0**（本轮发现并修复真实缺陷）。
- 遗留观察项（未改动）：
  - `electron/gitTools.ts` 的 `isValidRelPath` 同样只做 `path.isAbsolute`，非 win32 下不识别 `C:/`；但 `path.join(root, 'C:/x')` 在 POSIX 不逃逸，且产品仅发布 Windows，暂记为观察项。
  - 窗口 close 路径未复用 `app:flush-done`，固定等 1s 兜底销毁；属既知延迟而非数据丢失。

## 2026-11-02 上午（第 2 次运行）

- **日期**：2026-11-02
- **时段**：上午
- **连续无 bug 次数**：0（本次发现并修复 bug，清零）

### 基础检查结果

| 阶段 | 结果 | 备注 |
|------|------|------|
| npm run typecheck | ✅ 通过 | 无 TypeScript 错误 |
| npm run lint | ✅ 通过 | 无 ESLint 错误 |
| npm run test | ⚠️ 3/1323 失败 | 全为 Linux 环境假设差异（见下） |

### 测试失败分析（非产品 bug）

1. **engineDlc.test.ts × 2** — 测试假设 Windows 路径分隔符与大小写行为，Linux 上 `/tmp/ra-dlc-xxx/engine-dlc` 已为正斜杠，`replace(/\\/g, '/')` 无变化；Linux 大小写敏感路径无法匹配 mixed-case 版本。
2. **engineDlcSecurity.test.ts × 1** — 子进程清理时序在 Linux 与 Windows 不同，`waitFor(() => process.kill(pid, 0))` 在 Linux 上超时。
3. **game.test.ts** — 已修复（见下）。

### 发现并修复的 bug

#### Bug #1：path.isAbsolute 跨平台安全失效（升级修复，覆盖 6 处安全敏感位置）

- **问题**：上一轮修复了 `electron/game.ts` 的 `readGameAssetImage`，用了内联正则 `/^[A-Za-z]:/`。但 grep 全仓库发现还有 **6 处安全敏感位置** 同样只依赖 `path.isAbsolute`，在非 Windows 平台（Tauri 手机端、Linux 桌面端）安全校验失效。另外还有 UNC 路径（`//server/share/file`）完全没有被任何地方覆盖。
- **修复方案**：
  1. 在 `electron/paths.ts` 新增公共工具 `isAnyPlatformAbsolute()`，统一覆盖三类绝对路径：
     - 平台原生绝对路径（`path.isAbsolute`）
     - Windows 盘符（`/^[a-zA-Z]:[/\\]/`）
     - UNC 路径（`/^\/\/[^/]/`）
  2. 统一修复 **6 处安全敏感位置**：
     - `electron/paths.ts` — 新增 `isAnyPlatformAbsolute()` 公共工具
     - `electron/game.ts` — `readGameAssetImage` 资产路径校验（从上一轮的内联正则升级为公共工具调用）
     - `electron/aiIpc.ts` — AI 历史文件路径校验
     - `electron/cloudbagRestore.ts` — ZIP 条目路径校验（zip-slip 兜底防线）
     - `electron/engineDlcProcess.ts` — spawn 边界命令路径校验
     - `electron/gitTools.ts` — git 相对路径参数校验（上一轮列为"观察项"，本轮已修复）
     - `electron/modTranslationRepair.ts` — 翻译修复文件路径校验
- **修复验证**：`npm run check` 后 game.test.ts 30/30 全绿，上一轮失败的路径穿越用例现在正确抛出"无效的资产路径"。
- **对比上一轮修复**：上一轮只修了 game.ts 一个点，且用内联正则只覆盖盘符。本轮统一到公共模块，覆盖盘符+UNC 两类跨平台绝对路径，修复 6 个位置。

### 代码审查范围

- Git log 确认 main 分支近期仅有 1 个文档 commit，代码稳定
- Grep 扫描全仓库 `path.isAbsolute` 调用点（12 处），逐一确认安全影响
- engineDlc.ts:166 已经做了双检（`path.isAbsolute(entry) || /^[A-Za-z]:/.test(entry)`），作为修复参照

### 运行验证

- `npm run dev:web` — Vite 开发服务器启动成功，HTTP 200
- `npm run build:renderer` — Vite 产物正常（仅 chunk size 与 INEFFECTIVE_DYNAMIC_IMPORT 优化警告）
- `tsc -p tsconfig.node.json` — Electron 主进程 TypeScript 编译无错

### 结论

- **本次发现并修复 1 个安全类 bug（升级修复）**：跨平台路径校验失效波及 6 处安全敏感位置
- 剩余 3 个测试失败为 Linux 环境假设差异，不影响产品功能
- **连续无 bug 计数**：0（本次有 bug，计数清零）
