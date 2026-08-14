/**
 * M8 游戏集成设置页：检测铁锈战争安装目录（Steam 自动检测 / 手动选择）、
 * 导入官方单位示例模组、导入游戏内已装模组（mods/units 下的 .rwmod）。
 * M12 试玩联动：一键启动游戏、打开模组目录、运行前检查清单（结果持久化）。
 */
import { useCallback, useEffect, useState } from 'react'
import { useWorkspaceStore } from '../../stores/workspace'
import { getBridge } from '../../services/bridge'

interface GameDetectResult {
  found: boolean
  gamePath: string | null
  units: string[]
  mods: string[]
}

interface PreflightIssue {
  severity: 'error' | 'warning'
  message: string
  file?: string
}

export function GameSettingsTab() {
  const settings = useWorkspaceStore((s) => s.settings)
  const updateSettings = useWorkspaceStore((s) => s.updateSettings)
  const [detect, setDetect] = useState<GameDetectResult | null>(null)
  const [busy, setBusy] = useState<'detect' | 'sample' | 'mod' | 'launch' | 'preflight' | null>(null)
  const [selectedMod, setSelectedMod] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [preflight, setPreflight] = useState<PreflightIssue[] | null>(null)
  const [launchMsg, setLaunchMsg] = useState<string | null>(null)
  const project = useWorkspaceStore((s) => s.projects.find((p) => p.id === s.activeProjectId) ?? null)

  const runDetect = useCallback(
    async (configured?: string) => {
      setBusy('detect')
      setError(null)
      try {
        const result = await getBridge().game.detect(configured)
        setDetect(result)
        if (!result.found) setError('未找到铁锈战争安装目录，请手动选择游戏安装文件夹（需包含 assets/units）')
        else if (result.mods.length === 0) setSelectedMod('')
        else setSelectedMod((m) => (m && result.mods.includes(m) ? m : result.mods[0]))
      } catch (err) {
        setError(`检测失败：${err instanceof Error ? err.message : String(err)}`)
      } finally {
        setBusy(null)
      }
    },
    [],
  )

  useEffect(() => {
    // 延后到下一帧执行：避免在 effect 内同步 setState（react-hooks/set-state-in-effect）
    const timer = setTimeout(() => void runDetect(settings.gamePath || undefined), 0)
    return () => clearTimeout(timer)
  }, [runDetect, settings.gamePath])

  /** 手动选择游戏目录（选择即持久化到设置） */
  const pickGameDir = async () => {
    const picked = await getBridge().project.openFolderDialog()
    if (!picked) return
    updateSettings({ gamePath: picked.rootPath })
  }

  /** 导入官方单位示例：选目标目录 → 复制单位 + mod-info → 注册项目 */
  const importSample = async () => {
    if (!detect?.found || !detect.gamePath) {
      setError('请先配置游戏安装目录')
      return
    }
    setBusy('sample')
    setError(null)
    try {
      const target = await getBridge().project.openFolderDialog()
      if (!target) return
      const result = await getBridge().game.importSample(detect.gamePath, target.rootPath, {
        title: '官方单位示例',
        description: `由铁锈助手从游戏安装目录导入的 ${detect.units.length} 个官方单位（仅供学习参考）`,
      })
      const ok = await useWorkspaceStore
        .getState()
        .addImportedProject(result.rootPath, '官方单位示例', `已导入官方单位示例：${result.units} 个单位，${result.files} 个文件`)
      if (ok) setSettingsOpen(false)
    } catch (err) {
      setError(`导入失败：${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setBusy(null)
    }
  }

  /** 从游戏导入模组：选 mods/units 下的 .rwmod → 选目标目录 → 解压注册 */
  const importGameMod = async () => {
    if (!detect?.found || !detect.gamePath || !selectedMod) {
      setError('请先配置游戏目录并选择一个模组包')
      return
    }
    setBusy('mod')
    setError(null)
    try {
      const target = await getBridge().project.openFolderDialog()
      if (!target) return
      const result = await getBridge().game.importMod(detect.gamePath, selectedMod, target.rootPath)
      const name = selectedMod.replace(/\.rwmod$/i, '')
      const ok = await useWorkspaceStore
        .getState()
        .addImportedProject(result.rootPath, name, `已导入游戏模组：${name}（${result.files} 个文件）`)
      // 用户取消「未保存编辑确认」：刚解压的子目录未被使用，清理掉（主进程只接受本会话创建的目录）
      if (!ok) void getBridge().mod.discardImport(result.rootPath).catch(() => undefined)
      if (ok) setSettingsOpen(false)
    } catch (err) {
      setError(`导入失败：${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setBusy(null)
    }
  }

  const setSettingsOpen = useWorkspaceStore((s) => s.setSettingsOpen)

  /** M12：运行前检查（结果持久化到设置，下次打开设置页可见） */
  const runPreflight = async () => {
    if (!project) {
      setError('请先打开一个模组项目')
      return
    }
    setBusy('preflight')
    setError(null)
    try {
      const result = await getBridge().game.preflight(project.rootPath)
      setPreflight(result.issues)
      updateSettings({
        gameLastCheck: {
          at: Date.now(),
          ok: result.ok,
          message: result.issues.length === 0 ? '检查通过' : `${result.issues.filter((i) => i.severity === 'error').length} 个错误，${result.issues.filter((i) => i.severity === 'warning').length} 个警告`,
        },
      })
      if (!result.ok) setError(`运行前检查未通过：${result.issues.filter((i) => i.severity === 'error').length} 个错误`)
    } catch (err) {
      setError(`检查失败：${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setBusy(null)
    }
  }

  /** M12：一键启动游戏（仅接受已检测到的游戏目录） */
  const runLaunch = async () => {
    if (!detect?.found || !detect.gamePath) {
      setError('请先配置游戏安装目录')
      return
    }
    setBusy('launch')
    setError(null)
    setLaunchMsg(null)
    try {
      const result = await getBridge().game.launch(detect.gamePath)
      if (!result.ok) {
        setLaunchMsg(result.message ?? '启动失败')
        setError(`游戏启动失败：${result.message ?? '未知原因'}`)
      } else {
        setLaunchMsg('游戏已启动（可在游戏内 模组管理 中启用本模组）')
      }
    } catch (err) {
      setError(`启动失败：${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setBusy(null)
    }
  }

  /** M12：一键打开模组目录（系统文件管理器） */
  const runOpenModDir = async () => {
    if (!project) {
      setError('请先打开一个模组项目')
      return
    }
    const result = await getBridge().game.openDir(project.rootPath)
    if (!result.ok) setError(`打开失败：${result.message ?? '未知原因'}`)
  }

  return (
    <div className="setting-section">
      <div className="setting-title">游戏（铁锈战争）</div>

      <div className="setting-row">
        <span className="label">
          游戏安装目录
          <div className="desc">用于导入官方单位示例与游戏内模组；自动检测 Steam 安装位置，也可手动指定</div>
        </span>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <button className="btn" onClick={() => void runDetect(settings.gamePath || undefined)} disabled={busy !== null}>
            {busy === 'detect' ? '检测中…' : '自动检测'}
          </button>
          <button className="btn" onClick={() => void pickGameDir()} disabled={busy !== null}>
            手动选择
          </button>
        </div>
      </div>

      {detect && (
        <div className="setting-row">
          <span className="label">
            检测结果
            <div className="desc">
              {detect.found ? (
                <>
                  已找到：{detect.gamePath}
                  <br />
                  官方单位 {detect.units.length} 个 · 游戏内模组 {detect.mods.length} 个
                </>
              ) : (
                '未找到游戏目录（可手动选择包含 assets/units 的安装文件夹）'
              )}
            </div>
          </span>
        </div>
      )}

      {detect?.found && detect.units.length > 0 && (
        <div className="setting-row">
          <span className="label">
            导入官方单位示例
            <div className="desc">从游戏复制 {detect.units.length} 个官方单位（ini + 图片）到所选文件夹，生成 mod-info.txt 并打开</div>
          </span>
          <button className="btn primary" onClick={() => void importSample()} disabled={busy !== null}>
            {busy === 'sample' ? '导入中…' : '导入示例模组'}
          </button>
        </div>
      )}

      {detect?.found && detect.mods.length > 0 && (
        <div className="setting-row">
          <span className="label">
            从游戏导入模组
            <div className="desc">选择游戏 mods/units 下已安装的模组包，解压到所选文件夹</div>
          </span>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', maxWidth: 320 }}>
            <select
              className="select"
              value={selectedMod}
              onChange={(e) => setSelectedMod(e.target.value)}
              style={{ flex: 1, minWidth: 0 }}
            >
              {detect.mods.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
            <button className="btn primary" onClick={() => void importGameMod()} disabled={busy !== null}>
              {busy === 'mod' ? '导入中…' : '导入'}
            </button>
          </div>
        </div>
      )}

      {error && <div className="setting-error">{error}</div>}

      {/* M12 试玩联动 */}
      <div className="setting-divider" />
      <div className="setting-title">试玩联动</div>
      <div className="desc" style={{ marginBottom: 8 }}>
        打包后直接进游戏验证：先运行前检查，再启动游戏；模组目录一键打开。
      </div>

      <div className="setting-row">
        <span className="label">
          打开模组目录
          <div className="desc">在文件管理器中打开当前项目根目录</div>
        </span>
        <button className="btn" onClick={() => void runOpenModDir()} disabled={!project}>
          {project ? '打开模组目录' : '请先打开项目'}
        </button>
      </div>

      <div className="setting-row">
        <span className="label">
          运行前检查
          <div className="desc">检查 mod-info 完整性、图片引用文件存在、单位完整性</div>
        </span>
        <button className="btn" onClick={() => void runPreflight()} disabled={busy !== null || !project}>
          {busy === 'preflight' ? '检查中…' : '运行前检查'}
        </button>
      </div>

      {/* 上次检查记录（持久化；at=0 表示从未检查） */}
      {settings.gameLastCheck.at > 0 && (
        <div className="setting-row">
          <span className="label">
            上次检查
            <div className="desc">
              {new Date(settings.gameLastCheck.at).toLocaleString()} · {settings.gameLastCheck.ok ? '通过' : '未通过'}
            </div>
          </span>
          <span style={{ fontSize: 12, color: settings.gameLastCheck.ok ? 'var(--success, #188038)' : 'var(--danger)' }}>
            {settings.gameLastCheck.message}
          </span>
        </div>
      )}

      {preflight && (
        <div className="preflight-list">
          {preflight.length === 0 ? (
            <div className="preflight-ok">✓ 检查通过，可以进游戏验证</div>
          ) : (
            preflight.map((it, i) => (
              <div key={i} className={`preflight-item preflight-${it.severity}`}>
                <span className="preflight-mark">{it.severity === 'error' ? '✕' : '⚠'}</span>
                <span>
                  {it.message}
                  {it.file && <code className="preflight-file">{it.file}</code>}
                </span>
              </div>
            ))
          )}
        </div>
      )}

      {launchMsg && <div className="setting-error" style={{ color: 'var(--success, #188038)' }}>{launchMsg}</div>}

      <div className="setting-row">
        <span className="label">
          启动游戏
          <div className="desc">启动铁锈战争（需先在「游戏安装目录」配置成功）</div>
        </span>
        <button className="btn primary" onClick={() => void runLaunch()} disabled={busy !== null}>
          {busy === 'launch' ? '启动中…' : detect?.found ? '启动游戏' : '未配置游戏目录'}
        </button>
      </div>
    </div>
  )
}
