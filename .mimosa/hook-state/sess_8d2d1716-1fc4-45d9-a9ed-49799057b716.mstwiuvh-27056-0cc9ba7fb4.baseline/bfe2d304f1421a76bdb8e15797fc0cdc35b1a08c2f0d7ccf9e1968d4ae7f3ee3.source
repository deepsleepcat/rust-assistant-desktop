/**
 * M6.5 音频播放器：打开模组内音频文件（.ogg/.mp3/.wav/.m4a/.flac）时展示。
 * 沿用图片预览的安全模式：主进程读文件 → data URL（限项目目录内）。
 */
import { useEffect, useState } from 'react'
import { getBridge } from '../../services/bridge'
import { truncateMiddle } from '../../utils/paths'

export function AudioViewer({ rootPath, path }: { rootPath: string; path: string }) {
  const [loaded, setLoaded] = useState<{ path: string; url: string | null; error: string | null }>({ path: '', url: null, error: null })

  useEffect(() => {
    let alive = true
    void getBridge()
      .project.readAudioAsDataUrl(rootPath, path)
      .then((dataUrl) => alive && setLoaded({ path, url: dataUrl, error: null }))
      .catch((err: unknown) => alive && setLoaded({ path, url: null, error: err instanceof Error ? err.message : '音频读取失败' }))
    return () => { alive = false }
  }, [rootPath, path])

  const url = loaded.path === path ? loaded.url : null
  const error = loaded.path === path ? loaded.error : null

  return (
    <div className="audio-viewer" id="editor-pane" role="tabpanel">
      <div className="image-viewer-toolbar">
        <span className="image-viewer-path" title={path}>{truncateMiddle(path, 90)}</span>
      </div>
      {error ? (
        <div className="audio-error">无法播放音频：{error}</div>
      ) : url ? (
        <audio controls src={url} />
      ) : (
        <div className="audio-loading">正在加载音频…</div>
      )}
    </div>
  )
}
