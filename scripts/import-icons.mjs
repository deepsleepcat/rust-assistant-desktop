/**
 * M8 图标导入：从 570+Icons-CN-v1.0.3 精选应用 UI 图标 → public/icons/<英文名>.svg
 * 用法：node scripts/import-icons.mjs
 */
import { cp, mkdir } from 'node:fs/promises'
import path from 'node:path'

const LIB = 'W:/mao/570+Icons-CN-v1.0.3'
const DEST = new URL('../public/icons/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')

/** 中文图标名 → 应用内英文文件名 */
const ICONS = {
  音乐: 'music',
  图像: 'image',
  播放: 'play',
  暂停: 'pause',
  撤销: 'undo',
  重做: 'redo',
  上传: 'upload',
  导出: 'export',
  菜单: 'menu',
  消息: 'message',
  通知: 'bell',
  用户: 'user',
  深色模式: 'moon',
  浅色模式: 'sun',
  取色器: 'picker',
  链接: 'link',
  上锁: 'lock',
  解锁: 'unlock',
  可见: 'eye',
  不可见: 'eye-off',
  代码: 'code',
  文档: 'document',
  书签: 'bookmark',
  排行: 'ranking',
  标签: 'tag',
  图钉: 'pin',
  云: 'cloud',
  雷电: 'bolt',
  放大: 'zoom-in',
  缩小: 'zoom-out',
  分享: 'share',
  停止: 'stop',
  时间: 'clock',
  日历: 'calendar',
  展开: 'expand',
  铅笔: 'edit',
  缩略图: 'grid',
  复选框: 'check-square',
}

async function main() {
  await mkdir(DEST, { recursive: true })
  let done = 0
  const missing = []
  for (const [zh, en] of Object.entries(ICONS)) {
    // 图标分布在 7 个大类目录，逐类查找
    let found = false
    for (const cat of ['1.用户界面', '2.媒体与科技', '3.编辑工具', '4.形状与符号', '5.游戏', '6.物品', '7.自然与饮食']) {
      const p = path.join(LIB, cat, `${zh}_svg.svg`)
      try {
        await cp(p, path.join(DEST, `${en}.svg`))
        found = true
        break
      } catch {
        /* 继续找下一类 */
      }
    }
    if (found) {
      done++
      console.log(`✓ ${zh} → ${en}.svg`)
    } else {
      missing.push(zh)
      console.log(`✗ 未找到：${zh}`)
    }
  }
  console.log(`\n完成：${done}/${Object.keys(ICONS).length} 个图标导入到 public/icons/`)
  if (missing.length) console.log('缺失：', missing.join('、'))
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
