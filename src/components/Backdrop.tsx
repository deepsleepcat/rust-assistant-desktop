/**
 * 背景层：根据设置渲染 图片 / 纯色 / 渐变 / 无，支持透明度与模糊。
 * 位于所有面板之下，面板是半透明的，让背景「透」出来。
 */
import { useEffect, useState } from 'react'
import { useWorkspaceStore } from '../stores/workspace'
import { getBridge } from '../services/bridge'

export function Backdrop() {
  const background = useWorkspaceStore((s) => s.settings.background)
  const [image, setImage] = useState<{ path: string; url: string | null }>({ path: '', url: null })

  useEffect(() => {
    if (background.kind !== 'image' || !background.imagePath) return
    let alive = true
    getBridge()
      .project.readImageAsDataUrl(background.imagePath)
      .then((url) => alive && setImage({ path: background.imagePath ?? '', url }))
      .catch(() => alive && setImage({ path: background.imagePath ?? '', url: null }))
    return () => {
      alive = false
    }
  }, [background.kind, background.imagePath])

  if (background.kind === 'none') return null

  const imageUrl = image.path === background.imagePath ? image.url : null
  const style: React.CSSProperties = { opacity: background.opacity / 100 }

  return (
    <div className="backdrop" aria-hidden="true">
      {background.kind === 'image' && imageUrl && (
        <img className="backdrop-img" src={imageUrl} alt="" style={{ ...style, filter: `blur(${background.blur}px)` }} />
      )}
      {background.kind === 'color' && <div className="backdrop-solid" style={{ ...style, background: background.color }} />}
      {background.kind === 'gradient' && (
        <div className="backdrop-solid" style={{ ...style, background: background.gradient, filter: `blur(${background.blur}px)` }} />
      )}
    </div>
  )
}
