import { useEffect, useRef, useState } from 'react'
import type { CommunityApi } from '../../services/communityApi'

export function CommunityNickname({ api }: { api: CommunityApi }) {
  const [nickname, setNickname] = useState('')
  const [busy, setBusy] = useState(false)
  const [ready, setReady] = useState(false)
  const [message, setMessage] = useState('')
  const generation = useRef(0)
  useEffect(() => {
    const current = ++generation.current
    let active = true
    void api.profile().then((profile) => {
      if (!active || generation.current !== current) return
      setNickname(profile.nickname)
      setReady(true)
    }).catch((error: unknown) => {
      if (generation.current === current) setMessage(error instanceof Error ? error.message : String(error))
    })
    return () => { active = false }
  }, [api])
  const save = async () => {
    if (!ready || busy) return
    const current = ++generation.current
    setBusy(true)
    setMessage('')
    try {
      const profile = await api.setNickname(nickname)
      if (generation.current !== current) return
      setNickname(profile.nickname)
      setMessage('社区昵称已保存，刷新帖子后可见')
    } catch (error) {
      if (generation.current === current) setMessage(error instanceof Error ? error.message : String(error))
    } finally {
      if (generation.current === current) setBusy(false)
    }
  }
  return <form className="community-card community-nickname" onSubmit={(event) => { event.preventDefault(); void save() }}>
    <label>社区昵称<input value={nickname} disabled={!ready || busy} onChange={(event) => setNickname(event.target.value)} autoComplete="nickname" /></label>
    <button className="btn" type="submit" disabled={!ready || busy || !nickname.trim()}>{busy ? '保存中…' : '保存昵称'}</button>
    {message && <p role="status">{message}</p>}
  </form>
}
