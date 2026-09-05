/**
 * 模组导入来源选择弹窗（M40 巨型文件拆分：自 ModToolModals.tsx 迁出）。
 */
import { AppIcon } from '../../../components/AppIcon'
import { Modal } from '../../../components/Modal'
import type { ModImportKind } from '../../../types/bridge'

export function ImportModModal({ onClose, onSelect }: { onClose: () => void; onSelect: (kind: ModImportKind) => Promise<void> }) {
  const choose = (kind: ModImportKind) => {
    onClose()
    void onSelect(kind)
  }
  return (
    <Modal title="导入模组" onClose={onClose} footer={<button className="btn" onClick={onClose}>取消</button>}>
      <p className="import-mod-intro">选择导入来源：</p>
      <div className="import-mod-options">
        <button className="import-mod-option" onClick={() => choose('archive')} autoFocus>
          <span className="import-mod-icon"><AppIcon name="archive" size={20} /></span>
          <span className="import-mod-copy">
            <strong>模组文件</strong>
            <span>.rwmod / .zip</span>
          </span>
          <span className="import-mod-detail">解压到指定位置</span>
        </button>
        <button className="import-mod-option" onClick={() => choose('folder')}>
          <span className="import-mod-icon"><AppIcon name="folder" size={20} /></span>
          <span className="import-mod-copy">
            <strong>模组文件夹</strong>
            <span>已有项目目录</span>
          </span>
          <span className="import-mod-detail">直接作为项目打开</span>
        </button>
      </div>
    </Modal>
  )
}
