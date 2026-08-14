/** 图片文件预览：保持比例、支持适应窗口/原始尺寸/缩放。 */
import { useEffect, useState } from 'react'
import { getBridge } from '../../services/bridge'
import { AppIcon } from '../../components/AppIcon'
import { truncateMiddle } from '../../utils/paths'

interface ImageViewerProps {
  path: string
  rootPath: string
}

export function ImageViewer({ path, rootPath }: ImageViewerProps) {
  const [loaded, setLoaded] = useState<{ path: string; url: string | null; error: string | null }>({ path: '', url: null, error: null })
  const [scale, setScale] = useState<'fit' | 'actual' | number>('fit')

  useEffect(() => {
    let alive = true
    void getBridge().project.readImageAsDataUrl(rootPath, path).then((dataUrl) => {
      if (alive) setLoaded({ path, url: dataUrl, error: null })
    }).catch((err: unknown) => {
      if (alive) setLoaded({ path, url: null, error: err instanceof Error ? err.message : '图片读取失败' })
    })
    return () => { alive = false }
  }, [path, rootPath])

  const url = loaded.path === path ? loaded.url : null
  const error = loaded.path === path ? loaded.error : null

  const imageStyle: React.CSSProperties = scale === 'fit'
    ? { maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }
    : scale === 'actual'
      ? { width: 'auto', height: 'auto', maxWidth: 'none', maxHeight: 'none' }
      : { width: `${scale}%`, height: 'auto', maxWidth: 'none', maxHeight: 'none' }

  return (
    <div className="image-viewer" id="editor-pane" role="tabpanel">
      <div className="image-viewer-toolbar">
        <span className="image-viewer-path" title={path}>{truncateMiddle(path, 90)}</span>
        <span className="image-viewer-spacer" />
        <button className={scale === 'fit' ? 'btn primary' : 'btn'} onClick={() => setScale('fit')}>适应窗口</button>
        <button className={scale === 'actual' ? 'btn primary' : 'btn'} onClick={() => setScale('actual')}>原始尺寸</button>
        <button className="icon-btn" title="缩小" onClick={() => setScale((s) => typeof s === 'number' ? Math.max(25, s - 25) : 75)}>
          −
        </button>
        <span className="image-viewer-scale">{scale === 'fit' ? '适应' : scale === 'actual' ? '100%' : `${scale}%`}</span>
        <button className="icon-btn" title="放大" onClick={() => setScale((s) => typeof s === 'number' ? Math.min(400, s + 25) : 125)}>
          +
        </button>
      </div>
      <div className="image-viewer-canvas">
        {error && <div className="image-viewer-error"><AppIcon name="file" size={28} /><div>无法预览图片</div><small>{error}</small></div>}
        {!error && !url && <div className="image-viewer-loading">正在加载图片…</div>}
        {url && <img src={url} alt={path} style={imageStyle} draggable={false} />}
      </div>
    </div>
  )
}
