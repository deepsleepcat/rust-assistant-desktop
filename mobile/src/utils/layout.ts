/**
 * M29 布局纯函数：工作区三栏宽度的夹紧/适配、内部比例夹紧、窗口模式判定。
 * 全部为纯函数（不碰 DOM/Zustand），便于单元测试与拖动逻辑复用。
 */

export interface WorkbenchConstraints {
  minLeft: number
  maxLeft: number
  minRight: number
  maxRight: number
  minEditor: number
}

export const WORKBENCH_DEFAULTS = { left: 280, right: 430 }

/** 拖动手感边界：比设置滑杆范围略宽，但保证编辑器有基本空间 */
export const WORKBENCH_CONSTRAINTS: WorkbenchConstraints = {
  minLeft: 180,
  maxLeft: 520,
  minRight: 240,
  maxRight: 760,
  minEditor: 340,
}

/** 两条垂直分隔条的命中区总宽（8px × 2）——fitWorkbench 计算可用宽度时要扣掉 */
export const SPLITTER_TOTAL = 16

/** 内部上下分栏比例范围（左栏项目区/右栏对话列表） */
export const INNER_RATIO_MIN = 0.15
export const INNER_RATIO_MAX = 0.8

export function clampWidth(v: number, min: number, max: number): number {
  if (!Number.isFinite(v)) return min
  return Math.min(max, Math.max(min, v))
}

/**
 * 把「用户保存的左右宽度」适配到当前容器宽度：
 * - 0 视为折叠状态，保持不变（重新展开由上层恢复旧值）；
 * - 非零值各自夹紧到约束范围；
 * - 左右 + 最小编辑器宽度超出容器时：先让右栏让位到最小，再让左栏让位，
 *   仍不够时（极端窄容器）右栏可低于最小，确保编辑器始终有 minEditor 空间。
 */
export function fitWorkbench(
  sizes: { left: number; right: number },
  containerWidth: number,
  c: WorkbenchConstraints = WORKBENCH_CONSTRAINTS,
): { left: number; right: number } {
  const { left, right } = sizes
  // 折叠（0）时该侧保持 0，非折叠侧夹紧到约束范围；单侧折叠也要保证编辑器最小宽度
  if (!Number.isFinite(containerWidth)) {
    return {
      left: left === 0 ? 0 : clampWidth(left, c.minLeft, c.maxLeft),
      right: right === 0 ? 0 : clampWidth(right, c.minRight, c.maxRight),
    }
  }
  const L0 = left === 0 ? 0 : clampWidth(left, c.minLeft, c.maxLeft)
  const R0 = right === 0 ? 0 : clampWidth(right, c.minRight, c.maxRight)
  // 单侧折叠：非折叠侧最多占 containerWidth - minEditor - 分隔条（另一侧 0 时只有一条分隔条）
  const splitterTotal = L0 === 0 || R0 === 0 ? SPLITTER_TOTAL / 2 : SPLITTER_TOTAL
  const available = Math.max(0, containerWidth - c.minEditor - splitterTotal)
  if (L0 + R0 <= available) return { left: L0, right: R0 }
  let L = L0
  let R = R0
  // 1) 右栏先让位（可退到 minRight）
  const cutR = Math.min(Math.max(0, R - c.minRight), L + R - available)
  R -= cutR
  // 2) 还不够：左栏让位（可退到 0）
  let remain = L + R - available
  if (remain > 0) {
    L = Math.max(0, L - remain)
    remain = L + R - available
    // 3) 仍不够（极窄容器）：右栏继续让位
    if (remain > 0) R = Math.max(0, R - remain)
  }
  return { left: Math.round(L), right: Math.round(R) }
}

/** 内部比例夹紧（百分比小数，如 0.3 = 30%） */
export function clampRatio(v: number, min = INNER_RATIO_MIN, max = INNER_RATIO_MAX): number {
  if (!Number.isFinite(v)) return min
  return Math.min(max, Math.max(min, v))
}

/** 把像素换算为容器比例（容器高度可能为 0 → 返回默认比例） */
export function pxToRatio(px: number, containerSize: number, fallback = 0.3): number {
  if (!Number.isFinite(px) || !Number.isFinite(containerSize) || containerSize <= 0) return fallback
  return clampRatio(px / containerSize)
}

/** 把比例换算为像素（整数） */
export function ratioToPx(ratio: number, containerSize: number): number {
  if (!Number.isFinite(containerSize) || containerSize <= 0) return 0
  return Math.round(clampRatio(ratio) * containerSize)
}

/** 窗口布局模式：full = 完整三栏可拖动；medium = 压缩三栏；compact = 抽屉 */
export type LayoutMode = 'full' | 'medium' | 'compact'

export function layoutMode(width: number): LayoutMode {
  if (!Number.isFinite(width)) return 'medium'
  if (width >= 1200) return 'full'
  if (width >= 900) return 'medium'
  return 'compact'
}
