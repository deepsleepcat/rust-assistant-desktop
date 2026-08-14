/**
 * 行级 diff 的共享类型（主进程 electron/diff.ts 计算，渲染层审批弹窗渲染）。
 */
export type DiffLineType = 'same' | 'add' | 'del' | 'omit'

export interface DiffLine {
  type: DiffLineType
  text: string
}

/** diff 统计（审批弹窗标题行展示用） */
export interface DiffSummary {
  added: number
  deleted: number
}
