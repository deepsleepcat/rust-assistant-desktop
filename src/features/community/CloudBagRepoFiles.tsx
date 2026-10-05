import { useEffect, useState } from 'react'
import { AppIcon } from '../../components/AppIcon'
import { Modal } from '../../components/Modal'
import { PanelState } from '../../components/PanelState'
import type { CloudBagApi } from '../../services/cloudBagApi'
import { buildCloudBagTree, formatBytes } from './cloudBagData'

export function TreeNodeRow({ node, depth, onOpenFile, expanded, toggle }: {
  node: ReturnType<typeof buildCloudBagTree>[number]
  depth: number
  onOpenFile: (path: string) => void
  expanded: Set<string>
  toggle: (path: string) => void
}) {
  if (node.isDirectory) {
    const open = expanded.has(node.path)
    return (
      <>
        <button
          type="button"
          className="cloudbag-tree-row"
          style={{ paddingLeft: 8 + depth * 16 }}
          onClick={() => toggle(node.path)}
          aria-expanded={open}
        >
          <AppIcon name={open ? 'expand' : 'folder'} size={12} /> {node.name}
        </button>
        {open && node.children.map((child) => (
          <TreeNodeRow key={child.path} node={child} depth={depth + 1} onOpenFile={onOpenFile} expanded={expanded} toggle={toggle} />
        ))}
      </>
    )
  }
  return (
    <button
      type="button"
      className="cloudbag-tree-row"
      style={{ paddingLeft: 8 + depth * 16 }}
      onClick={() => onOpenFile(node.path)}
      title={`${node.path}（${formatBytes(node.size)}）`}
    >
      <AppIcon name="file" size={12} /> {node.name}
      <span className="grow" />
      <span className="post-card-meta">{formatBytes(node.size)}</span>
    </button>
  )
}

export function FilePreviewModal({ api, slug, versionNo, path, onClose }: {
  api: CloudBagApi
  slug: string
  versionNo: number
  path: string
  onClose: () => void
}) {
  const [state, setState] = useState<{ kind: 'loading' } | { kind: 'text'; content: string } | { kind: 'image'; url: string } | { kind: 'error'; message: string }>({ kind: 'loading' })
  useEffect(() => {
    let alive = true
    const objectUrl = { current: '' }
    void api.file(slug, versionNo, path).then(({ bytes, contentType }) => {
      if (!alive) return
      if (contentType.startsWith('image/')) {
        const url = URL.createObjectURL(new Blob([bytes], { type: contentType }))
        objectUrl.current = url
        setState({ kind: 'image', url })
        return
      }
      setState({ kind: 'text', content: new TextDecoder().decode(bytes) })
    }).catch((err) => {
      if (alive) setState({ kind: 'error', message: err instanceof Error ? err.message : String(err) })
    })
    return () => {
      alive = false
      if (objectUrl.current) URL.revokeObjectURL(objectUrl.current)
    }
  }, [api, slug, versionNo, path])
  return (
    <Modal wide title={<span><AppIcon name="file" size={14} /> {path}</span>} onClose={onClose} footer={<button className="btn" onClick={onClose}>关闭</button>}>
      {state.kind === 'loading' && <PanelState kind="loading" title="读取文件…" />}
      {state.kind === 'error' && <PanelState kind="error" title="文件读取失败" description={state.message} />}
      {state.kind === 'text' && <pre className="cloudbag-file-preview">{state.content.slice(0, 200_000)}</pre>}
      {state.kind === 'image' && <img src={state.url} alt={path} style={{ maxWidth: '100%' }} />}
    </Modal>
  )
}

