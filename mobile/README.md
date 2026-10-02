# 铁锈助手 · 手机版（ohmytxphone）

Rusted Warfare 模组随身编辑器（第一版 · 本地轻量版）。

技术栈：**Tauri Mobile**（Rust 系统层 + 系统 WebView + React 19 + TypeScript + CodeMirror 6）。
纯本地运行，零服务器依赖；AI 对话 BYOK（用户自配 DeepSeek API Key，仅存本机）。

## 功能（第一版）

- **模组文件编辑**：ini/.template 编辑器（语法高亮、自动补全、节折叠、大纲、悬停文档），mod-info.txt 结构化编辑
- **官方单位模板库**：17 个内置官方模板 + 新建单位向导（选模板 → 填参数 → 创建）
- **语义检查器**：拼写、必填字段、引用存在性、数值为正等 16 个规则 + 结果列表（文件 + 行号 + 原因 + 修复建议，点击跳转）
- **AI 对话（BYOK）**：DeepSeek 流式对话 + 10 个工具（listProject/readFile/searchInProject/grepInProject/sectionOutline/codeTable/queryReference/generateCheckCases/writeFile/applyDiff），写文件需审批（行级预览），可拒绝
- **一键打包 .rwmod**：JSZip + Web Worker（打包不阻塞界面），系统对话框选择保存位置
- **导入/导出**：SAF 目录 / .rwmod / .zip 导入（自动解压），打包导出分享
- **中文显示层**：键/节显示中文，保存精确回译英文（不破坏原文）

明确不做（后续版本）：云书包同步/账号/社区（v2）、社区 AI 后端（v3）、地图编辑、游戏引擎集成、模组加密。

## 开发

```bash
npm install
npm run tauri android dev      # Android 开发（需要模拟器/真机）
npm test                       # vitest 单元测试（290 个用例）
npx tauri android build -d -t aarch64 -t x86_64   # 出 debug APK
```

### Android 构建环境（Windows）

- JDK 17（Temurin）、Android SDK（platform-tools、platforms;android-35、build-tools;35.0.0、NDK 27.1）
- Rust stable + targets：`rustup target add aarch64-linux-android x86_64-linux-android`
- 模拟器加速：AEHD 驱动（`sdkmanager "extras;google;Android_Emulator_Hypervisor_Driver"`）
- 环境变量：`ANDROID_HOME`、`ANDROID_SDK_ROOT`（AVD 建议放非系统盘：`ANDROID_AVD_HOME`）

## 架构

见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)（模块划分、桥契约、目录约定，为 v2 云书包接入预留）。

## 目录结构

```
src/
├─ services/bridge.ts     Tauri 桥（BridgeApi 契约实现：fs/store/打包/导入/AI）
├─ stores/workspace.ts    工作区状态（zustand，持久化到 appData/app-state.json）
├─ features/
│  ├─ editor/             CodeMirror 编辑器（语言/补全/lint/语义检查/大纲/折叠，移植自桌面版）
│  ├─ ai/                 AI 对话循环（aiClient）+ 10 工具（rustAgentTools）+ diff/applyDiff
│  └─ modTools/           模板系统（templates.ts）+ 打包 Worker（packWorker.ts）
├─ screens/               项目/编辑器/模板库/检查/AI/设置 六屏
├─ ai/rustSystemPrompt.ts AI 系统提示词（含 modding-guide 领域知识）
└─ utils/                 纯函数工具（settings/layout/paths/…，与桌面版同源）
src-tauri/
├─ src/lib.rs             Rust 层：ai_stream 流式代理（SSE → tauri 事件）+ 插件装配
└─ capabilities/          fs 权限（appdata 递归读写 scope）
public/data/              代码表/词典/官方单位/模板（与桌面版共享资产）
tests/                    290 个 vitest 用例（语义检查器/补全/lint/diff/模板/设置…）
```

## 许可证

GPL-3.0（与桌面版一致；内置数据资产随项目同许可分发）。
