/**
 * 打包选项弹窗（M40 巨型文件拆分：自 ModToolModals.tsx 迁出）：
 * 选择打包时对源文件做的清理/格式化（默认为空，原样打包）。
 */
import { useState } from 'react'
import { useWorkspaceStore } from '../../../stores/workspace'
import { useEscapeHandler } from '../../../utils/modalStack'

export function PackModal({ onClose }: { onClose: () => void }) {
  const packModWithOptions = useWorkspaceStore((s) => s.packModWithOptions)
  const gamePath = useWorkspaceStore((s) => s.settings.gamePath)
  const [options, setOptions] = useState({
    removeEmptyFiles: false,
    removeEmptyFolders: false,
    removeEmptyLines: false,
    removeComments: false,
    formatCode: false,
  })
  const [deployToGame, setDeployToGame] = useState(false)
  const [packing, setPacking] = useState(false)

  useEscapeHandler(onClose)

  const items: Array<{ key: keyof typeof options; label: string; desc: string }> = [
    { key: 'removeEmptyFiles', label: '移除空文件', desc: '内容为空的 .ini/.template 不进入压缩包' },
    { key: 'removeEmptyFolders', label: '移除空文件夹', desc: '没有任何文件的目录不进入压缩包' },
    { key: 'removeEmptyLines', label: '移除空行', desc: '源文件中的所有空行被删除' },
    { key: 'removeComments', label: '移除注释', desc: '源文件中的 # 注释行被删除' },
    { key: 'formatCode', label: '格式化代码', desc: '规整缩进与冒号空格，节前留空行' },
  ]

  const toggle = (key: keyof typeof options) => setOptions({ ...options, [key]: !options[key] })

  const run = () => {
    setPacking(true)
    void packModWithOptions(options, deployToGame).finally(() => setPacking(false))
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card confirm-card pack-card" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">打包模组</div>
        <div className="modal-body mod-check-body">
          <p className="mod-tip">选择打包时对源文件做的清理（不勾选 = 原样打包）。打包文件将通过系统对话框保存为 .rwmod。</p>
          <div className="pack-options">
            {items.map((it) => (
              <label key={it.key} className="pack-option">
                <input type="checkbox" checked={options[it.key]} onChange={() => toggle(it.key)} />
                <span className="pack-label">{it.label}</span>
                <span className="pack-desc">{it.desc}</span>
              </label>
            ))}
            {/* M35 F3：一键验证——打包后自动部署到游戏 mods/units 并启动游戏 */}
            <label className={`pack-option${gamePath ? '' : ' disabled'}`}>
              <input
                type="checkbox"
                checked={deployToGame}
                disabled={!gamePath}
                onChange={(e) => setDeployToGame(e.target.checked)}
              />
              <span className="pack-label">打包后部署到游戏并启动（一键验证）</span>
              <span className="pack-desc">
                {gamePath
                  ? '写入游戏 mods/units 目录并自动启动游戏（同名模组会先询问是否覆盖）'
                  : '未配置游戏安装目录，请先到 设置 → 游戏 中配置'}
              </span>
            </label>
          </div>
        </div>
        <div className="modal-footer">
          <button className="btn" onClick={onClose}>取消</button>
          <button className="btn primary" onClick={run} disabled={packing}>
            {packing ? '打包中…' : '开始打包'}
          </button>
        </div>
      </div>
    </div>
  )
}
