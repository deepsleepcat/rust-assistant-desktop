# 引擎渲染 DLC 接口

> 本文是**给 DLC 作者看的**：你把一个渲染程序放进指定目录并授权后，
> 单位预览就能调用它来渲染图片。
>
> 宿主设计上的约束与安全边界见 `engineDlc.ts` / `engineDlcTrust.ts` 的文件头注释。

---

## 这是什么

内置的单位预览（`src/features/editor/unitPreview/recipe.ts`）用 Canvas **仿制**游戏的合成逻辑，
能覆盖大多数情况，但遇到游戏特有的渲染细节可能对不上。

要做到「和游戏里一模一样」，唯一的办法是调用游戏自己的渲染代码。

**但本项目不提供、也不下载任何游戏引擎**——那是版权与 GPL-3.0 双重约束下不能做的事。
所以这里换一种做法：

> 宿主只定义**接口和目录**；渲染程序由**你自己**准备、放进目录、明确授权后使用。

引擎从哪来、怎么写，是你的自由；本项目只保证这套插座规格稳定。

---

## 1. 目录

```
<userData>/engine-dlc/          ← 设置 → 引擎 DLC →「打开目录」
    ├── my-renderer/            ← 一个子目录 = 一个 DLC
    │   ├── dlc.json            ← 清单（必须）
    │   ├── render.exe          ← 入口（清单里 entry 指向的文件）
    │   └── ...                 ← DLC 自带的任何其他文件
    └── another-one/
```

- Windows 上 `<userData>` 是 `%APPDATA%\rust-assistant-desktop`；界面上会显示完整路径。
- **目录名必须等于清单里的 `id`**。
- DLC 只会被扫描到，**不会被下载、不会被自动安装**。

仓库里的 `examples/engine-dlc-hello/` 是一个能直接复制过去用的最小示例。

---

## 2. 清单 `dlc.json`

```json
{
  "dlcVersion": 1,
  "id": "my-renderer",
  "name": "我的引擎渲染",
  "version": "1.0.0",
  "description": "用游戏引擎渲染单位预览",
  "entry": "render.exe",
  "args": ["--fast"],
  "timeoutMs": 30000
}
```

| 字段 | 必填 | 说明 |
|---|---|---|
| `dlcVersion` | ✅ | 协议版本，当前必须为 `1` |
| `id` | ✅ | 1–64 位（`A-Za-z0-9` 与 `._-`，首尾须字母数字），**必须与目录名一致** |
| `name` | ✅ | 1–128 字符，界面显示用 |
| `version` | ✅ | 1–64 字符 |
| `description` | ❌ | ≤512 字符 |
| `entry` | ✅ | DLC 目录内的**相对路径**；扩展名必须是 `.exe` / `.js` / `.mjs` / `.cjs` |
| `args` | ❌ | 最多 16 项、每项 ≤256 字符的固定参数（排在协议参数**之前**） |
| `timeoutMs` | ❌ | 1000–120000，默认 30000 |

**会被拒绝、并在设置页显示中文原因的写法：**

- 出现任何未知字段（键集合是封闭的，加字段要显式升版本）
- `id` 与目录名不一致
- `entry` 是绝对路径、含 `..`、或实际指向 DLC 目录之外（含符号链接逃逸）
- `entry` 是 `.bat` / `.cmd` / `.ps1` / `.sh` / 无扩展名
- `args` 含控制字符，或超过数量/长度上限

> `.bat`/`.cmd` 不收是有意的：那类文件必须经 `cmd.exe` 解释，等于把 shell 放回来。

---

## 3. 调用协议（版本 1）

宿主这样执行你的程序：

```
<entry> [清单里的 args...] --request <request.json 绝对路径> --output <preview.png 绝对路径>
```

- `.exe`：直接执行。
- `.js` / `.mjs` / `.cjs`：用 Electron 的二进制以 `ELECTRON_RUN_AS_NODE=1` 当纯 Node 运行
  （给不想编译的人一条路；仍是**独立子进程**）。
- **工作目录**（cwd）＝ DLC 自己的目录，可以放心用相对路径读自带文件。
- 不通过 shell；参数按数组原样传入，路径带空格也没问题。

**你要做两件事**：读 `--request` 的 JSON，往 `--output` 写一张 **PNG**。
退出码 `0` 且输出是合法 PNG → 成功；其他情况一律失败并回退到内置合成。

### 3.1 `request.json`

```json
{
  "protocolVersion": 1,
  "unitFile": "C:\\...\\units\\tank.ini",
  "unitContent": "[graphics]\nimage: tank.png\n...",
  "projectRoot": "C:\\...\\我的模组",
  "gamePath": "C:\\...\\Rusted Warfare",
  "view": {
    "frame": 0,
    "direction": 0,
    "animationState": "idle",
    "showWreck": false
  },
  "size": { "width": 560, "height": 420 },
  "outputPath": "C:\\...\\preview.png"
}
```

| 字段 | 用途 |
|---|---|
| `unitFile` | 单位文件**绝对路径**（解析同目录相对贴图的基准） |
| `unitContent` | 单位文件的**当前编辑器内容**（可能尚未落盘——渲染应以它为准） |
| `projectRoot` | 项目根绝对路径（解析 `ROOT:` / `CUSTOM:` 引用） |
| `gamePath` | 玩家自己配置的游戏安装目录；空字符串表示未配置 |
| `view.frame` / `view.direction` | 要渲染的帧号 / 朝向序号（从 0 起） |
| `view.animationState` | `idle` / `moving` / `attack` |
| `view.showWreck` | 是否叠加残骸 |
| `size` | 期望画面尺寸（像素） |
| `outputPath` | 与 `--output` 相同，方便只读 JSON 的实现 |

### 3.2 输出要求

- 必须是 **PNG**（宿主校验文件头 `89 50 4E 47 0D 0A 1A 0A`，改扩展名骗不过去）。
- 单张 **≤16 MB**。
- 宿主按 `view` **请求一次、渲染一次**，得到的是一张静态帧：
  引擎模式**不会**跟随动画逐帧播放（否则每帧都要启动一个进程）。

### 3.3 最小示例

见 `examples/engine-dlc-hello/`（Node 脚本，无需编译）。核心就是：

```js
const fs = require('node:fs')
const args = process.argv.slice(2)
const value = (flag) => args[args.indexOf(flag) + 1]

const request = JSON.parse(fs.readFileSync(value('--request'), 'utf8'))
// ……你的渲染逻辑，用 request.unitFile / request.gamePath 等……
fs.writeFileSync(value('--output'), pngBytes)
```

---

## 4. 出错时会怎样

**任何失败都不致命**：一律回退到内置合成，并在预览里显示一行中文原因。

| 情况 | 表现 |
|---|---|
| 没有 DLC / 未授权 | 预览里**不显示**「引擎渲染」按钮，行为与从前完全一致 |
| 清单不合法 | 设置页列出该条目并显示原因，不可授权 |
| 授权后程序被替换 | 指纹不匹配 → 自动变回「未授权」，需重新授权 |
| 退出码非零 | 显示退出码 + stderr 摘要（截断 200 字符） |
| 超时 | 强杀进程（Windows 上用 `taskkill /T` 连子树），提示秒数 |
| 没写输出 / 不是 PNG / 超过 16 MB | 显示对应原因 |
| 单位文件超过 2 MB | 直接拒绝，不启动子进程 |

---

## 5. 安全须知（写 DLC 前请读）

被授权的 DLC 会**以你的用户权限在本机运行**——和你在终端里手动运行它是同一回事，
能读写你能读写的一切。

因此：

- 只授权你信任的来源；
- 宿主会记录入口文件指纹，**程序被替换后需要重新授权**；
- 授权是显式动作，走的是**系统确认对话框**，不是「文件放进去就算数」；
- 撤销授权随时可在设置页进行，立即生效。

---

## 6. 当前限制

| 项 | 状态 |
|---|---|
| 宿主接口（目录/清单/扫描/授权/调用/回退） | ✅ 已实现并测试 |
| 设置页（目录、列表、授权/撤销） | ✅ |
| 单位预览接入（引擎模式 + 失败回退） | ✅ |
| **一个真正能用的引擎 DLC** | ❌ 由 DLC 作者自行实现，不在本项目范围内 |
| 引擎渲染跟随动画逐帧播放 | ❌ 刻意不做（每帧一个进程代价过高） |
| 单位预览之外的其他渲染点 | ❌ 未接入 |

> **注意**：这套接口解决的是「让引擎渲染能合法地接进来」，**不自动带来精确渲染**——
> 精度取决于你自己的桥接实现。没有 DLC 时，预览仍是原来的本地合成。
>
> `.js` 入口依赖 Electron 的 `RunAsNode` fuse（本项目未改动，保持默认开启）。
> 若该 fuse 被关闭，请改用 `.exe` 入口。
