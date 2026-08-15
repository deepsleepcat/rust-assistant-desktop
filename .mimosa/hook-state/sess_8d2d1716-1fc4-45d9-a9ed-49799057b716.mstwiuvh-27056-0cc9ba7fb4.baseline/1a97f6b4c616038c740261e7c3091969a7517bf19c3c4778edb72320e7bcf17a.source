/**
 * 图标集合：手绘轻量 SVG（描边风格），颜色跟随 currentColor。
 * 文件类型图标使用「彩色圆角块 + 字母」方案，一眼可辨。
 */
import type { CSSProperties, ReactNode } from 'react'

interface IconProps {
  size?: number
  className?: string
  style?: CSSProperties
}

function Svg({ size = 16, className, style, children }: IconProps & { children: ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      style={style}
      aria-hidden="true"
    >
      {children}
    </svg>
  )
}

export const IconFolder = (p: IconProps) => (
  <Svg {...p}>
    <path d="M3 7a2 2 0 0 1 2-2h4l2 2.5h8a2 2 0 0 1 2 2V17a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z" />
  </Svg>
)

export const IconFolderOpen = (p: IconProps) => (
  <Svg {...p}>
    <path d="M3 8.5V7a2 2 0 0 1 2-2h4l2 2.5h6a2 2 0 0 1 2 2v1" />
    <path d="M3.5 9h13.2a1.5 1.5 0 0 1 1.45 1.9l-1.7 6.2a2 2 0 0 1-1.94 1.5H5.7a2 2 0 0 1-1.95-1.6L3.5 9z" />
  </Svg>
)

export const IconFile = (p: IconProps) => (
  <Svg {...p}>
    <path d="M6 3h8l4 4v14H6V3z" />
    <path d="M14 3v4h4" />
  </Svg>
)

export const IconPlus = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 5v14M5 12h14" />
  </Svg>
)

export const IconRefresh = (p: IconProps) => (
  <Svg {...p}>
    <path d="M20 12a8 8 0 1 1-2.34-5.66" />
    <path d="M20 3v4h-4" />
  </Svg>
)

export const IconClose = (p: IconProps) => (
  <Svg {...p}>
    <path d="M6 6l12 12M18 6L6 18" />
  </Svg>
)

export const IconSearch = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="11" cy="11" r="7" />
    <path d="M21 21l-4.3-4.3" />
  </Svg>
)

export const IconGear = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="3.2" />
    <path d="M12 2.8v3M12 18.2v3M2.8 12h3M18.2 12h3M5.5 5.5l2.1 2.1M16.4 16.4l2.1 2.1M18.5 5.5l-2.1 2.1M7.6 16.4l-2.1 2.1" />
  </Svg>
)

export const IconChat = (p: IconProps) => (
  <Svg {...p}>
    <path d="M21 12a8 8 0 0 1-8 8H4l2.3-2.9A8 8 0 1 1 21 12z" />
    <path d="M8.5 10.5h7M8.5 13.8h4.5" />
  </Svg>
)

export const IconSend = (p: IconProps) => (
  <Svg {...p}>
    <path d="M21 3L10.5 13.5" />
    <path d="M21 3l-7 18-3.5-7.5L3 10l18-7z" />
  </Svg>
)

export const IconTrash = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 7h16M9 7V5h6v2M6.5 7l.8 13h9.4l.8-13" />
    <path d="M10 11v5M14 11v5" />
  </Svg>
)

export const IconArchive = (p: IconProps) => (
  <Svg {...p}>
    <rect x="3" y="4" width="18" height="5" rx="1" />
    <path d="M5 9v10h14V9" />
    <path d="M10 13h4" />
  </Svg>
)

export const IconRename = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 20h9" />
    <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z" />
  </Svg>
)

export const IconFilePlus = (p: IconProps) => (
  <Svg {...p}>
    <path d="M6 3h8l4 4v14H6V3z" />
    <path d="M14 3v4h4" />
    <path d="M12 12v6M9 15h6" />
  </Svg>
)

export const IconFolderPlus = (p: IconProps) => (
  <Svg {...p}>
    <path d="M3 7a2 2 0 0 1 2-2h4l2 2.5h8a2 2 0 0 1 2 2V17a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z" />
    <path d="M12 11v6M9 14h6" />
  </Svg>
)

export const IconChevronRight = (p: IconProps) => (
  <Svg {...p}>
    <path d="M9 6l6 6-6 6" />
  </Svg>
)

export const IconSun = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="4.5" />
    <path d="M12 2.5v2.5M12 19v2.5M2.5 12H5M19 12h2.5M5 5l1.8 1.8M17.2 17.2L19 19M19 5l-1.8 1.8M6.8 17.2L5 19" />
  </Svg>
)

export const IconMoon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M20 13.5A8 8 0 1 1 10.5 4a6.5 6.5 0 0 0 9.5 9.5z" />
  </Svg>
)

export const IconCheck = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4.5 12.5l5 5L19.5 7" />
  </Svg>
)

export const IconImage = (p: IconProps) => (
  <Svg {...p}>
    <rect x="3.5" y="4.5" width="17" height="15" rx="2" />
    <circle cx="9" cy="10" r="1.6" />
    <path d="M4 17.5l5-4.5 3.5 3 3.5-3.5 4 3.5" />
  </Svg>
)

export const IconPalette = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 3a9 9 0 1 0 0 18h1.2a1.8 1.8 0 0 0 1.3-3 1.8 1.8 0 0 1 1.3-3H18a3 3 0 0 0 3-3c0-5-4-9-9-9z" />
    <circle cx="7.5" cy="10" r="0.6" fill="currentColor" />
    <circle cx="10.5" cy="7" r="0.6" fill="currentColor" />
    <circle cx="14.5" cy="7" r="0.6" fill="currentColor" />
    <circle cx="17" cy="10" r="0.6" fill="currentColor" />
  </Svg>
)

export const IconLayout = (p: IconProps) => (
  <Svg {...p}>
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <path d="M3 9h18M9 9v11" />
  </Svg>
)

export const IconType = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 6.5h16M9 6.5V18M15 6.5V18M7.5 18h3M13.5 18h3" />
  </Svg>
)

export const IconProject = (p: IconProps) => (
  <Svg {...p}>
    <rect x="3" y="3.5" width="18" height="17" rx="2" />
    <path d="M3 9h18" />
    <path d="M7 6.2h.01M10 6.2h.01" />
  </Svg>
)

export const IconSparkle = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9L12 3z" />
    <path d="M19 15l.9 2.1L22 18l-2.1.9L19 21l-.9-2.1L16 18l2.1-.9L19 15z" />
  </Svg>
)

/* —— 文件类型图标：彩色圆角块 + 字母 —— */
const FILE_STYLES: Record<string, { bg: string; glyph: string }> = {
  '.json': { bg: '#222', glyph: '{ }' },
  '.txt': { bg: '#555', glyph: 'T' },
  '.ini': { bg: '#444', glyph: 'i' },
  '.cfg': { bg: '#333', glyph: 'C' },
  '.conf': { bg: '#333', glyph: 'C' },
  '.md': { bg: '#666', glyph: 'M' },
  '.lua': { bg: '#444', glyph: 'L' },
  '.png': { bg: '#555', glyph: '▨' },
  '.jpg': { bg: '#555', glyph: '▨' },
  '.jpeg': { bg: '#555', glyph: '▨' },
  '.webp': { bg: '#555', glyph: '▨' },
  '.ogg': { bg: '#444', glyph: '♪' },
  '.mp3': { bg: '#444', glyph: '♪' },
  '.wav': { bg: '#444', glyph: '♪' },
}

export function FileTypeIcon({ name, size = 16 }: { name: string; size?: number }) {
  const lower = name.toLowerCase()
  const ext = lower.includes('.') ? lower.slice(lower.lastIndexOf('.')) : ''
  const style = FILE_STYLES[ext]
  if (!style) {
    return (
      <span
        style={{
          width: size,
          height: size,
          borderRadius: 4,
          display: 'inline-grid',
          placeItems: 'center',
          background: '#777',
          color: '#fff',
          fontSize: size * 0.62,
          fontWeight: 700,
          fontFamily: 'var(--font-mono)',
          flexShrink: 0,
        }}
      >
        ·
      </span>
    )
  }
  return (
    <span
      style={{
        width: size,
        height: size,
        borderRadius: 4,
        display: 'inline-grid',
        placeItems: 'center',
        background: style.bg,
        color: '#fff',
        fontSize: size * 0.58,
        fontWeight: 700,
        fontFamily: 'var(--font-mono)',
        flexShrink: 0,
      }}
    >
      {style.glyph}
    </span>
  )
}

export function FolderIcon({ size = 16, open = false }: { size?: number; open?: boolean }) {
  return (
    <span
      style={{
        width: size,
        height: size,
        borderRadius: 4,
        display: 'inline-grid',
        placeItems: 'center',
        background: open ? '#333333' : '#777777',
        color: '#fff',
        fontSize: size * 0.55,
        fontWeight: 700,
        flexShrink: 0,
      }}
    >
      {open ? '▾' : '▸'}
    </span>
  )
}
