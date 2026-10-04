/**
 * 资源预览：图片只读预览 + 其它资源的信息卡片。
 *
 * 文件树里点开的非文本文件不能进编辑器（旧实现把 png 当 UTF-8 文本读，
 * 打开即乱码甚至写坏文件），这里统一走只读预览：
 * - 图片：data URL 显示，给出像素尺寸与「适应/原始」缩放切换；
 * - 其它：给出文件大小与类型提示，不提供编辑入口。
 */
import { useEffect, useState } from 'react'
import { getBridge } from '../../services/bridge'
import { AppIcon } from '../../components/AppIcon'
import { extname, isPreviewableImage } from '../../utils/paths'
import { fileNameOf } from './openFile'

/** 人类可读的文件大小 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '未知'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`
}

interface AssetPreviewProps {
  projectRoot: string
  path: string
  name?: string
  onClose: () => void
}

export function AssetPreview({ projectRoot, path, name, onClose }: AssetPreviewProps) {
  const fileName = name ?? fileNameOf(path)
  const isImage = isPreviewableImage(fileName)
  const [dataUrl, setDataUrl] = useState<string | null>(null)
  const [size, setSize] = useState<number | null>(null)
  const [dimensions, setDimensions] = useState<{ w: number; h: number } | null>(null)
  const [zoom, setZoom] = useState<'fit' | 'actual'>('fit')
  const [error, setError] = useState('')

  useEffect(() => {
    let alive = true
    setDataUrl(null)
    setError('')
    setDimensions(null)
    void (async () => {
      const bridge = getBridge()
      try {
        const info = await bridge.project.stat(projectRoot, path)
        if (alive) setSize(info.size)
      } catch {
        // 大小拿不到不影响预览
      }
      if (!isImage) return
      try {
        const url = await bridge.project.readImageAsDataUrl(projectRoot, path)
        if (alive) setDataUrl(url)
      } catch (err) {
        if (alive) setError(err instanceof Error ? err.message : '图片读取失败')
      }
    })()
    return () => {
      alive = false
    }
  }, [projectRoot, path, isImage])

  return (
    <div className="m-screen">
      <header className="m-screen-header">
        <button className="m-editor-btn" onClick={onClose} aria-label="返回">
          <AppIcon name="close" size={18} />
        </button>
        <h1 className="m-screen-title">{fileName}</h1>
        {isImage && dataUrl && (
          <button className="m-btn" onClick={() => setZoom((z) => (z === 'fit' ? 'actual' : 'fit'))}>
            <AppIcon name="zoom" size={16} />
            {zoom === 'fit' ? '适应' : '原始'}
          </button>
        )}
      </header>
      <div className="m-scroll asset-preview">
        {error && <p className="m-empty">{error}</p>}
        {isImage && !dataUrl && !error && <p className="m-empty">图片加载中…</p>}
        {isImage && dataUrl && (
          <div className={`asset-image-wrap${zoom === 'actual' ? ' actual' : ''}`}>
            <img
              src={dataUrl}
              alt={fileName}
              onLoad={(e) => {
                const img = e.currentTarget
                setDimensions({ w: img.naturalWidth, h: img.naturalHeight })
              }}
              onError={() => setError('图片解码失败（文件可能损坏或不是有效图片）')}
            />
          </div>
        )}
        <div className="asset-meta">
          <div className="asset-meta-row">
            <AppIcon name={isImage ? 'image' : 'file'} size={16} />
            <span>{isImage ? '图片' : `${extname(fileName) || '未知'} 资源`}</span>
          </div>
          {dimensions && (
            <div className="asset-meta-row">
              <span className="asset-meta-key">像素尺寸</span>
              <span>
                {dimensions.w} × {dimensions.h}
              </span>
            </div>
          )}
          <div className="asset-meta-row">
            <span className="asset-meta-key">文件大小</span>
            <span>{size === null ? '读取中…' : formatBytes(size)}</span>
          </div>
          {!isImage && <p className="asset-meta-hint">此类资源不支持在手机端编辑，可用打包导出后到电脑端处理。</p>}
        </div>
      </div>
    </div>
  )
}
