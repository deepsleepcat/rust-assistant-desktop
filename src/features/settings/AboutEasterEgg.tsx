import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { IconClose } from '../../components/icons'
import { useEscapeHandler } from '../../utils/modalStack'
import { useFocusTrap } from '../../utils/focusTrap'
import './aboutEasterEgg.css'

const VIDEO_URL = `${import.meta.env.BASE_URL}videos/after-humanity.mp4`

export function AboutEasterEgg() {
  const [open, setOpen] = useState(false)

  return (
    <>
      <button type="button" className="about-easter-egg-trigger" onClick={() => setOpen(true)}>不要点我</button>
      {open && createPortal(<EasterEggPlayer onClose={() => setOpen(false)} />, document.body)}
    </>
  )
}

function EasterEggPlayer({ onClose }: { onClose: () => void }) {
  const containerRef = useRef<HTMLDivElement>(null)
  const videoRef = useRef<HTMLVideoElement>(null)
  const [playBlocked, setPlayBlocked] = useState(false)
  const [failed, setFailed] = useState(false)
  useEscapeHandler(onClose)
  useFocusTrap(containerRef, true)

  useEffect(() => {
    const video = videoRef.current
    if (!video) return
    let active = true
    // 在用户点击后立即有声播放；关闭和组件卸载时停止声音及解码。
    void video.play().catch((error: unknown) => {
      if (active && error instanceof Error && error.name === 'NotAllowedError') setPlayBlocked(true)
    })
    return () => {
      active = false
      video.pause()
    }
  }, [])

  return (
    <div ref={containerRef} className="about-easter-egg-player" role="dialog" aria-modal="true" aria-label="彩蛋视频：在人类消逝之后" tabIndex={-1}>
      <button type="button" className="about-easter-egg-close" aria-label="关闭彩蛋视频" onClick={onClose}>
        <IconClose size={20} />
      </button>
      <video
        ref={videoRef}
        src={VIDEO_URL}
        autoPlay
        controls
        playsInline
        tabIndex={0}
        aria-label="在人类消逝之后"
        onPlaying={() => setPlayBlocked(false)}
        onEnded={onClose}
        onError={() => setFailed(true)}
      />
      {failed ? (
        <p className="about-easter-egg-message" role="alert">视频暂时无法播放，请关闭后重试。</p>
      ) : playBlocked && (
        <button type="button" className="about-easter-egg-play" onClick={() => {
          void videoRef.current?.play().catch(() => setFailed(true))
        }}>播放视频</button>
      )}
    </div>
  )
}
