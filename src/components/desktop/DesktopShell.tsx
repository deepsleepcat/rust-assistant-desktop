import type { ReactNode } from 'react'
import { SurfaceNav } from '../../features/workspace/SurfaceNav'

interface DesktopShellProps {
  children: ReactNode
}

/** Shared chrome frame for every desktop work surface. */
export function DesktopShell({ children }: DesktopShellProps) {
  return (
    <div className="desktop-shell">
      <SurfaceNav />
      <div className="desktop-shell-main">{children}</div>
    </div>
  )
}
