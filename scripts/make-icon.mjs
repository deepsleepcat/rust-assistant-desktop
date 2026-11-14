/**
 * make-icon.mjs — 重新生成应用图标（build/icon.ico / icon-256.png / icon-1024.png）。
 *
 * 设计（用户拍板）：透明背景 + 黑色 R 字形（#111111，与界面 text-primary 同源），
 * 字形紧裁后居中占正方形画布约 64%——旧图标的问题是字形歪在画布左上角、
 * 右下大片空白，任务栏里像被拉长的长方形；第一版占 84% 偏大，收敛到 64%。
 *
 * 用法：node scripts/make-icon.mjs
 * 依赖：puppeteer-core + 本机 Chrome/Edge（渲染 SVG 与 canvas 缩放）
 * ICO 打包：PNG 直嵌格式（Vista+ 标准，png-to-ico 同款做法）
 */
import puppeteer from 'puppeteer-core'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const CANDIDATES = [
  'C:/Users/mao/AppData/Local/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
]
const CHROME = CANDIDATES.find((p) => fs.existsSync(p))
if (!CHROME) { console.error('未找到 Chrome/Edge'); process.exit(1) }

const here = path.dirname(fileURLToPath(import.meta.url))
const buildDir = path.join(here, '..', 'build')
fs.mkdirSync(buildDir, { recursive: true })

/** LogoR 的 R 字形路径（src/components/LogoR.tsx 同源），紧裁 viewBox 使字形近似正方形 */
const R_PATH = 'M7 23V5h8.7c4.6 0 7.3 2.2 7.3 6 0 2.7-1.4 4.6-3.8 5.5L24 23h-4.8l-4.1-5.8h-3.6V23H7Zm4.5-9.5h3.7c2.1 0 3.3-.8 3.3-2.5s-1.2-2.5-3.3-2.5h-3.7v5Z'
const R_VIEWBOX = '6.5 4.5 18 19'
const SIZES = [16, 24, 32, 48, 64, 128, 256]
const MASTER = 1024

const browser = await puppeteer.launch({ executablePath: CHROME, headless: true })
const page = await browser.newPage()
await page.setViewport({ width: MASTER, height: MASTER, deviceScaleFactor: 1 })

await page.setContent(`<!doctype html>
<html><body style="margin:0;background:transparent">
<div id="icon" style="width:${MASTER}px;height:${MASTER}px;position:relative">
  <svg viewBox="${R_VIEWBOX}" style="position:absolute;left:50%;top:50%;transform:translate(-50%,-51%);
       width:${Math.round(MASTER * 0.64)}px;height:${Math.round(MASTER * 0.64)}px" preserveAspectRatio="xMidYMid meet">
    <path d="${R_PATH}" fill="#111111"/>
  </svg>
</div>
<img id="src" alt="" style="display:none">
</body></html>`, { waitUntil: 'networkidle0' })

const masterPng = await page.screenshot({ clip: { x: 0, y: 0, width: MASTER, height: MASTER }, omitBackground: true })
fs.writeFileSync(path.join(buildDir, 'icon-1024.png'), masterPng)
console.log('icon-1024.png  ✓')

// 页内 canvas 逐尺寸缩放（浏览器 Lanczos 级平滑质量优于 node 侧手写重采样）
const sizes = await page.evaluate(async (masterUrl, sizeList) => {
  const img = new Image()
  await new Promise((resolve, reject) => { img.onload = resolve; img.onerror = reject; img.src = masterUrl })
  return sizeList.map((size) => {
    const canvas = document.createElement('canvas')
    canvas.width = size
    canvas.height = size
    const ctx = canvas.getContext('2d')
    ctx.imageSmoothingEnabled = true
    ctx.imageSmoothingQuality = 'high'
    ctx.drawImage(img, 0, 0, size, size)
    return { size, url: canvas.toDataURL('image/png') }
  })
}, `data:image/png;base64,${masterPng.toString('base64')}`, SIZES)

const pngs = new Map(sizes.map((s) => [s.size, Buffer.from(s.url.split(',')[1], 'base64')]))
fs.writeFileSync(path.join(buildDir, 'icon-256.png'), pngs.get(256))
console.log('icon-256.png   ✓')

// 打包 ICO：6 字节头 + 每尺寸 16 字节目录项 + PNG 数据（尺寸 256 用 0 表示）
const entries = SIZES.map((size) => ({ size, data: pngs.get(size) }))
const header = Buffer.alloc(6)
header.writeUInt16LE(0, 0)
header.writeUInt16LE(1, 2)
header.writeUInt16LE(entries.length, 4)
const dirSize = 6 + entries.length * 16
let offset = dirSize
const dirs = []
const blobs = []
for (const { size, data } of entries) {
  const dir = Buffer.alloc(16)
  dir[0] = size === 256 ? 0 : size
  dir[1] = size === 256 ? 0 : size
  dir[2] = 0
  dir[3] = 0
  dir.writeUInt16LE(1, 4)
  dir.writeUInt16LE(32, 6)
  dir.writeUInt32LE(data.length, 8)
  dir.writeUInt32LE(offset, 12)
  dirs.push(dir)
  blobs.push(data)
  offset += data.length
}
fs.writeFileSync(path.join(buildDir, 'icon.ico'), Buffer.concat([header, ...dirs, ...blobs]))
console.log('icon.ico       ✓  层:', SIZES.join('/'))
await browser.close()
