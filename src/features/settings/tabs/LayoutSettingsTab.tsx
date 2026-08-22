/**
 * 设置 → 布局：左右栏宽度、内部比例、折叠状态、大纲面板、隐藏文件开关。
 * 从 SettingsModal 拆出（M39 巨型函数治理）；自订阅工作区 store。
 */
import { useWorkspaceStore } from '../../../stores/workspace'
import { DEFAULT_LAYOUT, DEFAULT_SETTINGS } from '../../../utils/settings'

export function LayoutSettingsTab() {
  const settings = useWorkspaceStore((s) => s.settings)
  const updateSettings = useWorkspaceStore((s) => s.updateSettings)

  return (
    <div className="setting-section">
      <div className="setting-title">布局</div>
      <div className="setting-row">
        <span className="label">
          左侧项目栏宽度
          <div className="desc">拖动窗口中间的分隔线也可以调整</div>
        </span>
        <input
          type="range"
          min={180}
          max={520}
          value={settings.leftWidth}
          onChange={(e) => updateSettings({ leftWidth: Number(e.target.value) })}
        />
        <span style={{ width: 40, textAlign: 'right', fontSize: 12, color: 'var(--text-2)' }}>{settings.leftWidth}px</span>
      </div>
      <div className="setting-row">
        <span className="label">
          右侧对话栏宽度
        </span>
        <input
          type="range"
          min={240}
          max={760}
          value={settings.rightWidth}
          onChange={(e) => updateSettings({ rightWidth: Number(e.target.value) })}
        />
        <span style={{ width: 40, textAlign: 'right', fontSize: 12, color: 'var(--text-2)' }}>{settings.rightWidth}px</span>
      </div>

      <div className="setting-divider" />
      <div className="setting-title">内部比例</div>
      <div className="setting-row">
        <span className="label">
          左栏项目列表高度
          <div className="desc">项目列表占左栏的高度比例，其余为文件树</div>
        </span>
        <input
          type="range"
          min={15}
          max={80}
          value={Math.round(settings.layout.leftARatio * 100)}
          onChange={(e) => {
            const s = useWorkspaceStore.getState()
            updateSettings({ layout: { ...s.settings.layout, leftARatio: Number(e.target.value) / 100 } })
          }}
        />
        <span style={{ width: 34, textAlign: 'right', fontSize: 12, color: 'var(--text-2)' }}>{Math.round(settings.layout.leftARatio * 100)}%</span>
        <button
          className="btn"
          style={{ padding: '1px 8px', fontSize: 11, height: 22 }}
          onClick={() => {
            const s = useWorkspaceStore.getState()
            updateSettings({ layout: { ...s.settings.layout, leftARatio: DEFAULT_LAYOUT.leftARatio } })
          }}
        >
          恢复默认
        </button>
      </div>
      <div className="setting-row">
        <span className="label">
          右栏对话列表高度
          <div className="desc">对话列表占右栏的高度比例，其余为消息区</div>
        </span>
        <input
          type="range"
          min={15}
          max={80}
          value={Math.round(settings.layout.rightARatio * 100)}
          onChange={(e) => {
            const s = useWorkspaceStore.getState()
            updateSettings({ layout: { ...s.settings.layout, rightARatio: Number(e.target.value) / 100 } })
          }}
        />
        <span style={{ width: 34, textAlign: 'right', fontSize: 12, color: 'var(--text-2)' }}>{Math.round(settings.layout.rightARatio * 100)}%</span>
        <button
          className="btn"
          style={{ padding: '1px 8px', fontSize: 11, height: 22 }}
          onClick={() => {
            const s = useWorkspaceStore.getState()
            updateSettings({ layout: { ...s.settings.layout, rightARatio: DEFAULT_LAYOUT.rightARatio } })
          }}
        >
          恢复默认
        </button>
      </div>

      <div className="setting-divider" />
      <div className="setting-title">折叠状态</div>
      <div className="desc" style={{ marginBottom: 8 }}>
        折叠后可拖分隔条或从命令面板重新打开
      </div>
      <div className="setting-row">
        <span className="label">项目区整体折叠</span>
        <button
          className={`switch${settings.layout.leftCollapsed ? ' on' : ''}`}
          role="switch"
          aria-checked={settings.layout.leftCollapsed}
          onClick={() => {
            const s = useWorkspaceStore.getState()
            updateSettings({ layout: { ...s.settings.layout, leftCollapsed: !s.settings.layout.leftCollapsed } })
          }}
        >
          <span className="knob" />
        </button>
      </div>
      <div className="setting-row">
        <span className="label">AI 对话区整体折叠</span>
        <button
          className={`switch${settings.layout.rightCollapsed ? ' on' : ''}`}
          role="switch"
          aria-checked={settings.layout.rightCollapsed}
          onClick={() => {
            const s = useWorkspaceStore.getState()
            updateSettings({ layout: { ...s.settings.layout, rightCollapsed: !s.settings.layout.rightCollapsed } })
          }}
        >
          <span className="knob" />
        </button>
      </div>
      <div className="setting-row">
        <span className="label">左栏项目列表折叠</span>
        <button
          className={`switch${settings.layout.leftACollapsed ? ' on' : ''}`}
          role="switch"
          aria-checked={settings.layout.leftACollapsed}
          onClick={() => {
            const s = useWorkspaceStore.getState()
            updateSettings({ layout: { ...s.settings.layout, leftACollapsed: !s.settings.layout.leftACollapsed } })
          }}
        >
          <span className="knob" />
        </button>
      </div>
      <div className="setting-row">
        <span className="label">右栏对话列表折叠</span>
        <button
          className={`switch${settings.layout.rightACollapsed ? ' on' : ''}`}
          role="switch"
          aria-checked={settings.layout.rightACollapsed}
          onClick={() => {
            const s = useWorkspaceStore.getState()
            updateSettings({ layout: { ...s.settings.layout, rightACollapsed: !s.settings.layout.rightACollapsed } })
          }}
        >
          <span className="knob" />
        </button>
      </div>

      <div className="setting-divider" />
      <div className="setting-title">大纲</div>
      <div className="setting-row">
        <span className="label">
          编辑器大纲面板高度
          <div className="desc">大纲面板在编辑器内的固定高度</div>
        </span>
        <input
          type="range"
          min={80}
          max={560}
          value={settings.layout.outlineHeight}
          onChange={(e) => {
            const s = useWorkspaceStore.getState()
            updateSettings({ layout: { ...s.settings.layout, outlineHeight: Number(e.target.value) } })
          }}
        />
        <span style={{ width: 40, textAlign: 'right', fontSize: 12, color: 'var(--text-2)' }}>{settings.layout.outlineHeight}px</span>
      </div>
      <div className="setting-row">
        <span className="label">
          大纲默认展开
          <div className="desc">关闭后大纲默认折叠，可在编辑器内重新展开</div>
        </span>
        <button
          className={`switch${!settings.layout.outlineCollapsed ? ' on' : ''}`}
          role="switch"
          aria-checked={!settings.layout.outlineCollapsed}
          onClick={() => {
            const s = useWorkspaceStore.getState()
            updateSettings({ layout: { ...s.settings.layout, outlineCollapsed: !s.settings.layout.outlineCollapsed } })
          }}
        >
          <span className="knob" />
        </button>
      </div>

      <div className="setting-divider" />
      <div className="setting-row">
        <span className="label">
          恢复默认布局
        </span>
        <button
          className="btn"
          onClick={() =>
            updateSettings({
              layout: { ...DEFAULT_LAYOUT },
              leftWidth: DEFAULT_SETTINGS.leftWidth,
              rightWidth: DEFAULT_SETTINGS.rightWidth,
            })
          }
        >
          恢复默认
        </button>
      </div>
      <div className="setting-row">
        <span className="label">
          显示隐藏文件
          <div className="desc">在文件树中显示以 . 开头的文件（如 .nomedia），默认隐藏</div>
        </span>
        <button
          className={`switch${settings.showHiddenFiles ? ' on' : ''}`}
          role="switch"
          aria-checked={settings.showHiddenFiles}
          onClick={() => {
            updateSettings({ showHiddenFiles: !settings.showHiddenFiles })
            // 重载文件树（隐藏文件过滤在主进程读取时生效，需重新读取目录）
            void useWorkspaceStore.getState().refreshTree()
          }}
        >
          <span className="knob" />
        </button>
      </div>
    </div>
  )
}
