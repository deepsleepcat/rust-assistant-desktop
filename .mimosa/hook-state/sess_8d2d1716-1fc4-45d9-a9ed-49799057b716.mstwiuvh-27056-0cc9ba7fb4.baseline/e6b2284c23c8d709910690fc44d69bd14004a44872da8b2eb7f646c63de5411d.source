/**
 * M6 鼠标粒子特效：跟随鼠标的简约光点尾迹（Canvas 实现）。
 *
 * - 全屏透明层，pointer-events: none，不拦截任何交互
 * - 鼠标移动时产生少量微小光点，缓慢上浮并淡出
 * - prefers-reduced-motion 或窗口失焦时自动停用，节省性能
 * - 强度（intensity 1-3）控制每次生成的光点数量
 * - 颜色（color，hex）可自定义，默认黑
 */
import { useEffect, useRef } from 'react'

interface Particle {
  x: number
  y: number
  vx: number
  vy: number
  life: number
  maxLife: number
  size: number
}

/** hex 颜色（#RRGGBB）转 rgb 三元组；非法值回退白色 */
function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const m = /^#?([0-9a-fA-F]{6})$/.exec(hex.trim())
  if (!m) return { r: 255, g: 255, b: 255 }
  const n = Number.parseInt(m[1], 16)
  return { r: (n >> 16) & 0xff, g: (n >> 8) & 0xff, b: n & 0xff }
}

export function CursorEffect({ intensity = 1, color = '#000000' }: { intensity?: number; color?: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const particlesRef = useRef<Particle[]>([])
  const intensityRef = useRef(intensity)
  const colorRef = useRef(hexToRgb(color))
  // 强度/颜色变化时同步到 ref（渲染期间不写 ref，交给 effect）
  useEffect(() => {
    intensityRef.current = intensity
  }, [intensity])
  useEffect(() => {
    colorRef.current = hexToRgb(color)
  }, [color])

  useEffect(() => {
    // 减少动态效果偏好：直接不启动
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const dpr = window.devicePixelRatio || 1
    const resize = () => {
      canvas.width = window.innerWidth * dpr
      canvas.height = window.innerHeight * dpr
      canvas.style.width = `${window.innerWidth}px`
      canvas.style.height = `${window.innerHeight}px`
    }
    resize()
    window.addEventListener('resize', resize)

    let raf = 0
    let running = true
    const mouse = { x: -100, y: -100, lastX: -100, lastY: -100 }

    const onMove = (e: MouseEvent) => {
      mouse.x = e.clientX
      mouse.y = e.clientY
      // 只在实际移动时生成粒子（避免静止时堆积）
      const dist = Math.hypot(mouse.x - mouse.lastX, mouse.y - mouse.lastY)
      if (dist < 3) return
      mouse.lastX = mouse.x
      mouse.lastY = mouse.y
      const count = intensityRef.current
      for (let i = 0; i < count; i++) {
        particlesRef.current.push({
          x: mouse.x + (Math.random() - 0.5) * 10,
          y: mouse.y + (Math.random() - 0.5) * 10,
          vx: (Math.random() - 0.5) * 0.6,
          vy: -0.4 - Math.random() * 0.6,
          life: 0,
          maxLife: 40 + Math.random() * 30,
          size: 1 + Math.random() * 1.6,
        })
      }
      // 控制粒子总数，防止长时间挂机堆积
      if (particlesRef.current.length > 240) {
        particlesRef.current.splice(0, particlesRef.current.length - 240)
      }
    }
    const onLeave = () => {
      mouse.x = -100
      mouse.y = -100
      mouse.lastX = -100
      mouse.lastY = -100
    }

    window.addEventListener('mousemove', onMove)
    document.addEventListener('mouseleave', onLeave)

    const tick = () => {
      if (!running) return
      ctx.clearRect(0, 0, canvas.width, canvas.height)
      ctx.save()
      ctx.scale(dpr, dpr)
      const particles = particlesRef.current
      for (let i = particles.length - 1; i >= 0; i--) {
        const p = particles[i]
        p.life += 1
        p.x += p.vx
        p.y += p.vy
        if (p.life >= p.maxLife) {
          particles.splice(i, 1)
          continue
        }
        const alpha = 1 - p.life / p.maxLife
        const { r, g, b } = colorRef.current
        ctx.beginPath()
        ctx.arc(p.x, p.y, p.size * alpha, 0, Math.PI * 2)
        ctx.fillStyle = `rgba(${r},${g},${b},${(alpha * 0.55).toFixed(3)})`
        ctx.fill()
      }
      ctx.restore()
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)

    return () => {
      running = false
      cancelAnimationFrame(raf)
      window.removeEventListener('resize', resize)
      window.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseleave', onLeave)
      particlesRef.current = []
    }
  }, [])

  return <canvas ref={canvasRef} className="cursor-effect" aria-hidden="true" />
}
