/**
 * 炮塔编辑器（M12）：可视化调整单位文件的 [turret_N] 炮塔坐标。
 * - 左侧表格：每个炮塔的 x/y 及常用键（idleDir/projectile/size），数值即时修改；
 * - 右侧预览：加载 [graphics] image 作为单位图，按 x/y（图像中心为原点）绘制炮塔点，
 *   点击预览可把炮塔移到该位置；
 * - 保存：行级写回当前标签内容并走 saveTab（含外部修改拦截），编辑器同步更新。
 */
import { useEffect, useMemo, useState } from 'react'
import { useWorkspaceStore } from '../../stores/workspace'
import { getBridge } from '../../services/bridge'
import { useEscapeHandler } from '../../utils/modalStack'
import { findUnitImage, parseTurrets, updateTurretValue } from '../../features/editor/turretUtils'
import { dataReady, getEnToZhDict, getZhToEnDict, loadCodeData } from '../../services/codeData'

export function TurretEditorModal({ onClose }: { onClose: () => void }) {
  const tabId = useWorkspaceStore((s) => s.activeTabId)
  const tab = useWorkspaceStore((s) => s.openTabs.find((t) => t.id === tabId))
  const updateTabContent = useWorkspaceStore((s) => s.updateTabContent)
  const saveTab = useWorkspaceStore((s) => s.saveTab)
  const project = useWorkspaceStore((s) => s.projects.find((p) => p.id === s.activeProjectId) ?? null)
  const [imageUrl, setImageUrl] = useState<string | null>(null)
  const [imgSize, setImgSize] = useState<{ w: number; h: number } | null>(null)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)

  useEscapeHandler(onClose)

  // 中文显示层兼容：内容可能是 [炮塔_1] / x坐标: 形式——解析/写回走词典回译。
  // 词典实时取（loadCodeData 异步填充），不放入 useMemo 依赖；词典就绪后重渲染自愈
  // 中文显示层兼容：内容可能是 [炮塔_1] / x坐标: 形式——解析/写回走词典回译。
  // 词典异步加载（loadCodeData）：未就绪时主动加载，完成后重渲染自愈
  const [dictReady, setDictReady] = useState(dataReady())
  useEffect(() => {
    if (dictReady) return
    let alive = true
    void loadCodeData().then(() => alive && setDictReady(true)).catch(() => undefined)
    return () => { alive = false }
  }, [dictReady])
  const zhToEn = useMemo(() => {
    const dict = getZhToEnDict()
    return dict.size > 0 ? (s: string) => dict.get(s) : undefined
    // eslint-disable-next-line react-hooks/exhaustive-deps -- dictReady 是词典就绪信号（词典是模块级全局）
  }, [dictReady])

  // 解析当前内容（每次内容变化重新解析，编辑器内改动同步可见；
  // updateTabContent 每次创建新 tab 对象，[tab] 已覆盖内容变化）
  const turrets = useMemo(() => (tab ? parseTurrets(tab.content, zhToEn) : []), [tab, zhToEn])

  // 加载单位图（graphics image）；图变化时异步更新（setState 只发生在异步回调，避免级联渲染）
  const imageRel = tab ? findUnitImage(tab.content, zhToEn) : undefined
  useEffect(() => {
    let alive = true
    if (!tab || !project || !imageRel) return
    // 路径解析：官方/社区模组的 image 值通常是相对项目根的路径（units/land/tank.png），
    // 也可能是相对文件目录（模板生成）或带 CORE:/project: 前缀——逐级尝试
    const candidates: string[] = []
    const cleaned = imageRel.replace(/^(CORE|PROJECT|ROOT):/i, '').replace(/\\/g, '/')
    const fileDir = tab.path.replace(/[^\\/]+$/, '')
    if (!cleaned.includes('/') && !cleaned.includes('\\')) {
      // 纯文件名：文件同目录优先，其次项目根
      candidates.push(tab.path.replace(/[^\\/]+$/, cleaned), `${project.rootPath}\\${cleaned}`)
    } else {
      // 含路径：项目根相对优先（游戏惯例），其次文件同目录拼接
      candidates.push(`${project.rootPath}\\${cleaned}`, `${fileDir}${cleaned}`)
    }
    const load = (idx: number) => {
      if (!alive || idx >= candidates.length) {
        if (alive) setImageUrl(null)
        return
      }
      void getBridge()
        .project.readImageAsDataUrl(project.rootPath, candidates[idx])
        .then((url) => {
          if (!alive) return
          setImageUrl(url)
          const img = new Image()
          img.onload = () => alive && setImgSize({ w: img.naturalWidth, h: img.naturalHeight })
          img.src = url
        })
        .catch(() => load(idx + 1)) // 尝试下一个候选路径
    }
    load(0)
    return () => { alive = false }
    // 只依赖派生值（路径/图路径），对象引用变化不触发无意义重载
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab?.path, project?.rootPath, imageRel])

  const setValue = (index: number, key: string, value: string) => {
    if (!tab) return
    // 非法中间态（空串/单独 -/e）不写回，避免污染文件
    if (value.trim() === '' || value === '-' || value === 'e' || value === '+' || value === '.') return
    const enToZh = () => {
      const d = getEnToZhDict()
      return d.size > 0 ? (s: string) => d.get(s.toLowerCase()) : undefined
    }
    updateTabContent(tab.id, updateTurretValue(tab.content, index, key, value, zhToEn, enToZh()))
    setSaved(false)
  }

  const save = async () => {
    if (!tab) return
    setSaving(true)
    const ok = await saveTab(tab.id)
    setSaving(false)
    if (ok) setSaved(true)
  }

  if (!tab) return null

  const numeric = (v: string | undefined): number => {
    const n = Number(v)
    return Number.isFinite(n) ? n : 0
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card confirm-card turret-card" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          炮塔编辑器
          <span className="grow" />
          {saved && <span style={{ color: 'var(--text-secondary)', fontSize: 12 }}>已保存</span>}
        </div>
        <div className="modal-body turret-body">
          {turrets.length === 0 ? (
            <p className="mod-tip">当前文件没有 [turret_N] 段。炮塔 = 单位上的武器挂点，格式见代码表 turret 节。</p>
          ) : (
            <>
              <div className="turret-table">
                <table>
                  <thead>
                    <tr>
                      <th>炮塔</th>
                      <th title="横坐标偏移">x</th>
                      <th title="纵坐标偏移">y</th>
                      <th title="待机朝向角度（idleDir）">待机朝向</th>
                      <th title="炮塔发射的弹体（projectile）">弹体</th>
                      <th title="炮塔大小（size）">大小</th>
                    </tr>
                  </thead>
                  <tbody>
                    {turrets.map((t, idx) => (
                      // key 用序号兜底：文件中出现重复编号时避免 React key 冲突
                      <tr key={`${t.index}-${idx}`}>
                        <td>{t.index}</td>
                        <td>
                          <input
                            type="number"
                            value={t.values.get('x') ?? '0'}
                            onChange={(e) => setValue(t.index, 'x', e.target.value)}
                            aria-label={`炮塔 ${t.index} 的 x 坐标`}
                          />
                        </td>
                        <td>
                          <input
                            type="number"
                            value={t.values.get('y') ?? '0'}
                            onChange={(e) => setValue(t.index, 'y', e.target.value)}
                            aria-label={`炮塔 ${t.index} 的 y 坐标`}
                          />
                        </td>
                        <td>
                          <input
                            type="number"
                            value={t.values.get('idleDir') ?? '0'}
                            onChange={(e) => setValue(t.index, 'idleDir', e.target.value)}
                            aria-label={`炮塔 ${t.index} 的 idleDir`}
                          />
                        </td>
                        <td>
                          <input
                            type="number"
                            value={t.values.get('projectile') ?? ''}
                            onChange={(e) => setValue(t.index, 'projectile', e.target.value)}
                            aria-label={`炮塔 ${t.index} 的 projectile`}
                          />
                        </td>
                        <td>
                          <input
                            type="number"
                            value={t.values.get('size') ?? '8'}
                            onChange={(e) => setValue(t.index, 'size', e.target.value)}
                            aria-label={`炮塔 ${t.index} 的 size`}
                          />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <p className="mod-tip">x/y 是炮塔相对单位图中心的像素坐标（y 向下为正）。点击右侧预览图可移动炮塔。</p>
              </div>
              {imageUrl && imgSize ? (
                <div
                  className="turret-preview"
                  style={{ position: 'relative', width: '100%', maxHeight: 320, overflow: 'auto', background: 'repeating-conic-gradient(#f0f0f0 0% 25%, #fff 0% 50%) 0 0 / 20px 20px' }}
                >
                  <img src={imageUrl} alt="单位图" style={{ display: 'block', maxWidth: 'none' }} draggable={false} />
                  {turrets.map((t, idx) => {
                    const cx = imgSize.w / 2 + numeric(t.values.get('x'))
                    const cy = imgSize.h / 2 + numeric(t.values.get('y'))
                    return (
                      <button
                        key={`${t.index}-${idx}`}
                        className="turret-dot"
                        title={`炮塔 ${t.index}（x: ${t.values.get('x') ?? 0}, y: ${t.values.get('y') ?? 0}）— 点击可拖动改坐标`}
                        aria-label={`炮塔 ${t.index}`}
                        style={{
                          position: 'absolute',
                          left: cx - 7,
                          top: cy - 7,
                          width: 14,
                          height: 14,
                        }}
                        onClick={(e) => {
                          // 点击预览：把该炮塔移到点击处（相对图中心）。
                          // 预览容器可滚动：需加 scrollLeft/scrollTop 偏移，否则大图滚动后落点错位
                          const container = e.currentTarget.parentElement!
                          const rect = container.getBoundingClientRect()
                          const px = e.clientX - rect.left + container.scrollLeft
                          const py = e.clientY - rect.top + container.scrollTop
                          setValue(t.index, 'x', String(Math.round(px - imgSize.w / 2)))
                          setValue(t.index, 'y', String(Math.round(py - imgSize.h / 2)))
                        }}
                      >
                        {t.index}
                      </button>
                    )
                  })}
                </div>
              ) : (
                <p className="mod-tip">未找到单位图（[graphics] image:），仅表格编辑坐标。</p>
              )}
            </>
          )}
        </div>
        <div className="modal-footer">
          <button className="btn" onClick={onClose}>关闭</button>
          {turrets.length > 0 && (
            <button className="btn primary" onClick={() => void save()} disabled={saving || !tab.dirty}>
              {saving ? '保存中…' : '保存炮塔坐标'}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
