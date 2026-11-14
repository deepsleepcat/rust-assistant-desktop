/**
 * 炮塔段（[turret_*]）解析与写回（纯函数，供炮塔编辑器使用）。
 * 铁锈单位文件里武器 = [turret_数字] 或 [turret_名称]（x/y 为炮塔相对单位图中心的像素坐标）
 * + [projectile_*] 弹体；官方单位两种混用（[turret_1]/[turret_main]/[turret_antiair1]…），
 * 模组也会用中文命名（[turret_枪]）。引擎把文件里出现的 [turret_*] 按出现顺序编号，
 * 会话返回的 turrets[].index 就是该顺序（1 基），因此这里同样按出现顺序编号。
 *
 * 中文显示层兼容：解析/写回可传入 zhToEn 回译函数——中文模式的内容是
 * [炮塔_1] / x坐标: 形式，经词典回译成英文键后再匹配；写回按「原始行键名」替换，
 * 不改变用户文件里的键名语言。
 */
export interface TurretEntry {
  /** 炮塔序号（1 基，按文件中 [turret_*] 出现顺序；与 DLC 会话 turrets[].index 对应） */
  index: number
  /** 节名后缀（[turret_枪] → 枪；[turret_1] → 1；中文显示层 [炮塔_主炮] → 主炮） */
  name: string
  /** 键值（英文规范名 → 值） */
  values: Map<string, string>
  /** 键名（英文规范名 → 原始行键名，写回时用原文） */
  rawKeys: Map<string, string>
  /** [turret_*] 行号（0 基） */
  startLine: number
  /** 段结束行号（不含；文件尾 = 行数） */
  endLine: number
}

/** 英文节名：炮塔段后缀允许数字/字母/中文等任意非空白字符（官方就有 [turret_main] 这类命名） */
const TURRET_SECTION_RE = /^\s*\[turret_([^\]\s]+)\]\s*(?:#.*)?$/i
const SECTION_RE = /^\s*\[.+?\]\s*(?:#.*)?$/

/** 常用炮塔键（表格编辑列） */
export const TURRET_KEYS = ['x', 'y', 'idleDir', 'projectile', 'size', 'shoot_sound'] as const

type ZhToEn = (s: string) => string | undefined
type EnToZh = (s: string) => string | undefined

/** 键名回译（中文显示层的 x坐标 → x）：整串回译 + _ 分段回译 */
function toEnKey(raw: string, zhToEn?: ZhToEn): string {
  if (!zhToEn) return raw
  const direct = zhToEn(raw)
  if (direct) return direct
  if (raw.includes('_')) {
    return raw
      .split('_')
      .map((seg) => zhToEn(seg) ?? seg)
      .join('_')
  }
  return raw
}

/** 识别炮塔节头并返回后缀名；不是炮塔节返回 null。
 * 英文 [turret_*] 直接匹配；中文显示层 [炮塔_*] 先回译前缀（炮塔 → turret），后缀原样保留。 */
function turretSectionName(line: string, zhToEn?: ZhToEn): string | null {
  const en = TURRET_SECTION_RE.exec(line)
  if (en) return en[1]
  if (!zhToEn) return null
  const header = /^\s*\[([^\]]+)\]\s*(?:#.*)?$/.exec(line)
  if (!header) return null
  const body = header[1]
  const sep = body.indexOf('_')
  if (sep <= 0 || sep >= body.length - 1) return null // 裸 [炮塔] 游戏不识别
  const prefix = body.slice(0, sep)
  if (toEnKey(prefix, zhToEn).toLowerCase() !== 'turret') return null
  return body.slice(sep + 1)
}

/** 解析文件里的全部炮塔段（按出现顺序编号 1 基；中文显示层传 zhToEn 词典回译） */
export function parseTurrets(content: string, zhToEn?: ZhToEn): TurretEntry[] {
  const lines = content.split(/\r?\n/)
  const turrets: TurretEntry[] = []
  let current: TurretEntry | null = null
  for (let i = 0; i < lines.length; i++) {
    const name = turretSectionName(lines[i], zhToEn)
    if (name !== null) {
      current = { index: turrets.length + 1, name, values: new Map(), rawKeys: new Map(), startLine: i, endLine: i + 1 }
      turrets.push(current)
      continue
    }
    if (current && SECTION_RE.test(lines[i])) {
      current.endLine = i
      current = null
      continue
    }
    if (current) {
      current.endLine = i + 1
      const kv = /^([^:#]+?)\s*:\s*(.*)$/.exec(lines[i])
      if (kv) {
        const en = toEnKey(kv[1].trim(), zhToEn)
        current.values.set(en, kv[2].trim())
        current.rawKeys.set(en, kv[1].trim())
      }
    }
  }
  return turrets
}

/** 行级替换段内某个键的值（保留行缩进、行内注释与原文行尾 CRLF/LF），返回新内容。
 * enToZh：追加新键时反查中文显示键（与文件键名语言一致，避免中文文件混入英文键） */
export function updateTurretValue(content: string, turretIndex: number, key: string, value: string, zhToEn?: ZhToEn, enToZh?: EnToZh): string {
  // 行尾保真：CRLF 文件整体保持 CRLF（split/join 前先探测）
  const crlf = content.includes('\r\n')
  const lines = content.split(/\r?\n/)
  const turret = parseTurrets(content, zhToEn).find((t) => t.index === turretIndex)
  if (!turret) return content
  const rawKey = turret.rawKeys.get(key) ?? key
  const keyRe = new RegExp(`^([ \\t]*)${rawKey.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[ \\t]*:[ \\t]*(.*)$`, 'i')
  for (let i = turret.startLine; i < turret.endLine; i++) {
    const m = keyRe.exec(lines[i])
    if (m) {
      // 保留行内注释（值后面的 # 注释）：新值 + 原注释
      const comment = /[ \t]+(#.*)$/.exec(m[2])
      const commentText = comment ? comment[1] : ''
      lines[i] = `${m[1]}${rawKey}: ${value}${commentText ? ` ${commentText}` : ''}`
      return crlf ? lines.join('\r\n') : lines.join('\n')
    }
  }
  // 键不存在：在段尾追加一行（中文模式用 enToZh 反查中文显示键，与文件语言一致）
  const appendKey = enToZh ? enToZh(key) ?? key : key
  lines.splice(turret.endLine, 0, `${appendKey}: ${value}`)
  return crlf ? lines.join('\r\n') : lines.join('\n')
}

/** 从 [graphics] 段取 image 路径（预览图用；中文模式 image 键回译匹配） */
export function findUnitImage(content: string, zhToEn?: ZhToEn): string | undefined {
  const lines = content.split(/\r?\n/)
  let inGraphics = false
  for (const line of lines) {
    if (/^\s*\[graphics\]\s*(?:#.*)?$/i.test(line) || (zhToEn && toEnKey(line.replace(/^\s*\[|\]\s*(?:#.*)?$/g, ''), zhToEn).toLowerCase() === 'graphics' && /^\s*\[.+?\]/.test(line))) {
      inGraphics = true
      continue
    }
    if (inGraphics && /^\s*\[.+?\]\s*(?:#.*)?$/.test(line)) break
    if (inGraphics) {
      const kv = /^([^:#]+?)\s*:\s*(.+?)\s*$/.exec(line)
      if (kv && toEnKey(kv[1].trim(), zhToEn).toLowerCase() === 'image') return kv[2].trim()
    }
  }
  return undefined
}
