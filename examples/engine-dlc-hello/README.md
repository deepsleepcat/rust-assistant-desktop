# 引擎渲染 DLC · 最小示例

这是一个**能直接用的最小示例**，用来验证接口是否接通。
它不加载任何游戏引擎，只输出一张 1×1 的占位 PNG。

## 怎么用

1. 把整个 `engine-dlc-hello` 文件夹复制到指定目录（设置 → 引擎 DLC → 「打开目录」）：
   ```
   <userData>/engine-dlc/engine-dlc-hello/
   ```
2. 回到 设置 → 引擎 DLC，点「刷新」——应能看到「最小示例（占位图）」。
3. 点「授权运行」，在系统确认框里点「授权运行」。
4. 打开任意单位的预览，点工具栏上的「引擎渲染」。
   画布会变成一张深色图（占位），说明链路已通。

## 换成真正的引擎渲染

编辑 `render.cjs`，把最后写 PNG 的那两行换成你自己的桥接逻辑：

- `request.unitFile` — 单位文件绝对路径
- `request.unitContent` — 单位文件的当前编辑器内容（可能未落盘，应以它为准）
- `request.gamePath` — 玩家配置的游戏安装目录
- `request.projectRoot` — 项目根路径
- `value('--output')` — 把 PNG 写到这个路径

> 也可以换成 `.exe` 入口（把 `dlc.json` 里的 `entry` 改成你的程序名）——
> 那样能用任意语言写，包括直接调用游戏自己的引擎代码。

协议全文见仓库根目录的 [ENGINE-DLC.md](../../ENGINE-DLC.md)。
