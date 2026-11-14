/**
 * 炮塔编辑器预览的「自动裁切放大」：把 DLC 帧按不透明像素的实际包围盒放大到画布 92%。
 *
 * 背景：引擎按单位声明的画布包围盒取景（例如模组单位 200×200 贴图里实体只占中间一小块，
 * 但 scaleImagesTo 让包围盒变成 90×90），直接显示会让单位在预览里非常小。这里不改 DLC
 * 渲染结果，只在宿主显示层做一次「裁到内容再放大」的变换；拖动炮塔期间冻结该变换，
 * 避免每帧重算导致手柄抖动。
 */
export interface FrameView {
  /** 帧像素 → 画布像素的缩放 */
  scale: number
  offsetX: number
  offsetY: number
}

export interface FrameViewSource {
  size: { width: number; height: number }
  pixels: Uint8Array | number[]
}

/** 计算显示变换；整帧全透明时返回 null（不放大，保持原样） */
export function computeFrameView(target: FrameViewSource): FrameView | null {
  const { width, height } = target.size
  const pixels = target.pixels
  if (width <= 0 || height <= 0 || pixels.length !== width * height * 4) return null
  let minX = width
  let minY = height
  let maxX = -1
  let maxY = -1
  for (let y = 0; y < height; y++) {
    const row = y * width * 4
    for (let x = 0; x < width; x++) {
      if (pixels[row + x * 4 + 3] !== 0) {
        if (x < minX) minX = x
        if (x > maxX) maxX = x
        if (y < minY) minY = y
        if (y > maxY) maxY = y
      }
    }
  }
  if (maxX < minX || maxY < minY) return null
  const contentWidth = maxX - minX + 1
  const contentHeight = maxY - minY + 1
  // 上限 12 倍：极小内容（如 1px 锚点）不至于被放大到失真
  const scale = Math.min((width * 0.92) / contentWidth, (height * 0.92) / contentHeight, 12)
  return {
    scale,
    offsetX: (width - contentWidth * scale) / 2 - minX * scale,
    offsetY: (height - contentHeight * scale) / 2 - minY * scale,
  }
}
