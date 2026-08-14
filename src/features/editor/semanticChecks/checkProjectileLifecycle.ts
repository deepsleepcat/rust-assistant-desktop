/**
 * 弹体生命周期（checkProjectileLifecycle）：
 * 1) 被引用的 [projectile_xxx] 节必须有 life 键且 ≥ 0（life 缺失会导致
 *    弹体在命中前消失或永不消失；life: 0 是官方合法语义——即时爆炸弹体）；
 *    未被引用的弹体节可能是特效/自爆弹体（官方 fabricator 的 projectile_explode
 *    无 life），不报；
 * 2) [turret_N]/[attack]/[spawnProjectiles] 等引用弹体名时，非内置弹体
 *    必须能在本文件找到 [projectile_<名>] 节（内置弹体编号 1-3 与常见
 *    内置弹体名放行，找不到时给警告让用户确认，不武断报错）。
 */
import type { SemanticChecker, SemanticIssue } from './types'
import { issue, keyValuesInSection, parseIni, sectionEnName, toEnKey, toNumber } from './helpers'

/** 游戏内置弹体名（官方单位直接引用的常见内置弹体，白名单放行） */
const BUILTIN_PROJECTILES = new Set([
  '1', '2', '3',
  'torpedo', 'laserShot', 'antiNukeMissile', 'plasma', 'main', 'antiNukeProjectile',
  'smallLaser', 'scoutBotProjectile', 'nukeProjectile', 'lightning', 'laser',
  'gunShot', 'flak', 'beam', 'explode', 'bomb', 'missile', 'bullet', 'cannon', 'rocket',
])

/** 可能引用弹体的键（key 小写） */
const PROJECTILE_REF_KEYS = new Set(['projectile', 'projectiles', 'spawnprojectile', 'spawnprojectiles', 'createProjectile'])

export const checkProjectileLifecycle: SemanticChecker = {
  id: 'checkProjectileLifecycle',
  title: '弹体生命周期',
  description: '[projectile_N] 必须有 life > 0；引用的弹体（非内置）必须存在定义',
  defaultOn: true,
  check(content, ctx) {
    const issues: SemanticIssue[] = []
    const { sections, keyValues } = parseIni(content)
    const zhToEn = ctx?.zhToEn

    // 本文件内已定义的弹体名（[projectile_xxx] 节名去前缀，小写）
    const definedProjectiles = new Set<string>()
    for (const sec of sections) {
      const lower = sectionEnName(sec, zhToEn)
      if (lower.startsWith('projectile_')) {
        definedProjectiles.add(lower.slice('projectile_'.length))
      }
    }

    // 1) 弹体节必须有 life（仅当该弹体被引用时——特效/自爆弹体官方不带 life）
    // 先收集「被引用的弹体名」
    const referenced = new Set<string>()
    for (const kv of keyValues) {
      const key = toEnKey(kv.key, zhToEn).toLowerCase()
      if (!PROJECTILE_REF_KEYS.has(key)) continue
      for (const raw of kv.value.split(',')) {
        const ref = raw.trim().replace(/^CUSTOM:/i, '').toLowerCase()
        if (ref && ref !== 'none' && !/^\d+$/.test(ref) && !BUILTIN_PROJECTILES.has(ref)) referenced.add(ref)
      }
    }
    for (const sec of sections) {
      const lower = sectionEnName(sec, zhToEn)
      if (!lower.startsWith('projectile_')) continue
      const name = lower.slice('projectile_'.length)
      const kvs = keyValuesInSection(keyValues, sec)
      const life = kvs.find((kv) => toEnKey(kv.key, zhToEn).toLowerCase() === 'life')
      if (!life) {
        // 未被引用的弹体节：可能是特效弹体（官方 fabricator 的 projectile_explode），放行
        if (!referenced.has(name)) continue
        issues.push(
          issue(
            sec.startLine,
            `弹体节 [${sec.name}] 缺少 life（生命周期）`,
            `在节内添加 life: <帧数>（如 life: 60），否则弹体会在命中前消失或永不消失`,
            'checkProjectileLifecycle',
            'error',
            `[${sec.name}]`,
          ),
        )
      } else {
        const n = toNumber(life.value)
        if (n === null) {
          issues.push(issue(life.line, `「life」的值「${life.value}」不是数字`, `改成数字（如 life: 60）`, 'checkProjectileLifecycle', 'error', life.value))
        } else if (n < 0) {
          issues.push(issue(life.line, `弹体 life 不能为负数，当前为 ${n}`, `改成 ≥ 0 的数值（0 表示即时生效）`, 'checkProjectileLifecycle', 'error', life.value))
        }
      }
    }

    // 2) 引用检查：引用名非内置 → 本文件须有对应弹体节
    // （无弹体节时也要检查——引用定义在别处/未定义的弹体正是要提示的场景）
    for (const kv of keyValues) {
      const key = toEnKey(kv.key, zhToEn).toLowerCase()
      if (!PROJECTILE_REF_KEYS.has(key)) continue
      // 值可能是逗号分隔列表（spawnProjectiles: a, b）
      for (const raw of kv.value.split(',')) {
        const display = raw.trim().replace(/^CUSTOM:/i, '')
        const ref = display.toLowerCase()
        if (!ref || ref === 'none') continue
        // 内置弹体（编号或白名单名）放行
        if (/^\d+$/.test(ref) || BUILTIN_PROJECTILES.has(ref)) continue
        if (!definedProjectiles.has(ref)) {
          issues.push(
            issue(
              kv.line,
              `引用的弹体「${display}」未在本文件定义（无 [projectile_${display}] 节）`,
              `添加 [projectile_${display}] 节定义；若为游戏内置或共享弹体可忽略此提示`,
              'checkProjectileLifecycle',
              'warning',
              kv.value,
            ),
          )
        }
      }
    }

    return issues
  },
}