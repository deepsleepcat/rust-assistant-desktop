/**
 * M6.5 模组模板系统共享类型（渲染进程与主进程共用）。
 * 模板来自手机版 baseTemplate_v2.0（GPL-3.0 数据，随项目同许可分发）。
 */

/** 模板表单字段（手机版 action 数组 → 界面字段） */
export interface TemplateAction {
  label: string
  key: string
  section: string
  tag: string
  type: string
}

/** 模板元数据（列表展示 + 表单构建用） */
export interface TemplateMeta {
  key: string
  name: string
  nameEn: string
  actions: TemplateAction[]
  /** tag → 模板 data 中的默认值 */
  defaults: Record<string, string>
}
