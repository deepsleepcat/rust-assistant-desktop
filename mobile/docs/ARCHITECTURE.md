# 铁锈助手手机版 · 架构文档

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
- **AI 工具路径**：`rustAgentTools.safeRelPath` 拒绝绝对路径 / `..` 穿越 / 空路径 /
  NUL 字节；只读工具限制扩展名（配置文件/JSON/MD）；
- **写文件审批**：writeFile/applyDiff 必须经用户审批弹窗（diff 预览），拒绝则
  回传模型调整；diff 应用前全量校验（上下文行不信任模型，从原文件原样取）；
- **导入解压**：zip 条目拒绝绝对路径与 `..`（防 zip slip）；
- **AI Key**：仅存本地 store（app-state.json），不写日志、不入 git；
- **无凭据字面量**：源码/测试不包含任何可用 API Key。

## 4. AI 流式链路（Rust 代理）

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

## 5. 与桌面版（ohmytx）的资产复用

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

## 6. 测试

`tests/` 290 个 vitest 用例（node 环境），覆盖：语义检查器（16 规则 + 官方单位零误报）、
自定义规则 schema、补全（含 dialect 词）、lint 值校验、翻译往返无损、diff/applyDiff
（重叠/越界/上下文校验）、模板解析/写回、设置清洗、布局纯函数。

运行：`npm test`。新增纯逻辑必须配套测试（与桌面版开发纪律一致）。
