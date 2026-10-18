/**
 * 设置 → 背景：无/纯色/渐变/图片 + 模糊与透明度。
 * 从 SettingsModal 拆出（M39 巨型函数治理）；背景图预览状态与加载随本组件挂载/卸载。
 */
import { useEffect, useState } from 'react'
import { useWorkspaceStore } from '../../../stores/workspace'
import { getBridge } from '../../../services/bridge'
import { BackgroundImage, DEFAULT_IMAGE_CROP, type ImageCrop } from '../../../components/BackgroundImage'
import { Modal } from '../../../components/Modal'

const GRADIENT_PRESETS = [
  { name: '纸张', value: 'linear-gradient(135deg, #ffffff 0%, #f1f1f1 100%)' },
  { name: '雾灰', value: 'linear-gradient(135deg, #fafafa 0%, #e5e5e5 100%)' },
  { name: '墨色边缘', value: 'linear-gradient(135deg, #ffffff 0%, #eeeeee 70%, #d8d8d8 100%)' },
]

export function BackgroundSettingsTab() {
  const settings = useWorkspaceStore((s) => s.settings)
  const updateSettings = useWorkspaceStore((s) => s.updateSettings)
  const bg = settings.background
  const [cropDraft, setCropDraft] = useState<{ path: string; url: string; crop: ImageCrop } | null>(null)
  const [imageError, setImageError] = useState<string | null>(null)
  const [ratio, setRatio] = useState(() => window.innerWidth / window.innerHeight)
  useEffect(() => { const resize = () => setRatio(window.innerWidth / window.innerHeight); window.addEventListener('resize', resize); return () => window.removeEventListener('resize', resize) }, [])
  const [image, setImage] = useState<{ path: string; url: string | null }>({ path: '', url: null })

  useEffect(() => {
    if (bg.kind !== 'image' || !bg.imagePath) return
    let alive = true
    getBridge()
      .project.readImageAsDataUrl('', bg.imagePath)
      .then((url) => alive && setImage({ path: bg.imagePath ?? '', url }))
      .catch(() => alive && setImage({ path: bg.imagePath ?? '', url: null }))
    return () => {
      alive = false
    }
  }, [bg.kind, bg.imagePath])

  const imageUrl = image.path === bg.imagePath ? image.url : null

  const pickImage = async () => {
    setImageError(null)
    try {
      const picked = await getBridge().project.openImageDialog()
      if (!picked) return
      const url = await getBridge().project.readImageAsDataUrl('', picked)
      setCropDraft({ path: picked, url, crop: { ...DEFAULT_IMAGE_CROP } })
    } catch (err) { setImageError(err instanceof Error ? err.message : String(err)) }
  }

  const previewStyle: React.CSSProperties = {
    opacity: bg.opacity / 100,
    filter: bg.blur > 0 ? `blur(${bg.blur}px)` : undefined,
  }
  if (bg.kind === 'color') previewStyle.backgroundColor = bg.color
  if (bg.kind === 'gradient') previewStyle.backgroundImage = bg.gradient

  return (
    <div className="setting-section">
      <div className="setting-title">背景</div>
      <div
        className="bg-preview"
        style={{
          ...previewStyle,
          position: 'relative',
          aspectRatio: ratio,
          width: '100%',
          overflow: 'hidden',
          border: '1px solid var(--divider)',
          backgroundSize: 'cover',
          backgroundPosition: 'center',
        }}
      >{bg.kind === 'image' && imageUrl && <BackgroundImage src={imageUrl} crop={bg.imageCrop} />}</div>
      {imageError && <p className="community-warning" role="alert">{imageError}</p>}
      {cropDraft && <Modal wide title="调整背景图片取景" onClose={() => setCropDraft(null)} footer={<><button className="btn" onClick={() => setCropDraft(null)}>取消</button><button className="btn primary" onClick={() => { updateSettings({ background: { ...bg, kind: 'image', imagePath: cropDraft.path, imageCrop: cropDraft.crop } }); setCropDraft(null) }}>使用此取景</button></>}>
        <p className="local-note">拖动图片调整位置，缩放改变取景范围。原图片保持不变。</p>
        <div style={{ position: 'relative', width: '100%', aspectRatio: ratio, overflow: 'hidden', background: 'var(--surface-1)' }}><BackgroundImage src={cropDraft.url} crop={cropDraft.crop} onCrop={(crop) => setCropDraft((current) => current ? { ...current, crop } : null)} /></div>
        <label className="setting-row">缩放<input aria-label="图片缩放" type="range" min={1} max={4} step={0.01} value={cropDraft.crop.zoom} onChange={(event) => setCropDraft({ ...cropDraft, crop: { ...cropDraft.crop, zoom: Number(event.target.value) } })} /><span>{Math.round(cropDraft.crop.zoom * 100)}%</span></label>
        <label className="setting-row">水平位置<input aria-label="图片水平位置" type="range" min={0} max={100} value={cropDraft.crop.x} onChange={(event) => setCropDraft({ ...cropDraft, crop: { ...cropDraft.crop, x: Number(event.target.value) } })} /></label>
        <label className="setting-row">垂直位置<input aria-label="图片垂直位置" type="range" min={0} max={100} value={cropDraft.crop.y} onChange={(event) => setCropDraft({ ...cropDraft, crop: { ...cropDraft.crop, y: Number(event.target.value) } })} /></label>
        <button className="btn" onClick={() => setCropDraft({ ...cropDraft, crop: { ...DEFAULT_IMAGE_CROP } })}>重置取景</button>
      </Modal>}
      <div className="setting-row">
        <span className="label">
          背景类型
          <div className="desc">面板半透明，背景会透出来</div>
        </span>
        <div className="seg-group">
          <button className={bg.kind === 'none' ? 'active' : ''} onClick={() => updateSettings({ background: { ...bg, kind: 'none' } })}>
            无
          </button>
          <button className={bg.kind === 'color' ? 'active' : ''} onClick={() => updateSettings({ background: { ...bg, kind: 'color' } })}>
            纯色
          </button>
          <button className={bg.kind === 'gradient' ? 'active' : ''} onClick={() => updateSettings({ background: { ...bg, kind: 'gradient' } })}>
            渐变
          </button>
          <button className={bg.kind === 'image' ? 'active' : ''} onClick={() => updateSettings({ background: { ...bg, kind: 'image' } })}>
            图片
          </button>
        </div>
      </div>

      {bg.kind === 'color' && (
        <div className="setting-row">
          <span className="label">颜色</span>
          <input
            type="color"
            value={bg.color}
            onChange={(e) => updateSettings({ background: { ...bg, color: e.target.value } })}
          />
          <code style={{ color: 'var(--text-2)', fontSize: 12 }}>{bg.color}</code>
        </div>
      )}

      {bg.kind === 'gradient' && (
        <div className="setting-row" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 8 }}>
          <span className="label">
            预设渐变
            <div className="desc">选择一款黑白灰阶渐变</div>
          </span>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(110px, 1fr))', gap: 8 }}>
            {GRADIENT_PRESETS.map((g) => (
              <button
                key={g.name}
                onClick={() => updateSettings({ background: { ...bg, gradient: g.value } })}
                style={{
                  height: 46,
                  borderRadius: 'var(--radius-sm)',
                  border: '1px solid var(--border)',
                  backgroundImage: g.value,
                  cursor: 'pointer',
                  position: 'relative',
                  overflow: 'hidden',
                  display: 'grid',
                  placeItems: 'center',
                  color: 'rgba(0,0,0,0.55)',
                  fontSize: 12,
                  fontWeight: 500,
                }}
                title={g.name}
              >
                {g.name}
              </button>
            ))}
          </div>
        </div>
      )}

      {bg.kind === 'image' && (
        <div className="setting-row">
          <span className="label">
            背景图片
            <div className="desc">选择本地图片作为编辑器背景</div>
          </span>
          <button className="btn" onClick={() => void pickImage()}>
            选择图片…
          </button>
          {imageUrl && bg.imagePath && <button className="btn" onClick={() => setCropDraft({ path: bg.imagePath!, url: imageUrl, crop: bg.imageCrop ?? { ...DEFAULT_IMAGE_CROP } })}>调整取景</button>}
        </div>
      )}

      {bg.kind !== 'none' && bg.kind !== 'color' && (
        <div className="setting-row">
          <span className="label">
            模糊
            <div className="desc">背景柔化程度</div>
          </span>
          <input
            type="range"
            min={0}
            max={40}
            value={bg.blur}
            onChange={(e) => updateSettings({ background: { ...bg, blur: Number(e.target.value) } })}
          />
          <span style={{ width: 34, textAlign: 'right', fontSize: 12, color: 'var(--text-2)' }}>{bg.blur}px</span>
        </div>
      )}

      {bg.kind !== 'none' && (
        <div className="setting-row">
          <span className="label">
            透明度
            <div className="desc">背景层的可见程度</div>
          </span>
          <input
            type="range"
            min={0}
            max={100}
            value={bg.opacity}
            onChange={(e) => updateSettings({ background: { ...bg, opacity: Number(e.target.value) } })}
          />
          <span style={{ width: 34, textAlign: 'right', fontSize: 12, color: 'var(--text-2)' }}>{bg.opacity}%</span>
        </div>
      )}
    </div>
  )
}
