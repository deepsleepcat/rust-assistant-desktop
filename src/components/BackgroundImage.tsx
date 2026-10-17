import { useEffect, useRef, useState } from 'react'
import type { CSSProperties } from 'react'

export interface ImageCrop { x: number; y: number; zoom: number }
export const DEFAULT_IMAGE_CROP: ImageCrop = { x: 50, y: 50, zoom: 1 }

export function BackgroundImage({ src, crop = DEFAULT_IMAGE_CROP, style, onCrop }: { src: string; crop?: ImageCrop; style?: CSSProperties; onCrop?: (crop: ImageCrop) => void }) {
  const host = useRef<HTMLDivElement>(null)
  const drag = useRef<{ x: number; y: number; crop: ImageCrop } | null>(null)
  const [size, setSize] = useState({ width: 0, height: 0 })
  const [natural, setNatural] = useState({ width: 0, height: 0 })
  useEffect(() => {
    if (!host.current) return
    const observer = new ResizeObserver(([entry]) => setSize({ width: entry.contentRect.width, height: entry.contentRect.height }))
    observer.observe(host.current)
    return () => observer.disconnect()
  }, [])
  const scale = natural.width && natural.height ? Math.max(size.width / natural.width, size.height / natural.height) * crop.zoom : 1
  const width = natural.width * scale
  const height = natural.height * scale
  return <div ref={host} style={{ position: 'absolute', inset: 0, overflow: 'hidden', touchAction: 'none', cursor: onCrop ? 'grab' : undefined }}
    onPointerDown={(event) => { if (!onCrop) return; event.currentTarget.setPointerCapture(event.pointerId); drag.current = { x: event.clientX, y: event.clientY, crop } }}
    onPointerMove={(event) => {
      if (!onCrop || !drag.current) return
      const previous = drag.current
      const clamp = (value: number) => Math.max(0, Math.min(100, value))
      onCrop({ ...crop, x: width > size.width ? clamp(previous.crop.x - (event.clientX - previous.x) / (width - size.width) * 100) : 50, y: height > size.height ? clamp(previous.crop.y - (event.clientY - previous.y) / (height - size.height) * 100) : 50 })
    }}
    onPointerUp={() => { drag.current = null }} onPointerCancel={() => { drag.current = null }}>
    <img src={src} alt="" draggable={false} onLoad={(event) => setNatural({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })} style={{ position: 'absolute', width, height, maxWidth: 'none', left: (size.width - width) * crop.x / 100, top: (size.height - height) * crop.y / 100, pointerEvents: 'none', ...style }} />
  </div>
}
