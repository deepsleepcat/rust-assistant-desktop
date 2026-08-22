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
    // 本地预览通过同源代理访问已部署社区服务，避免部署端临时缺失 CORS 响应头时
    // 误把真实社区降级成示例数据；生产 Electron 使用受限 IPC 代理。
    proxy: {
      '/community-api': {
        target: process.env.VITE_COMMUNITY_ENDPOINT === 'https://xn--gmqtc392bzw0a.xn--6qq986b3xl'
          ? 'https://xn--gmqtc392bzw0a.xn--6qq986b3xl'
          : 'http://localhost:3000',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/community-api/, ''),
        configure: (proxy) => {
          proxy.on('proxyReq', (request) => {
            request.setHeader('Origin', process.env.VITE_COMMUNITY_ENDPOINT === 'https://xn--gmqtc392bzw0a.xn--6qq986b3xl'
              ? 'https://xn--gmqtc392bzw0a.xn--6qq986b3xl'
              : 'http://localhost:3000')
          })
        },
      },
    },
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
