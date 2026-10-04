import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    // .tsx 是组件测试（文件内用 `// @vitest-environment jsdom` 切到 DOM 环境）
    include: ['tests/**/*.test.{ts,tsx}'],
  },
})
