# 铁锈助手 · 电脑版（Rust Assistant Desktop）

面向《铁锈战争》（Rusted Warfare）模组开发的桌面工作台。

界面融合了 **Codex 的简洁布局** 与 **VS Code 的文件/编辑器体验**：

- 左侧：项目列表 + 文件树
- 中间：多标签代码编辑区
- 右侧：AI 对话区（每个项目可开多个独立对话）

## 完整文档

👉 项目的完整说明（目录结构、每个文件职责、全部功能、全部接口）见 **[docs/PROJECT.md](docs/PROJECT.md)**。

## 当前进度（M0–M5 完成，v0.1.0）

✅ 三栏桌面界面（白色主体 + Google 彩虹装饰，可切深色）
✅ 自定义背景（纯色 / 渐变 / 图片，支持透明度与模糊）
✅ 打开项目、文件树（新建/重命名/删除到回收站）、多标签编辑、安全保存
✅ 项目级多对话管理（创建/重命名/归档/切换），数据已按最终形态存储
✅ 设置面板、命令面板（Ctrl+K）、状态栏、中文路径/UTF-8 BOM
✅ AI 助手（M4）：DeepSeek 驱动，思考显示 / 工具调用 / 写文件审批
✅ 模组工具（M5）：新建模组 / 新建单位 / 打包 .rwmod / 单位检查
⏳ M6 在线功能与安装包（暂缓）

> AI 对话已接入真实 DeepSeek 模型（M4），需要先在 设置 → AI 中填写 API Key。

## 运行方式

要求：Windows 10/11、Node.js 20+

```bash
# 安装依赖（首次）
npm install

# 方式一：桌面应用（开发模式，带热更新）
npm run dev

# 方式二：纯浏览器预览（不启动桌面窗口，界面功能相同）
npm run dev:web
# 然后浏览器打开 http://localhost:5173

# 构建 + 启动（生产模式）
npm run build
npm start
```

> 提示：浏览器预览模式使用的是「示例模组」（内存假文件系统），
> 方便不装 Electron 也能看界面；桌面模式下是真实的文件夹。

## 质量检查

```bash
npm run check   # 类型检查 + 代码规范 + 单元测试（一条命令全跑）
npm test        # 只跑单元测试
```

## 项目结构

```
src/                    界面代码（React + TypeScript）
├─ app/                 应用骨架（主题、快捷键）
├─ components/          通用组件（弹窗、图标、标题栏…）
├─ features/            功能模块
│  ├─ workspace/        项目列表、命令面板
│  ├─ project/          文件树
│  ├─ editor/           编辑器与标签页
│  ├─ conversation/     多对话区
│  └─ settings/         设置面板
├─ stores/              全局状态（Zustand）
├─ services/            桌面桥（Electron/Mock 双实现）
├─ types/               领域模型与通信契约
└─ styles/              设计令牌与主题
electron/               桌面主进程（安全 IPC、文件操作、本地存储）
tests/                  单元测试
docs/                   架构与数据文档
```

## 参考与来源

本项目参考了三个开源/自有项目（详见 `docs/THIRD-PARTY.md`）：

| 来源 | 用途 |
| --- | --- |
| 铁锈助手 Android 版（`rust-assistant-1.0.1`） | 功能清单、模组/代码数据结构参考 |
| 旧版 Python 工具（`tx`） | 文件树、翻译、补全等功能的思路 |
| Pi Agent Harness（`pi`，MIT 协议） | 下一阶段 AI 对话的 Agent 核心 |

图标库（`570+Icons-CN-v1.0.3`）与鼠标特效（`BASpark`，MIT）将在后续阶段按需选用，不整体打包。
