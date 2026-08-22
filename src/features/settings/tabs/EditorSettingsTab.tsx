/**
 * 设置 → 编辑器：字体/字号、语义检查器开关、项目自定义规则（rules/*.json）。
 * 从 SettingsModal 拆出（M39 巨型函数治理）；目标游戏版本下拉与规则加载随本组件挂载。
 */
import { useEffect, useState } from 'react'
import { useWorkspaceStore } from '../../../stores/workspace'
import { FONT_OPTIONS } from '../../../utils/settings'
import { getGameVersions, loadCodeData } from '../../../services/codeData'
import { ALL_SEMANTIC_CHECKERS } from '../../../features/editor/semanticChecks/registry'
import { loadProjectRuleSets, type ProjectRuleSet } from '../../../features/editor/semanticChecks/customRules'

export function EditorSettingsTab() {
  const settings = useWorkspaceStore((s) => s.settings)
  const updateSettings = useWorkspaceStore((s) => s.updateSettings)
  const activeProject = useWorkspaceStore((s) => s.projects.find((p) => p.id === s.activeProjectId) ?? null)
  const [gameVersions, setGameVersions] = useState<Array<{ versionName: string; versionNumber: number }>>([])
  // M21：项目自定义规则（rules/*.json；可单独开关）
  const [projectRules, setProjectRules] = useState<{ sets: ProjectRuleSet[]; errors: Array<{ file: string; errors: string[] }> } | null>(null)

  // 目标游戏版本下拉数据（异步加载版本表；失败时只显示「跟随最新」）。
  // 存储的版本名不在当前版本表（数据更新后旧值残留）→ 归一化回「跟随最新」，
  // 避免 select 显示与实际存储脱节
  useEffect(() => {
    let alive = true
    void loadCodeData().then(() => {
      if (!alive) return
      const versions = getGameVersions()
      setGameVersions(versions)
      const stored = useWorkspaceStore.getState().settings.targetGameVersion
      if (stored && versions.length > 0 && !versions.some((v) => v.versionName === stored)) {
        useWorkspaceStore.getState().updateSettings({ targetGameVersion: '' })
      }
    })
    return () => {
      alive = false
    }
  }, [])

  // 加载当前项目的自定义规则（无项目/无 rules 目录时为空）
  useEffect(() => {
    let alive = true
    if (!activeProject) return
    void loadProjectRuleSets(activeProject.rootPath)
      .then((r) => alive && setProjectRules(r))
      .catch(() => alive && setProjectRules({ sets: [], errors: [] }))
    return () => {
      alive = false
    }
  }, [activeProject])

  return (
    <div className="setting-section">
      <div className="setting-title">编辑器</div>
      <div className="setting-row">
        <span className="label">
          字体
          <div className="desc">代码显示字体</div>
        </span>
        <select value={settings.fontFamily} onChange={(e) => updateSettings({ fontFamily: e.target.value })}>
          {FONT_OPTIONS.map((f) => (
            <option key={f.value} value={f.value}>
              {f.label}
            </option>
          ))}
        </select>
      </div>
      <div className="setting-row">
        <span className="label">
          字号
          <div className="desc">代码文字大小</div>
        </span>
        <input
          type="range"
          min={12}
          max={20}
          value={settings.fontSize}
          onChange={(e) => updateSettings({ fontSize: Number(e.target.value) })}
        />
        <span style={{ width: 34, textAlign: 'right', fontSize: 12, color: 'var(--text-2)' }}>{settings.fontSize}px</span>
      </div>
      <div className="setting-divider" />
      <div className="setting-title">语义检查器（M10）</div>
      <div className="desc" style={{ marginBottom: 8 }}>
        编辑器波浪线、AI 写后质检与项目检查共用这些规则，可单独开关。
      </div>
      <div className="setting-row">
        <span className="label">
          目标游戏版本
          <div className="desc">写入的字段若超出该版本会提示（版本兼容检查）</div>
        </span>
        <select
          value={settings.targetGameVersion}
          onChange={(e) => updateSettings({ targetGameVersion: e.target.value })}
        >
          <option value="">
            跟随最新{gameVersions.length > 0 ? `（${gameVersions[gameVersions.length - 1].versionName}）` : ''}
          </option>
          {gameVersions.map((v) => (
            <option key={v.versionNumber} value={v.versionName}>
              {v.versionName}
            </option>
          ))}
        </select>
      </div>
      <div className="checker-list">
        {ALL_SEMANTIC_CHECKERS.map((c) => {
          const on = settings.semanticCheckers[c.id] !== false
          return (
            <label key={c.id} className="checker-item">
              <input
                type="checkbox"
                checked={on}
                onChange={(e) =>
                  updateSettings({ semanticCheckers: { ...settings.semanticCheckers, [c.id]: e.target.checked } })
                }
              />
              <span className="checker-name">{c.title}</span>
              <span className="checker-desc">{c.description}</span>
            </label>
          )
        })}
      </div>
      <div className="setting-divider" />
      <div className="setting-title">项目自定义规则（M19/M21）</div>
      <div className="desc" style={{ marginBottom: 8 }}>
        把 JSON 规则文件放进项目 <code>rules/</code> 目录即可被加载（AI 生成的用例可一键保存到这里）。
        规则是声明式的（数值区间/必需键/枚举/正则），<b>不执行任何脚本</b>——恶意规则最多产生误报，无法读写文件。
      </div>
      {!activeProject ? (
        <div className="desc">打开项目后显示该项目 rules/ 目录下的自定义规则。</div>
      ) : projectRules === null ? (
        <div className="desc">加载中…</div>
      ) : projectRules.sets.length === 0 && projectRules.errors.length === 0 ? (
        <div className="desc">该项目没有自定义规则（可让 AI 生成检查用例后保存）。</div>
      ) : (
        <>
          {projectRules.sets.map((s) => (
            <div key={s.file}>
              <div className="checker-list">
                {s.rules.map((r) => {
                  const key = `custom:${r.id}`
                  const on = settings.semanticCheckers[key] !== false
                  return (
                    <label key={r.id} className="checker-item">
                      <input
                        type="checkbox"
                        checked={on}
                        onChange={(e) =>
                          updateSettings({ semanticCheckers: { ...settings.semanticCheckers, [key]: e.target.checked } })
                        }
                      />
                      <span className="checker-name">{r.title}</span>
                      <span className="checker-desc">
                        {r.description ?? r.check.type}
                        {r.section ? ` · 节 [${r.section}]` : ''}
                        {r.key ? ` · ${r.key}` : ''}
                        {' · '}
                        <code style={{ fontSize: 10.5 }}>{s.file}</code>
                      </span>
                    </label>
                  )
                })}
              </div>
            </div>
          ))}
          {projectRules.errors.map((e) => (
            <div key={e.file} className="setting-error">
              {e.file} 校验失败：{e.errors.join('；')}
            </div>
          ))}
        </>
      )}
    </div>
  )
}
