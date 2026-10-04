# 铁锈工坊（ohmytxphone）

Rusted Warfare 模组随身编辑器（本地轻量版）。

技术栈：**Tauri Mobile**（Rust 系统层 + 系统 WebView + React 19 + TypeScript + CodeMirror 6）。
纯本地运行，零服务器依赖；AI 对话 BYOK（用户自配 DeepSeek API Key，仅存本机）。

## 功能

- **项目**：新建空白项目、导入模组（`.rwmod`/`.zip` 压缩包或文件夹）、内置示例项目（离线可用）、
  打包导出 `.rwmod`、删除项目
- **文件管理**：文件树懒加载展开、新建文件/文件夹、重命名、删除；名称校验
  （拒绝路径分隔符、Windows 保留字符、`.`/`..`、同目录重名）
- **模组文件编辑**：ini/.template 编辑器（语法高亮、自动补全、节折叠、大纲、悬停文档），
  mod-info.txt 结构化编辑（保留注释与未知键的增量写回）
- **手机编辑工具栏**：撤销 / 重做 / 搜索替换 / 缩进 / 常用符号插入 / 触发补全
- **数据保护**：中文显示层保存精确回译；返回、切换文件前有未保存修改则先确认；
  磁盘被外部改动（其它应用、AI 工具）时提示「重新载入 / 仍然覆盖」；Android 系统返回键接入同一处理
- **官方单位模板库**：17 个内置官方模板 + 新建单位向导（选模板 → 填参数 → 创建）
- **语义检查器**：16 个规则 + 结果列表（文件 + 行号 + 原因 + 修复建议，点击定位到行）
- **资源预览**：图片只读预览（像素尺寸、适应/原始缩放切换）；其它资源显示信息卡片，
  不再按 UTF-8 文本打开
- **AI 对话（BYOK）**：DeepSeek 流式对话 + 10 个工具（写文件需审批、行级预览、可拒绝）；
  AI 写入当前正在编辑的文件时会标记冲突，避免静默覆盖
- **中文显示层**：键/节显示中文，保存精确回译英文（不破坏原文）

明确不做（后续版本）：云书包同步/账号/社区、社区 AI 后端、地图编辑、游戏引擎集成、模组加密。

## 开发

```bash
npm ci                         # 在 mobile/ 目录安装锁定的依赖
npm run check                  # TypeScript 类型检查 + 单元测试
npm run build                  # 前端生产构建（不生成 APK）
npm run tauri android dev      # Android 开发（需要模拟器/真机）
npx tauri android build -d -t aarch64 -t x86_64   # 出 debug APK
```

### 本机（Android / Termux）跑测试与构建

会话工作区所在的分区（`/storage/emulated/0`）是 **noexec 的 FUSE**：esbuild、rollup 的
原生二进制无法执行，`node_modules/.bin` 的符号链接也建不出来。仓库自带脚本先把源码
同步到应用私有目录（可执行）再运行：

```bash
scripts/local-test.sh test     # vitest（必须线程池：forks 池在 Termux 下 worker 立即退出 → EPIPE）
scripts/local-test.sh build    # tsc 类型检查 + vite 生产构建
```

- 沙箱目录默认 `$HOME/work/ohmytxphone`，可用 `OHMYTX_SANDBOX` 覆盖；源码权威始终在仓库目录。
- 首次运行会把 `node_modules` 复制进沙箱（约 90MB）；仓库内安装依赖需加
  `--no-bin-links --ignore-scripts`（跳过 esbuild 的二进制校验）。
- Android 出包（Gradle + NDK）仍需 JDK 17、Android SDK 36、NDK 27.1，建议交给电脑或 CI
  （本机不可行的实测原因见 [docs/BUILD-AND-DEVICE-CHECKLIST.md](docs/BUILD-AND-DEVICE-CHECKLIST.md)）。

### Android 构建环境（Windows）

- Node.js 22.12+（与自动检查环境一致）
- JDK 17（Temurin）、Android SDK（platform-tools、platforms;android-36、build-tools;36.0.0、NDK 27.1）；当前 Android 工程的 compileSdk / targetSdk 为 36
- Rust stable + targets：`rustup target add aarch64-linux-android x86_64-linux-android`
- 模拟器加速：AEHD 驱动（`sdkmanager "extras;google;Android_Emulator_Hypervisor_Driver"`）
- 环境变量：`ANDROID_HOME`、`ANDROID_SDK_ROOT`（AVD 建议放非系统盘：`ANDROID_AVD_HOME`）

## 架构

见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)（模块划分、桥契约、编辑会话与文件通道边界、
云书包接入预留）。

## 目录结构

```
src/
├─ services/bridge.ts     Tauri 桥（BridgeApi 契约实现：fs/store/打包/导入/AI）
│                         另有手机版扩展入口：importMod / deleteProject /
│                         uniqueProjectDir / writeProjectBinary
├─ stores/workspace.ts    工作区状态（zustand，持久化到 appData/app-state.json）
│                         编辑会话只存内存（editorSession / editorJump）
├─ features/
│  ├─ editor/             CodeMirror 编辑器（语言/补全/lint/语义检查/大纲/折叠）
│  │  ├─ editSession.ts   编辑会话纯逻辑（显示层与磁盘内容分离记账、脏判定、冲突检测）
│  │  ├─ openFile.ts      统一文件打开入口（文件树/检查定位/模板共用）
│  │  ├─ FileTreePanel.tsx 文件树（懒加载、新建/重命名/删除）
│  │  ├─ AssetPreview.tsx  图片与资源只读预览
│  │  └─ EditorToolbar.tsx 手机编辑工具栏
│  ├─ ai/                 AI 对话循环（aiClient）+ 10 工具（rustAgentTools）+ diff/applyDiff
│  └─ modTools/           模板系统（templates.ts）+ 打包（packArchive 纯逻辑 +
│                         packWorker 线程胶水）+ mod-info 保留写回（modInfo.ts）
│                         + 示例项目（sampleProject.ts）
├─ components/            通用组件（AppIcon、MobileDialog 弹层）
├─ screens/               项目/编辑器/模板库/检查/AI/设置 六屏
├─ ai/rustSystemPrompt.ts AI 系统提示词（含 modding-guide 领域知识）
└─ utils/                 纯函数工具（settings/layout/paths/entryName/viewport…）
src-tauri/
├─ src/lib.rs             Rust 层：ai_stream 流式代理（SSE → tauri 事件）+ 插件装配
└─ capabilities/          fs 权限（appdata 递归读写 scope）
public/data/              代码表/词典/官方单位/模板（与桌面版共享资产）
scripts/local-test.sh     本机测试/构建沙箱脚本（noexec 分区绕行）
tests/                    vitest 用例（393 个：纯逻辑 + 组件交互）
├─ fixtures/memoryBridge.ts   组件测试用的内存文件系统桥
├─ editorScreen.test.tsx      编辑器页交互（未保存保护/冲突/中文往返/文件树操作）
└─ projectsScreen.test.tsx    项目页交互（新建/删除/打包）
docs/BUILD-AND-DEVICE-CHECKLIST.md  出包步骤与 29 项真机验收清单
```

## 许可证

GPL-3.0（与桌面版一致；内置数据资产随项目同许可分发）。
