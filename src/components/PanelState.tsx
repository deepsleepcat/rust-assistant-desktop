/**
 * M29 统一状态块：加载 / 空 / 错误。
 * 此前项目、单位库、资源扫描等处把「加载中」「空数据」「读取失败」混为一种，
 * 这里提供一致的视觉与「重试」入口；错误必须能重试，不再静默吞掉。
 */
import type { ReactNode } from 'react'
import { AppIcon } from './AppIcon'

export interface PanelStateProps {
  kind: 'loading' | 'empty' | 'error'
  title?: string
  description?: ReactNode
  /** 空状态图标（默认 folder） */
  icon?: 'folder' | 'file' | 'tools' | 'image' | 'warn' | 'search'
  /** 主操作按钮（如「打开项目」） */
  action?: ReactNode
  /** 错误重试 */
  onRetry?: () => void
  retryLabel?: string
}

export function PanelState({ kind, title, description, icon = 'folder', action, onRetry, retryLabel = '重试' }: PanelStateProps) {
  if (kind === 'loading') {
    return (
      <div className="panel-state" role="status" aria-live="polite">
        <span className="panel-state-spinner" aria-hidden="true" />
        <span className="panel-state-title">{title ?? '加载中…'}</span>
      </div>
    )
  }
  return (
    <div className={`panel-state${kind === 'error' ? ' error' : ''}`}>
      <span className="panel-state-icon">
        <AppIcon name={kind === 'error' ? 'warn' : icon} size={26} />
      </span>
      {title && <span className="panel-state-title">{title}</span>}
      {description && <span className="panel-state-desc">{description}</span>}
      {(action || onRetry) && (
        <span className="panel-state-actions">
          {action}
          {onRetry && (
            <button className="btn" onClick={onRetry}>
              {retryLabel}
            </button>
          )}
        </span>
      )}
    </div>
  )
}
