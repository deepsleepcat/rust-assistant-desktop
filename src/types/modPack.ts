/** 阶段进度：只有 compressing 的 percent 来自 JSZip，其他阶段不估算百分比。 */
export interface ModPackProgress {
  phase: 'reading' | 'compressing' | 'awaiting-save' | 'awaiting-overwrite' | 'writing' | 'completed' | 'canceled' | 'failed'
  filesRead?: number
  bytesRead?: number
  files?: number
  currentFile?: string
  percent?: number
  message?: string
}

export interface ModPackProgressEvent extends ModPackProgress {
  requestId: string
}

export interface ModPackTask extends ModPackProgressEvent {
  projectName: string
  busy: boolean
}
