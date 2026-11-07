/**
 * 统一文件打开入口。
 *
 * 文件树、检查结果「定位」、模板创建单位后的打开都走这里：
 * 读盘 → 建编辑会话 → 写入 store（可选带跳转行）。
 *
 * 旧实现三处各写一份打开逻辑，导致检查页丢跳转行号、会话缺中文追踪表
 * （保存时把中文写盘）。集中到一处后，显示模式与保存基准在所有入口一致。
 */
import { getBridge } from '../../services/bridge'
import { getEnToZhDict, getZhToEnDict, loadCodeData } from '../../services/codeData'
import { makeDict, type TranslationDict } from '../../services/translation'
import { isRustConfigFile } from '../../utils/paths'
import { createSession, type EditSession } from './editSession'
import { useWorkspace } from '../../stores/workspace'

export interface OpenFileRequest {
  /** 文件绝对路径 */
  path: string
  /** 文件名（缺省从路径末段取） */
  name?: string
  /** 目标行号（检查结果定位用，1 基） */
  line?: number
}

export type OpenFileResult =
  | { ok: true; session: EditSession }
  | {
      ok: false
      error: string
      /** 读盘期间项目被切换 / 又发起了新的打开请求：本次结果作废，调用方无需报错 */
      cancelled?: boolean
    }

/** 打开请求序号：并发打开时只有最后一次请求允许落到会话，防止先发起的慢读盘后返回覆盖新文件 */
let openRequestSeq = 0

/** 从路径取文件名 */
export function fileNameOf(path: string): string {
  const parts = path.replace(/[\\/]+$/, '').split(/[\\/]/)
  return parts[parts.length - 1] ?? path
}

/**
 * 中文显示层词典（打开与保存回译共用）。
 * 非中文模式返回空词典，调用方无需分支。
 */
export async function loadTranslationDict(chineseMode: boolean): Promise<TranslationDict> {
  if (!chineseMode) return makeDict(new Map(), new Map())
  await loadCodeData()
  return makeDict(getEnToZhDict(), getZhToEnDict())
}

export async function openFileInEditor(req: OpenFileRequest): Promise<OpenFileResult> {
  const ws = useWorkspace.getState()
  const project = ws.projects.find((p) => p.id === ws.activeProjectId)
  if (!project) return { ok: false, error: '请先选择一个项目' }
  const projectId = project.id
  const requestSeq = ++openRequestSeq

  /**
   * 本次请求是否仍然有效：读盘/加载词典期间用户可能切换了项目，或又点了另一个文件。
   * 不校验就会把旧项目的文件（或先发起的慢请求）写进当前会话，界面显示的文件与
   * 当前项目/最后一次点击不一致。
   */
  const stale = (): boolean => requestSeq !== openRequestSeq || useWorkspace.getState().activeProjectId !== projectId

  const name = req.name ?? fileNameOf(req.path)
  try {
    const { content, hasBom, mtimeMs } = await getBridge().project.readFile(project.rootPath, req.path)
    if (stale()) return { ok: false, error: '', cancelled: true }
    const latest = useWorkspace.getState()
    const chineseMode = latest.settings.translateMode && isRustConfigFile(name)
    const dict = await loadTranslationDict(chineseMode)
    // loadCodeData 可能较慢（首次加载知识表）：加载完成后再确认一次
    if (stale()) return { ok: false, error: '', cancelled: true }
    const session = createSession({
      projectId,
      rootPath: project.rootPath,
      path: req.path,
      name,
      raw: content,
      hasBom,
      mtimeMs,
      chineseMode,
      dict,
    })
    const current = useWorkspace.getState()
    current.openEditorSession(session)
    if (req.line && req.line > 0) current.requestEditorJump(req.line)
    return { ok: true, session }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}
