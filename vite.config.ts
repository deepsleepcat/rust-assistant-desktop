import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// base: './' —— 让打包后的 index.html 用相对路径加载资源，
// 这样才能在 Electron 的 file:// 协议下正常工作。
export default defineConfig({
  base: './',
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
})
