/**
 * 头像裁切弹窗（M8）：
 * - 用户选择的原图 + 圆形裁切框（头像惯例），可拖拽框选区域、缩放图片；
 * - 确认后用 canvas 输出固定尺寸（256×256）的 PNG，交给主进程落盘；
 * - 黑白专业主题，支持 ESC / 遮罩点击关闭。
 */
import { useState } from 'react'
import Cropper from 'react-easy-crop'
import type { Area } from 'react-easy-crop'
import { useEscapeHandler } from '../../utils/modalStack'

interface AvatarCropModalProps {
  /** 原图 data URL（已通过安全校验读取） */
  imageSrc: string
  onCancel: () => void
  /** 确认：传出裁剪后的 PNG data URL */
  onConfirm: (croppedDataUrl: string) => void
}

/** 按裁剪区域把原图绘制到 canvas，输出固定 256×256 的 PNG data URL（纯函数，便于测试） */
export async function cropImageToDataUrl(imageSrc: string, crop: Area, outputSize = 256): Promise<string> {
  const img = new Image()
  img.src = imageSrc
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve()
    img.onerror = () => reject(new Error('图片加载失败'))
  })
  const canvas = document.createElement('canvas')
  canvas.width = outputSize
  canvas.height = outputSize
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('无法创建画布')
  ctx.drawImage(img, crop.x, crop.y, crop.width, crop.height, 0, 0, outputSize, outputSize)
  return canvas.toDataURL('image/png')
}

export function AvatarCropModal({ imageSrc, onCancel, onConfirm }: AvatarCropModalProps) {
  const [crop, setCrop] = useState({ x: 0, y: 0 })
  const [zoom, setZoom] = useState(1)
  const [croppedArea, setCroppedArea] = useState<Area | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // 全局弹窗栈：裁切层打开时它在最上层，Escape 只关本层（设置窗口在下层不动）。
  // saving 期间不关闭（避免「保存中」ESC 把设置弹窗连带关掉）；回调经 ref 读最新值，注册稳定
  useEscapeHandler(() => { if (!saving) onCancel() })

  const confirm = async () => {
    if (!croppedArea) return
    // 防护：裁切区域必须为正的有限值（图片加载失败/容器 0 尺寸时可能得到 0/NaN）
    if (!(croppedArea.width > 0) || !(croppedArea.height > 0) || !Number.isFinite(croppedArea.x + croppedArea.y + croppedArea.width + croppedArea.height)) {
      setError('无法确定裁切区域，请重试')
      return
    }
    setSaving(true)
    setError(null)
    try {
      const dataUrl = await cropImageToDataUrl(imageSrc, croppedArea)
      onConfirm(dataUrl)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setSaving(false)
    }
  }

  return (
    <div className="modal-overlay" onClick={() => !saving && onCancel()}>
      <div className="modal-card avatar-crop-card" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">裁剪头像</div>
        <div className="modal-body avatar-crop-body">
          <p className="mod-tip">拖动图片选择喜欢的部分，下方滑块可缩放。头像将保存为正方形（256×256）。</p>
          <div className="avatar-crop-stage">
            <Cropper
              image={imageSrc}
              crop={crop}
              zoom={zoom}
              aspect={1}
              cropShape="round"
              showGrid={false}
              maxZoom={4}
              onCropChange={setCrop}
              onZoomChange={setZoom}
              onCropComplete={(_area, areaPixels) => setCroppedArea(areaPixels)}
            />
          </div>
          <div className="avatar-crop-zoom">
            <span>缩放</span>
            <input
              type="range"
              min={1}
              max={4}
              step={0.01}
              value={zoom}
              onChange={(e) => setZoom(Number(e.target.value))}
              aria-label="缩放"
            />
            <span className="avatar-crop-zoom-value">{zoom.toFixed(2)}x</span>
          </div>
          {error && <p className="mod-check-error" style={{ color: 'var(--danger, #c5221f)', fontSize: 12 }}>{error}</p>}
        </div>
        <div className="modal-footer">
          <button className="btn" onClick={onCancel} disabled={saving}>取消</button>
          <button className="btn primary" onClick={() => void confirm()} disabled={saving || !croppedArea}>
            {saving ? '保存中…' : '确认使用'}
          </button>
        </div>
      </div>
    </div>
  )
}
