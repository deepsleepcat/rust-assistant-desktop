/**
 * 资源/HUD 语义（checkResourceHudSemantics）：
 * 资源路径类键（image/image_wreak/image_turret/image_shadow/iconImage/beamImage 等）：
 * 1) 值以 / 或 \ 开头 → 警告（游戏按单位目录相对路径加载，前导斜杠会找不到文件）；
 * 2) 值含 ..（路径穿越）→ 错误（越出单位目录的引用在打包后会失效且不安全）；
 * 3) ctx.unitNames 提供时（写后质检/全量检查），引用项目内单位名（如
 *    image 引用另一单位）检查存在性——第一版不做跨文件资源存在性，
 *    只做路径形态校验（避免误报内置 SHARED: 资源）。
 * 注：引擎没有 minimapIcon/icon 键——小地图图标由引擎自动找 icon.png 文件；
 *    iconImage 是真实键（原版单位在用），检查范围里保留。
 */
import type { SemanticChecker, SemanticIssue } from './types'
import { issue, keyValuesInSection, getIni, sectionEnName, toEnKey } from './helpers'

/** 资源路径类键（小写） */
const RESOURCE_KEYS = new Set([
  'image', 'image_wreak', 'image_turret', 'image_shadow', 'image_foot_shadow',
  'image_end_shadow', 'iconimage', 'beamimage', 'beamimageend', 'beamimagestart',
])

export const checkResourceHudSemantics: SemanticChecker = {
  id: 'checkResourceHudSemantics',
  title: '资源/HUD 语义',
  description: '图片等资源路径不允许前导斜杠与 .. 越界引用',
  defaultOn: true,
  check(content, ctx) {
    const issues: SemanticIssue[] = []
    const { sections } = getIni(ctx, content)
    const zhToEn = ctx?.zhToEn
    for (const sec of sections) {
      if (sectionEnName(sec, zhToEn) !== 'graphics') continue
      for (const kv of keyValuesInSection(sec)) {
        const key = toEnKey(kv.key, zhToEn).toLowerCase()
        if (!RESOURCE_KEYS.has(key)) continue
        const value = kv.value
        if (!value || value === 'NONE' || value === 'AUTO' || value === 'SHARED' || value.startsWith('SHARED:')) continue
        if (value.startsWith('/') || value.startsWith('\\')) {
          issues.push(
            issue(
              kv.line,
              `「${kv.key}」以斜杠开头（${value}），游戏按单位目录相对路径加载会找不到文件`,
              `去掉开头的斜杠，写成相对路径（如 image: base3.png）`,
              'checkResourceHudSemantics',
              'warning',
              value,
            ),
          )
        }
        if (/(^|\/|\\|:)\.\.($|\/|\\)/.test(value)) {
          issues.push(
            issue(
              kv.line,
              `「${kv.key}」包含 .. 路径穿越（${value}），打包后引用会失效`,
              `把资源复制到单位目录内，用相对路径引用`,
              'checkResourceHudSemantics',
              'error',
              value,
            ),
          )
        }
      }
    }
    return issues
  },
}
