/**
 * 引擎渲染 DLC 的最小示例（不需要编译，Node 脚本即可）。
 *
 * 它**不加载任何游戏引擎**：只读一下宿主传来的 request.json，
 * 然后写一张 1×1 的深色 PNG 到 --output。
 * 用途是验证「目录 → 授权 → 预览里出现引擎渲染」这条链是否接通。
 *
 * 换成真正的渲染：把下面写 PNG 的那两行替换成你的引擎桥接逻辑即可，
 * 素材就在 request.unitFile / request.gamePath / request.projectRoot 里。
 *
 * 协议全文见仓库根目录的 ENGINE-DLC.md。
 */
const fs = require('node:fs')

const args = process.argv.slice(2)
const value = (flag) => args[args.indexOf(flag) + 1]

const request = JSON.parse(fs.readFileSync(value('--request'), 'utf8'))
console.log(`[engine-dlc-hello] 协议版本 ${request.protocolVersion}，单位 ${request.unitFile}`)
console.log(`[engine-dlc-hello] 视图 帧=${request.view.frame} 朝向=${request.view.direction} 状态=${request.view.animationState}`)

// 一张 1×1 的深色 PNG（替换成你自己的渲染结果）
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
)
fs.writeFileSync(value('--output'), png)
