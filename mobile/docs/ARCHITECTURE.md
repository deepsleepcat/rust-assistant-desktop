# 铁锈工坊 · 架构文档

> 本文档描述手机版第一版的模块划分与桥契约，为第二版云书包接入预留接口。

## 1. 总体架构

```
┌─────────────────────────────────────────────────┐
│ WebView（React 19 + CodeMirror 6）              │
│  screens/      六屏 UI（项目/编辑器/模板/检查/AI/设置）│
│  features/     编辑器、AI 对话、模板、打包         │
│  stores/       zustand 工作区状态                 │
│  services/     bridge（唯一 IO 入口）             │
├─────────────────────────────────────────────────┤
│ Tauri 桥（services/bridge.ts）                   │
│  fs（appdata scope）· store（JSON 原子写）        │
│  dialog（SAF 导入/导出）· ai_stream（Rust 代理）  │
├─────────────────────────────────────────────────┤
│ Rust 层（src-tauri/src/lib.rs）                  │
│  ai_stream：DeepSeek SSE 流式转发 → tauri 事件    │
│  tauri-plugin-fs / dialog / clipboard            │
└─────────────────────────────────────────────────┘
```

## 2. 桥契约（BridgeApi）

`src/types/bridge.ts` 定义完整契约（与桌面版同源）；手机版实现 v1 子集，接口形状不变，
未来云书包接入只需新增实现、UI 零改动：

| 域 | v1 实现 | 说明 |
| --- | --- | --- |
| `store` | ✅ | appData/app-state.json，临时文件 + rename 原子写，250ms 防抖 |
| `project.*` | ✅ | 读/写/建/删/重命名/stat；文本读写含 BOM 处理 |
| `project.openFolderDialog` | ✅ | SAF 目录 → 拷贝进 appData/projects（托管模式） |
| `mod.import` | ✅ | SAF 目录 / .rwmod / .zip（自动解压，防路径穿越） |
| `mod.pack` | ✅ | 收集文件 → Web Worker（JSZip）→ dialog save |
| `mod.listTemplates/createUnitFromTemplate` | ✅ | 内置模板 + 参数替换创建单位 |
| `mod.scanResources` | ✅ | 项目文件列表 + 单位名（补全/引用检查用） |
| `mod.readModInfo/writeModInfo` | ✅ | mod-info.txt 结构化读写 |
| `ai.*` | ✅（aiClient 直连） | ai_stream invoke + 事件订阅；approve 由前端审批 UI 承担 |
| `knowledge.*` | ⬜（未实现） | codeData 回退内置 fetch；v2 知识包更新器接入点 |
| `game.*` / `git.*` | ⬜ | v1 明确不做（游戏集成 / 本地 git） |

**手机版扩展入口**（不属于 `BridgeApi` 契约，仅供本端 UI 调用）：

| 导出 | 用途 |
| --- | --- |
| `importMod('archive' \| 'folder' \| 'auto')` | 显式导入入口：压缩包解压 / SAF 目录拷贝；重名自动加序号，失败清理半成品目录 |
| `deleteProject(rootPath)` | 整项目删除的唯一入口（文件通道 `project.delete` 拒绝删项目根） |
| `uniqueProjectDir(baseName)` | 在 `appData/projects` 下取未占用目录名，绝不覆盖已有项目 |
| `writeProjectBinary(rootPath, path, bytes)` | 二进制写入（示例项目占位图片）；文本一律走 `project.writeFile` |

**目录约定（v1 全部本地）**：

```
appData/
├─ projects/<name>/    项目（导入时从 SAF 拷贝，项目内操作免权限）
├─ templates/          用户模板（预留，v1 只读内置包）
└─ app-state.json      全局存储（workspace/settings/ai 设置）
```

## 3. 安全边界

- **fs 权限**：capabilities 仅授予 `fs:allow-appdata-read/write/meta-recursive`
  （$APPDATA scope），WebView 无法触达应用私有目录之外；
- **项目边界**：文件通道每个入口都过 `assertInsideProject`（`utils/entryName.isPathInsideRoot`），
  拒绝 `..` 逃逸与项目根之外的路径；`createFile` 拒绝覆盖同名文件，`project.delete` 拒绝删项目根
  （整项目删除走 `deleteProject`）；
- **名称校验**：新建/重命名的名称过 `validateEntryName`——拒绝空值、路径分隔符、
  Windows 保留字符、控制字符、`.`/`..`、超长名，以及同目录重名（不区分大小写）；
- **AI 工具路径**：`rustAgentTools.safeRelPath` 拒绝绝对路径 / `..` 穿越 / 空路径 /
  NUL 字节；只读工具限制扩展名（配置文件/JSON/MD）；
- **写文件审批**：writeFile/applyDiff 必须经用户审批弹窗（diff 预览），拒绝则
  回传模型调整；diff 应用前全量校验（上下文行不信任模型，从原文件原样取）；
- **导入解压**：zip 条目拒绝绝对路径与 `..`（防 zip slip）；
- **AI Key**：仅存本地 store（app-state.json），不写日志、不入 git；
- **无凭据字面量**：源码/测试不包含任何可用 API Key；
- **对话框**：确认/输入一律用页面内弹层（`components/MobileDialog.tsx`），
  不用 `window.confirm/prompt/alert`——Android WebView 对 JS 对话框支持不稳定
  （可能直接返回 null，用户既点不到也没法取消）。

## 4. 编辑会话与数据保护

移动端一次只编辑一个文件，`stores/workspace.ts` 的 `editorSession` 保存当前会话；
纯逻辑集中在 `features/editor/editSession.ts`（可独立测试）。

会话同时记两个基准，避免中英文两套内容互相覆盖：

| 字段 | 含义 |
| --- | --- |
| `content` | 编辑器里的当前显示内容（中文模式下是中文） |
| `savedDisplay` | 最后一次与磁盘一致的**显示内容**（脏判定基准） |
| `original` | 最后一次读/写的**磁盘英文内容**（诊断与外部比对） |
| `translationTrack` | 中文串 → 原始英文串追踪表（保存精确回译；`plain` 模式为 null） |
| `mtimeMs` | 磁盘修改时间基准（外部修改检测；`-1` = 应用内已知被改写） |

关键行为（均有测试覆盖）：

- **脏判定派生**：`isDirty()` 比较 `content !== savedDisplay`，撤销回保存状态即自动干净；
- **保存按快照写盘**：保存期间继续输入时，基准推进到快照但会话仍为脏，不会把后续输入误标成已保存；
- **过期回调丢弃**：保存回调返回时若已切换文件（`path` 不匹配），不修改新会话；
- **保存后推进 mtime**：否则下一次保存会把自己的写入误判成外部修改；
- **外部修改**：`checkExternalChange()` 在保存前比对 mtime，冲突时提示「重新载入 / 仍然覆盖」；
  AI 工具写入当前文件会调 `markExternallyChanged()` 打哨兵；
- **未保存保护**：返回、切换文件、Android 系统返回键（history 层接管）统一走
  「保存并继续 / 放弃修改 / 取消」。

**统一打开入口** `features/editor/openFile.ts`：文件树、检查结果「定位」、模板创建共用一条
读盘 → 建会话 → 写 store 的路径（旧实现三处各写一份，检查页丢跳转行号、会话缺追踪表）。

**打开方式判定**：`utils/paths.decideOpenMode` 决定条目进编辑器还是资源预览——
只有铁锈配置文件（.ini/.txt/.cfg/.conf/.rc/.template）可编辑，图片等一律只读预览。

## 5. AI 流式链路（Rust 代理）

```
前端 runAgentChat ──invoke──> Rust ai_stream
     │                          │ reqwest POST api.deepseek.com (SSE)
     │ <──tauri event ai://event──┘
     │  start / delta{text} / done{full_text, tool_calls}
     └─ 工具调用 → runTool（写文件经审批）→ 结果回传 → 继续（≤8 轮）
```

- 重活（HTTP + SSE 解析）在 Rust 线程，UI 零阻塞（P3 验收）；
- 事件增量限长 64KB/条，防超长行卡渲染；
- 对话循环在前端（工具执行需要 bridge fs 与审批 UI），职责清晰。

## 6. 与桌面版（ohmytx）的资产复用

| 资产 | 复用方式 |
| --- | --- |
| public/data/*（代码表/词典/官方单位/模板） | 原样复制（GPL-3.0 同许可） |
| semanticChecks 全套（22 文件） | 原样移植（含 63 个测试） |
| completion / rustLint / rustLanguage / EditorMirror | 原样移植（store 引用适配） |
| applyDiff / diff | 原样移植（Buffer → TextEncoder 适配） |
| rustSystemPrompt + modding-guide.md | 原样复制 |
| utils（settings/layout/paths/…） | 原样移植 |

**v2 云书包接入点**（接口已预留）：
- `bridge.store` 保持形状不变，云同步 = 新增云端 store 实现；
- `knowledge.*` 契约已在 types/bridge.ts 定义，v2 实现知识包/模板市场；
- 后端底座为 new-api（见 `tx产品报告/17-后端技术选型决策`），业务 API 走
  OpenAPI 风格，客户端对接以文档为准。

## 7. 测试

`tests/` 393 个 vitest 用例，分两层：

**纯逻辑（node 环境）**：语义检查器（16 规则 + 官方单位零误报）、自定义规则 schema、
补全（含 dialect 词）、lint 值校验、翻译往返无损、diff/applyDiff（重叠/越界/上下文校验）、
模板解析/写回、设置清洗、布局纯函数，以及编辑会话数据保护（中文连续保存、保存期间继续输入、
过期回调、外部修改冲突）、文件名校验与路径边界、mod-info 保留写回、打开方式判定、
打包往返（导出→重新导入逐字节一致）。

**组件交互（jsdom，`tests/*.test.tsx`）**：挂载真实页面组件 + 内存文件系统桥
（`tests/fixtures/memoryBridge.ts`），覆盖未保存保护的各分支、保存失败留在编辑器、
冲突的重新载入/仍然覆盖、文件树新建/重命名/删除、项目新建/删除/打包、中文显示层往返。
纯函数测试证明不了「点按钮会不会丢数据」，这一层就是补这个缺口。

运行：`npm test`（本机 Android 环境用 `scripts/local-test.sh test`）。
新增纯逻辑必须配套测试；涉及数据保护或文件操作的页面改动，优先补交互测试
（与桌面版开发纪律一致）。
