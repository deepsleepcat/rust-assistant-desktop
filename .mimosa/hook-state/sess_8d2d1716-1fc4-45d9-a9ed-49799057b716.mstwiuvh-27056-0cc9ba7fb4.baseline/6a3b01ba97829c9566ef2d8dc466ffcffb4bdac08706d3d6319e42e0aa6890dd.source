import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'

// base: './' —— 让打包后的 index.html 用相对路径加载资源，
// 这样才能在 Electron 的 file:// 协议下正常工作。
export default defineConfig({
  base: './',
  plugins: [react(), devCspRelax()],
  server: {
    port: 5173,
    strictPort: true,
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
})

/**
 * L-4：开发模式放宽 CSP（仅删除 index.html 里的 CSP meta）。
 * vite 的 react-refresh 会注入 inline 脚本，严格 script-src 'self' 会拦掉它导致 HMR 失效；
 * 生产构建仍保留 index.html 里的严格 CSP（本插件 apply: 'serve' 只在开发服务器生效）。
 */
function devCspRelax(): Plugin {
  return {
    name: 'dev-csp-relax',
    apply: 'serve',
    transformIndexHtml(html) {
      // 匹配多行书写的 meta 标签（<meta\n      http-equiv="Content-Security-Policy".../>）
      return html.replace(/<meta\s+http-equiv="Content-Security-Policy"[\s\S]*?\/>/, '')
    },
  }
}
