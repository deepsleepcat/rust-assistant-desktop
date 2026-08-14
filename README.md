# 铁锈助手 · 电脑版（Rust Assistant Desktop）

面向《铁锈战争》（Rusted Warfare）模组开发的 **Windows 桌面工作台**：
用代码编辑器的体验写模组 ini 代码，并配有 AI 助手帮你写代码、查字段、改文件。

## 特色

- **三栏工作台**：左项目/文件树 · 中多标签编辑器 · 右 AI 对话区
- **模组专用编辑器**（CodeMirror 6）：ini 高亮、自动补全（含 `@type`/`@customType`/`${变量}` 联想与图片预览）、智能换行、节大纲、折叠、格式化、中英翻译、lint 实时检查
- **AI 助手**：DeepSeek V4 驱动，思考过程实时显示，可调用工具，写文件需审批（审批弹窗带**行级 diff 预览**）；每次写文件自动存档，可**一键撤销 / 恢复到任意历史版本**；写完后**自动质检**（文件 + 行号 + 原因 + 修复建议，可一键定位）
- **模组工具**：新建 / 导入 / 打包 `.rwmod`、新建单位、单位检查、全局查找替换、优化清理、值类型管理（自定义补全规则）
- **参考库**：代码表查字段用途、单位库参考官方单位、炮塔可视化编辑器
- **游戏集成**：自动检测铁锈战争安装目录，一键导入官方单位示例模组、导入游戏内已装模组
- **自动更新**：一键检查更新，更新包托管在 GitHub Releases（免费）
- 浅色 / 深色 / 跟随系统主题、自定义背景、鼠标粒子特效、命令面板（Ctrl+K）、文件树排序与隐藏文件开关、中文路径与 UTF-8 BOM 支持

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
npm run check      # 类型检查 + ESLint + 354 个单元测试，一键全跑
```

## 技术栈

Electron · React 19 · TypeScript · Vite · Zustand · CodeMirror 6 · Pi Agent（AI 引擎）· Vitest

## 许可证

[GNU GPL v3.0](LICENSE)。代码表数据来自 Rusted Warfare Mod Support（1.15 官方数据）与铁锈助手数据，随本项目一并以 GPL-3.0 分发。

## 更新与安全说明

- 安装包由 GitHub Actions 在打 `v*` tag 时自动构建并发布，不从本地环境出包（供应链缓解）。
- 首次安装可能出现 Windows 安全提示，点「更多信息 → 仍要运行」即可正常使用；更新包均带完整性校验。

