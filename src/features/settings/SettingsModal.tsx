import { useWorkspaceStore } from '../../stores/workspace'
import { Modal } from '../../components/Modal'
import { SettingsContent } from './SettingsContent'

/** Legacy modal wrapper retained for older entry points and tests. */
export function SettingsModal() {
  const setSettingsOpen = useWorkspaceStore((state) => state.setSettingsOpen)

  return (
    <Modal title="设置" onClose={() => setSettingsOpen(false)} wide>
      <SettingsContent />
    </Modal>
  )
}
