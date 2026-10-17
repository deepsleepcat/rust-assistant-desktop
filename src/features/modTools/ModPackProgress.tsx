import { useWorkspaceStore } from '../../stores/workspace'
import type { ModPackProgress } from '../../types/modPack'

const PHASE_LABEL: Record<ModPackProgress['phase'], string> = {
  reading: '正在读取模组文件',
  compressing: '正在压缩模组',
  'awaiting-save': '等待选择保存位置',
  'awaiting-overwrite': '等待确认覆盖游戏中的同名模组',
  writing: '正在写入模组包',
  completed: '打包完成',
  canceled: '打包已取消',
  failed: '打包失败',
}

/** 独立于选项弹窗和当前工作面，原生保存窗口等待期间也保留。 */
export function ModPackProgress() {
  const task = useWorkspaceStore((s) => s.modPackTask)
  if (!task) return null
  const percent = task.phase === 'compressing' && task.percent !== undefined ? task.percent : undefined
  return (
    <section
      className="mod-pack-progress"
      data-testid="mod-pack-progress"
      data-phase={task.phase}
      data-busy={task.busy}
      aria-label="模组打包进度"
      style={{ position: 'fixed', right: 24, bottom: 44, zIndex: 1200, width: 'min(400px, calc(100vw - 48px))', padding: 18, borderRadius: 14, border: '1px solid var(--border)', background: 'var(--surface-0)', color: 'var(--text-primary)', boxShadow: '0 8px 32px #0003' }}
    >
      <div role="status" aria-live="polite" style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
        <strong>{PHASE_LABEL[task.phase]}</strong>
        {percent !== undefined && <span>{percent.toFixed(1)}%</span>}
      </div>
      <div style={{ marginTop: 6, overflowWrap: 'anywhere' }}>{task.projectName}</div>
      {task.busy && <progress aria-label={percent !== undefined ? '压缩进度' : '打包阶段进度'} max={100} value={percent} style={{ width: '100%', marginTop: 12 }} />}
      {task.filesRead !== undefined && <div style={{ marginTop: 8 }}>已读取 {task.filesRead} 个文件 · {((task.bytesRead ?? 0) / 1024 / 1024).toFixed(2)} MB</div>}
      {task.files !== undefined && task.phase !== 'reading' && <div>归档包含 {task.files} 个文件</div>}
      {task.currentFile && <div title={task.currentFile} style={{ marginTop: 6, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{task.currentFile}</div>}
      {task.phase === 'compressing' && <div style={{ marginTop: 8 }}>百分比表示压缩进度，随后还需保存文件。</div>}
      {task.phase === 'awaiting-save' && <div style={{ marginTop: 8 }}>请在系统保存窗口中选择位置，或取消保存。</div>}
      {task.phase === 'writing' && <div style={{ marginTop: 8 }}>正在等待磁盘写入完成。</div>}
      {task.message && <div style={{ marginTop: 8, overflowWrap: 'anywhere' }}>{task.message}</div>}
      {!task.busy && <button type="button" className="btn" style={{ marginTop: 12 }} onClick={() => useWorkspaceStore.setState({ modPackTask: null })}>关闭进度</button>}
    </section>
  )
}
