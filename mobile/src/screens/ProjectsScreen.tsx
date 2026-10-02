/**
 * 项目页：项目列表（最近打开排序）、导入模组、删除项目。
 * 导入走系统目录选择器（SAF），拷贝进应用私有目录后托管编辑。
 */
import { useState } from "react"
import { useWorkspace } from "../stores/workspace"
import { getBridge, appPath } from "../services/bridge"
import { AppIcon } from "../components/AppIcon"
import { formatRelativeTime } from "../utils/conversation"

/** 内置示例项目（离线可用；首次创建时落盘） */
const SAMPLE_UNIT = `# 示例单位：轻型坦克（由模板创建）
[core]
name: sampleTank
displayLocaleKey: 示例坦克
class: CustomUnitMetadata
price: 400
maxHp: 600
mass: 800
techLevel: 1
buildSpeed: 20s
radius: 14
isBio: false
builtFrom_1_name: landFactory

[graphics]
total_frames: 1
image: tank.png
image_wreak: tank_dead.png
image_shadow: AUTO
shadowOffsetX: 1
shadowOffsetY: 1

[attack]
canAttack: true
canAttackFlyingUnits: true
turretSize: 10
turretTurnSpeed: 1.5
maxAttackRange: 180
shootDelay: 18

[movement]
movementType: LAND
moveSpeed: 0.9
moveAccelerationSpeed: 0.02
moveDecelerationSpeed: 0.02
maxTurnSpeed: 1.0

[turret_1]
x: 0
y: 0
idleDir: 0
projectile: 1

[projectile_1]
life: 30
speed: 3
directDamage: 25
explodeEffect: NONE
`

const SAMPLE_MOD_INFO = `# 模组信息（由铁锈助手生成）
[mod]
name: 示例模组
title: 示例模组
description: 用铁锈助手手机版创建的示例模组
author: ohmytx
version: 1.0
`

export function ProjectsScreen() {
  const projects = useWorkspace((s) => s.projects)
  const setActiveProject = useWorkspace((s) => s.setActiveProject)
  const setActiveTab = useWorkspace((s) => s.setActiveTab)
  const addProject = useWorkspace((s) => s.addProject)
  const removeProject = useWorkspace((s) => s.removeProject)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")

  async function handleImport() {
    setBusy(true)
    setError("")
    try {
      const picked = await getBridge().mod.import()
      if (picked) {
        addProject({
          id: picked.rootPath,
          name: picked.name,
          rootPath: picked.rootPath,
          createdAt: Date.now(),
          lastOpenedAt: Date.now(),
        })
        setActiveProject(picked.rootPath)
        setActiveTab("editor")
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "导入失败")
    } finally {
      setBusy(false)
    }
  }

  /** 创建内置示例项目（appData/projects/示例项目） */
  async function createSample() {
    setBusy(true)
    setError("")
    try {
      const root = await appPath("projects", "示例项目")
      const bridge = getBridge()
      await bridge.project.createFolder(root, root, "units")
      await bridge.project.writeFile(root, `${root}/units/sampleTank.ini`, SAMPLE_UNIT, { hasBom: false })
      await bridge.project.writeFile(root, `${root}/mod-info.txt`, SAMPLE_MOD_INFO, { hasBom: false })
      addProject({
        id: root,
        name: "示例项目",
        rootPath: root,
        createdAt: Date.now(),
        lastOpenedAt: Date.now(),
      })
      setActiveProject(root)
      setActiveTab("editor")
    } catch (err) {
      setError(err instanceof Error ? err.message : "示例项目创建失败")
    } finally {
      setBusy(false)
    }
  }

  async function handleRemove(id: string, name: string) {
    if (!window.confirm(`删除项目「${name}」？项目文件将一并删除。`)) return
    const p = projects.find((x) => x.id === id)
    if (p) {
      try {
        await getBridge().project.delete(p.rootPath, p.rootPath)
      } catch {
        // 文件删除失败不阻塞列表移除
      }
    }
    removeProject(id)
  }

  /** 一键打包 .rwmod（保存位置由系统对话框决定） */
  async function handlePack(p: { id: string; name: string; rootPath: string }) {
    try {
      const r = await getBridge().mod.pack(p.rootPath)
      if ('canceled' in r && r.canceled) return
      if ('filePath' in r) {
        window.alert(`打包完成：${r.files} 个文件，${(r.size / 1024).toFixed(1)} KB`)
      }
    } catch (err) {
      window.alert(`打包失败：${err instanceof Error ? err.message : String(err)}`)
    }
  }

  function openProject(id: string) {
    setActiveProject(id)
    setActiveTab("editor")
  }

  return (
    <div className="m-screen">
      <header className="m-screen-header">
        <h1 className="m-screen-title">项目</h1>
        <button className="m-btn" onClick={handleImport} disabled={busy}>
          <AppIcon name="import" size={16} />
          {busy ? "导入中…" : "导入"}
        </button>
      </header>
      <div className="m-scroll">
        {error && <p className="m-empty">{error}</p>}
        {projects.length === 0 && (
          <div className="m-empty">
            <AppIcon name="folder" size={40} />
            <p>还没有项目。点击右上角「导入」，<br />选择模组文件夹（或 .rwmod）开始。</p>
            <button className="m-btn primary" onClick={handleImport} disabled={busy}>
              <AppIcon name="plus" size={16} />
              导入模组
            </button>
            <button className="m-btn" onClick={createSample} disabled={busy}>
              <AppIcon name="sparkle" size={16} />
              创建示例项目
            </button>
          </div>
        )}
        <div className="m-list">
          {[...projects]
            .sort((a, b) => b.lastOpenedAt - a.lastOpenedAt)
            .map((p) => (
              <div key={p.id} className="m-card" onClick={() => openProject(p.id)}>
                <div className="m-card-icon">
                  <AppIcon name="box" size={20} />
                </div>
                <div className="m-card-body">
                  <p className="m-card-title">{p.name}</p>
                  <p className="m-card-sub">
                    {formatRelativeTime(p.lastOpenedAt)} · {p.rootPath.split("/").pop()}
                  </p>
                </div>
                <button
                  className="m-card-arrow"
                  style={{ border: "none", background: "none", padding: 8, cursor: "pointer" }}
                  onClick={(e) => {
                    e.stopPropagation()
                    void handlePack(p)
                  }}
                  aria-label="打包模组"
                >
                  <AppIcon name="archive" size={18} />
                </button>
                <button
                  className="m-card-arrow"
                  style={{ border: "none", background: "none", padding: 8, cursor: "pointer" }}
                  onClick={(e) => {
                    e.stopPropagation()
                    void handleRemove(p.id, p.name)
                  }}
                  aria-label="删除项目"
                >
                  <AppIcon name="delete" size={18} />
                </button>
              </div>
            ))}
        </div>
      </div>
    </div>
  )
}
