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
