import { useEffect, useState } from 'react'
import type { CloudBagApi, CloudBagTreeEntry } from '../../services/cloudBagApi'

export function CloudBagReadme({ api, slug, versionNo, files }: { api: CloudBagApi; slug: string; versionNo: number; files: CloudBagTreeEntry[] }) {
  const readme = files.find((file) => /^readme(?:\.(?:md|markdown|txt))?$/i.test(file.path))
  const [content, setContent] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let cancelled = false
    if (!readme) return
    void api.file(slug, versionNo, readme.path).then(({ bytes }) => {
      if (!cancelled) { setContent(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); setError(null) }
    }).catch((err: unknown) => { if (!cancelled) setError(err instanceof Error ? err.message : String(err)) })
    return () => { cancelled = true }
  }, [api, slug, versionNo, readme])
  if (!readme) return null
  return <section className="community-card cloudbag-readme"><h3>{readme.path}</h3>{error ? <p role="alert">README 加载失败：{error}</p> : content === null ? <p className="local-note">加载说明文档…</p> : <pre>{content}</pre>}</section>
}
