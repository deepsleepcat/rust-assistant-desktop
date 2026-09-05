/**
 * M5 模组工具弹窗（容器组件：按 modDialog 状态分发到子弹窗）。
 * M40 巨型文件拆分：各弹窗实现迁至 modals/ 子目录，本文件只保留分发逻辑。
 * - CreateModModal  创建/编辑模组自述文件
 * - CreateUnitModal 新建单位（模板两步流程）
 * - CheckModal      单位检查结果
 * - OptimizeModal   目录优化
 * - TranslationRepairModal 中文翻译损坏修复
 * - GlobalOpModal   全局批量改写
 * - PackModal       打包模组（清理选项 + 一键部署）
 * - ReportModal     模组质量报告
 * - ImportModModal  导入来源选择
 */
import { useWorkspaceStore } from '../../stores/workspace'
import { CreateModModal } from './modals/CreateModModal'
import { CreateUnitModal } from './modals/CreateUnitModal'
import { CheckModal } from './modals/CheckModal'
import { OptimizeModal } from './modals/OptimizeModal'
import { TranslationRepairModal } from './modals/TranslationRepairModal'
import { GlobalOpModal } from './modals/GlobalOpModal'
import { PackModal } from './modals/PackModal'
import { ReportModal } from './modals/ReportModal'
import { ImportModModal } from './modals/ImportModModal'

export function ModToolModals() {
  const kind = useWorkspaceStore((s) => s.modDialog)
  const setModDialog = useWorkspaceStore((s) => s.setModDialog)
  const createModProject = useWorkspaceStore((s) => s.createModProject)
  const createUnitFile = useWorkspaceStore((s) => s.createUnitFile)
  const startModImport = useWorkspaceStore((s) => s.startModImport)
  const checkResult = useWorkspaceStore((s) => s.modCheckResult)
  const reportOpen = useWorkspaceStore((s) => s.modReportOpen)

  // M13：质量报告弹窗（独立于 modDialog——报告生成是异步的，先显示加载态）
  if (reportOpen) {
    return <ReportModal onClose={() => useWorkspaceStore.getState().setModReportOpen(false)} />
  }

  if (!kind) return null
  if (kind === 'check') {
    const errCount = checkResult?.issues.filter((i) => i.level === 'error').length ?? 0
    const warnCount = checkResult?.issues.filter((i) => i.level === 'warning').length ?? 0
    const infoCount = checkResult?.issues.filter((i) => i.level === 'info').length ?? 0
    return <CheckModal errCount={errCount} warnCount={warnCount} infoCount={infoCount} checkResult={checkResult} onClose={() => setModDialog(null)} />
  }

  if (kind === 'optimize') {
    return <OptimizeModal onClose={() => setModDialog(null)} />
  }

  if (kind === 'translationRepair') {
    return <TranslationRepairModal onClose={() => setModDialog(null)} />
  }

  if (kind === 'globalOp') {
    return <GlobalOpModal onClose={() => setModDialog(null)} />
  }

  if (kind === 'pack') {
    return <PackModal onClose={() => setModDialog(null)} />
  }

  if (kind === 'createUnit') {
    return <CreateUnitModal onClose={() => setModDialog(null)} onSubmit={createUnitFile} />
  }

  if (kind === 'import') {
    return <ImportModModal onClose={() => setModDialog(null)} onSelect={startModImport} />
  }

  return <CreateModModal onClose={() => setModDialog(null)} onSubmit={createModProject} />
}
