import { useSyncExternalStore } from 'react'

export interface DesktopPreferences {
  lowPerformance: boolean
  reduceMotion: boolean
}
const STORAGE_KEY = 'ra-desktop-accessibility'
const EVENT_NAME = 'ra-desktop-accessibility-change'
const DEFAULT_PREFERENCES: DesktopPreferences = { lowPerformance: false, reduceMotion: false }

export function normalizeDesktopPreferences(raw: unknown): DesktopPreferences {
  const candidate = raw && typeof raw === 'object' ? raw as Partial<DesktopPreferences> : {}
  return { lowPerformance: candidate.lowPerformance === true, reduceMotion: candidate.reduceMotion === true }
}

let cachedRaw: string | null = null
let cached = DEFAULT_PREFERENCES
function snapshot(): DesktopPreferences {
  if (typeof window === 'undefined') return DEFAULT_PREFERENCES
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (raw !== cachedRaw) {
      cachedRaw = raw
      try { cached = normalizeDesktopPreferences(raw ? JSON.parse(raw) : null) }
      catch { cached = DEFAULT_PREFERENCES }
    }
  } catch { return DEFAULT_PREFERENCES }
  return cached
}

function subscribe(callback: () => void): () => void {
  window.addEventListener(EVENT_NAME, callback)
  window.addEventListener('storage', callback)
  return () => {
    window.removeEventListener(EVENT_NAME, callback)
    window.removeEventListener('storage', callback)
  }
}

export function useDesktopPreferences(): DesktopPreferences {
  return useSyncExternalStore(subscribe, snapshot, () => DEFAULT_PREFERENCES)
}

/** Contains appearance preferences only; credential storage is never involved. */
export function updateDesktopPreferences(patch: Partial<DesktopPreferences>): string | null {
  try {
    const next = normalizeDesktopPreferences({ ...snapshot(), ...patch })
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
    window.dispatchEvent(new Event(EVENT_NAME))
    return null
  } catch {
    return '无法保存显示偏好，请检查本机存储是否可用'
  }
}
