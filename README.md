# 铁锈助手 · 电脑版（Rust Assistant Desktop）

面向《铁锈战争》（Rusted Warfare）模组开发的 **Windows 桌面工作台**：
用代码编辑器的体验写模组 ini 代码，并配有 AI 助手帮你写代码、查字段、改文件。

## 特色

- **三栏工作台**：左项目/文件树 · 中多标签编辑器 · 右 AI 对话区
- **模组专用编辑器**（CodeMirror 6）：ini 高亮、自动补全、节大纲、折叠、格式化、中英翻译
- **AI 助手**：DeepSeek V4 驱动，思考过程实时显示，可调用工具，写文件需审批
- **模组工具**：新建模组 / 新建单位 / 打包 `.rwmod` / 单位检查
- **自动更新**：一键检查更新，更新包托管在 GitHub Releases（免费）
- 浅色 / 深色 / 跟随系统主题、自定义背景、鼠标粒子特效、命令面板（Ctrl+K）、中文路径与 UTF-8 BOM 支持

## 快速开始

要求：Windows 10/11、Node.js 20+

```bash
npm install        # 安装依赖
npm run dev        # 桌面开发模式（自动编译主进程 + 热更新）
npm run dev:web    # 纯浏览器预览 http://localhost:5173（Mock 数据，无需 Electron）
```

生产构建与打包：

```bash
npm run build      # 构建渲染进程 + 主进程
npm start          # 以生产模式启动
npm run pack       # 打包便携版 exe → release/（electron-builder）
```

> AI 对话需要 DeepSeek API Key，在「设置 → AI」中填写，仅存本地。

## 质量检查

```bash
npm run check      # 类型检查 + ESLint + 56 个单元测试，一键全跑
```

## 技术栈

Electron · React 19 · TypeScript · Vite · Zustand · CodeMirror 6 · Pi Agent（AI 引擎）· Vitest

## 许可证

[GNU GPL v3.0](LICENSE)。代码表与词库数据提取自 GPL-3.0 的铁锈助手 Android 版，随本项目一并以 GPL-3.0 分发。

## 更新与安全说明

- 安装包由 GitHub Actions（`.github/workflows/release.yml`）在打 `v*` tag 时自动构建并上传 Release，不从本地环境出包（供应链缓解）。
- 安装包当前**未做 Authenticode 代码签名**：首次安装可能触发 Windows SmartScreen 提示，属预期行为；更新包通过 GitHub Releases + `latest.yml` 的 sha512 校验完整性。

### 代码签名（可选，需要证书）

安装包当前未做 Authenticode 签名（需要付费 OV/EV 代码签名证书）。已购证书后，在仓库 Settings → Secrets 配置：

- `WIN_CSC_LINK`：证书文件（.pfx 的 base64）
- `WIN_CSC_KEY_PASSWORD`：证书密码

CI 构建会自动签名（electron-builder 标准变量），消除 SmartScreen 警告。未配置时功能不受影响，仅首次安装有提示。
