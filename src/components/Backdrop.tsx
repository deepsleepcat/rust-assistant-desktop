/**
 * 背景层：根据设置渲染 图片 / 纯色 / 渐变 / 无，支持透明度与模糊。
 * 位于所有面板之下，面板是半透明的，让背景「透」出来。
 */
import { useEffect, useState } from 'react'
import { useWorkspaceStore } from '../stores/workspace'
import { getBridge } from '../services/bridge'

export function Backdrop() {
  const background = useWorkspaceStore((s) => s.settings.background)
  const project = useWorkspaceStore((s) => s.projects.find((p) => p.id === s.activeProjectId) ?? null)
  const notify = useWorkspaceStore((s) => s.notify)
  const [image, setImage] = useState<{ path: string; url: string | null }>({ path: '', url: null })

  useEffect(() => {
    if (background.kind !== 'image' || !background.imagePath) return
    let alive = true
    getBridge()
      .project.readImageAsDataUrl('', background.imagePath)
      .then((url) => alive && setImage({ path: background.imagePath ?? '', url }))
      .catch(() => {
        if (!alive) return
        setImage({ path: background.imagePath ?? '', url: null })
        notify('背景图片加载失败，请确认文件仍然存在')
      })
    return () => {
      alive = false
    }
  }, [background.kind, background.imagePath, notify, project?.rootPath])

  if (background.kind === 'none') return null

  const imageUrl = image.path === background.imagePath ? image.url : null
  const layerStyle: React.CSSProperties = { opacity: background.opacity / 100 }
  const blurStyle: React.CSSProperties = background.blur > 0 ? { filter: `blur(${background.blur}px)` } : {}

  return (
    <div className="backdrop" aria-hidden="true">
      {background.kind === 'image' && imageUrl && (
        <img className="backdrop-img" src={imageUrl} alt="" style={{ ...layerStyle, ...blurStyle }} />
      )}
      {background.kind === 'color' && <div className="backdrop-solid" style={{ ...layerStyle, backgroundColor: background.color }} />}
      {background.kind === 'gradient' && (
        <div className="backdrop-solid" style={{ ...layerStyle, backgroundImage: background.gradient, ...blurStyle }} />
      )}
    </div>
  )
}
