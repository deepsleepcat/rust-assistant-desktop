/**
 * M43 左栏：项目列表与文件树合并为一个手风琴面板（项目行即树根，见 ProjectPanel）。
 * 旧的「项目列表 ↕ 文件树」上下分栏（leftARatio/leftACollapsed）已随合并移除。
 */
import { ProjectPanel } from '../project/ProjectPanel'

export function LeftColumn() {
  return (
    <div className="wb-left-col">
      <ProjectPanel />
    </div>
  )
}
