/**
 * 语义检查器注册表：全部检查器的唯一登记处。
 * - ALL_SEMANTIC_CHECKERS：15 个专项检查器（P1 任务 1 要求 ≥8 个上线，全部完成）；
 * - 配置：每个检查器可单独开关（settings.semanticCheckers: Record<ruleId, boolean>）；
 * - 清洗：合并用户配置时只接受已知规则 id，未知 id 忽略（防脏数据）。
 */
import type { SemanticChecker } from './types'
import { checkActionReferences } from './checkActionReferences'
import { checkAttachmentPosition } from './checkAttachmentPosition'
import { checkDrawLayerEnum } from './checkDrawLayerEnum'
import { checkEventTimingSemantics } from './checkEventTimingSemantics'
import { checkFile } from './checkFile'
import { checkGraphicsShadowOffset } from './checkGraphicsShadowOffset'
import { checkKeyTypos } from './checkKeyTypos'
import { checkLogicBooleanPrecedence } from './checkLogicBooleanPrecedence'
import { checkPositiveCoreStats } from './checkPositiveCoreStats'
import { checkPositiveMovementSpeed } from './checkPositiveMovementSpeed'
import { checkPositiveRotateTurnSpeed } from './checkPositiveRotateTurnSpeed'
import { checkProjectileLifecycle } from './checkProjectileLifecycle'
import { checkProjectileRangeSemantics } from './checkProjectileRangeSemantics'
import { checkResourceHudSemantics } from './checkResourceHudSemantics'
import { checkRiskyUnitReferenceSemantics } from './checkRiskyUnitReferenceSemantics'

/** 全部语义检查器（顺序即执行顺序） */
export const ALL_SEMANTIC_CHECKERS: SemanticChecker[] = [
  checkFile,
  checkKeyTypos,
  checkPositiveCoreStats,
  checkPositiveMovementSpeed,
  checkPositiveRotateTurnSpeed,
  checkProjectileLifecycle,
  checkProjectileRangeSemantics,
  checkAttachmentPosition,
  checkDrawLayerEnum,
  checkGraphicsShadowOffset,
  checkLogicBooleanPrecedence,
  checkEventTimingSemantics,
  checkResourceHudSemantics,
  checkRiskyUnitReferenceSemantics,
  checkActionReferences,
]

const BY_ID = new Map(ALL_SEMANTIC_CHECKERS.map((c) => [c.id, c]))

export function getSemanticChecker(id: string): SemanticChecker | undefined {
  return BY_ID.get(id)
}

/** 默认配置：全部 defaultOn 的检查器开启 */
export function defaultSemanticCheckerConfig(): Record<string, boolean> {
  const out: Record<string, boolean> = {}
  for (const c of ALL_SEMANTIC_CHECKERS) out[c.id] = c.defaultOn
  return out
}

/** 清洗用户配置：只保留已知规则 id 的布尔值（未知 id/非布尔忽略） */
export function sanitizeCheckerConfig(input: unknown): Record<string, boolean> {
  const base = defaultSemanticCheckerConfig()
  if (!input || typeof input !== 'object') return base
  const raw = input as Record<string, unknown>
  for (const c of ALL_SEMANTIC_CHECKERS) {
    if (typeof raw[c.id] === 'boolean') base[c.id] = raw[c.id] as boolean
  }
  return base
}

/** 按配置取启用的规则 id 集合 */
export function enabledRuleIds(config: Record<string, boolean>): Set<string> {
  const ids = new Set<string>()
  for (const c of ALL_SEMANTIC_CHECKERS) {
    if (config[c.id] !== false) ids.add(c.id) // 未显式关闭即开启（兼容旧配置）
  }
  return ids
}
