import { useEffect, useRef, useState } from 'react'
import { AppIcon } from './AppIcon'
import type { CommunityApi } from '../services/communityApi'
import { createAvatarObjectUrl } from '../services/communityApi'

interface CommunityAvatarProps {
  api: CommunityApi | null
  avatarPath?: string
  className?: string
  iconSize?: number
  label?: string
}

export function CommunityAvatar({ api, avatarPath, className, iconSize = 16, label = '社区账号头像' }: CommunityAvatarProps) {
  const requestKey = `${api?.endpoint ?? ''}:${avatarPath ?? ''}`
  const [image, setImage] = useState<{ key: string; url: string } | null>(null)
  const [failedKey, setFailedKey] = useState<string | null>(null)
  const objectUrlRef = useRef<string | null>(null)

  useEffect(() => {
    let alive = true
    if (objectUrlRef.current) {
      URL.revokeObjectURL(objectUrlRef.current)
      objectUrlRef.current = null
    }
    if (!api || !avatarPath) return () => undefined

    void api.avatar(avatarPath)
      .then((result) => {
        if (!alive || !result) return
        const objectUrl = createAvatarObjectUrl(result.bytes, result.contentType)
        objectUrlRef.current = objectUrl
        setImage({ key: requestKey, url: objectUrl })
      })
      .catch(() => alive && setFailedKey(requestKey))

    return () => {
      alive = false
      if (objectUrlRef.current) {
        URL.revokeObjectURL(objectUrlRef.current)
        objectUrlRef.current = null
      }
    }
  }, [api, avatarPath, requestKey])

  const imageUrl = image?.key === requestKey && failedKey !== requestKey ? image.url : null
  if (imageUrl) {
    return <img className={className} src={imageUrl} alt={label} onError={() => {
      if (objectUrlRef.current) {
        URL.revokeObjectURL(objectUrlRef.current)
        objectUrlRef.current = null
      }
      setFailedKey(requestKey)
    }} />
  }
  return <span className={`${className ?? ''} community-avatar-fallback`.trim()} role="img" aria-label={label}><AppIcon name="user" size={iconSize} /></span>
}
