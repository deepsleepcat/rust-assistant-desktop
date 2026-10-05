import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import reactHooks from 'eslint-plugin-react-hooks'
import globals from 'globals'

export default tseslint.config(
  { ignores: ['dist/**', 'dist-electron/**', 'node_modules/**', 'coverage/**', 'vendor/**', 'mobile/**', 'promo/**', 'promo-v2/**', 'scripts/capture-promo.mjs',
    // 会话/工具产物与本地验证脚本：不属于产品代码，不进提交，也不参与 lint
    '.zcode/**', '.claude/**', '.mimosa/**', '.playwright-mcp/**', '.code-review-graph/**',
    'probe-*.mjs', 'gui-test-screenshots/**', 'release/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.{ts,tsx}', 'electron/**/*.ts', 'tests/**/*.ts'],
    languageOptions: {
      ecmaVersion: 2022,
      globals: { ...globals.browser, ...globals.node },
    },
    plugins: { 'react-hooks': reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'warn',
      // Electron 渲染层不支持 window.prompt（被覆写为直接抛错），用它会让整条流程静默断掉：
      // 版本说明等输入一律走应用内弹窗。
      'no-restricted-properties': ['error', {
        object: 'window',
        property: 'prompt',
        message: 'Electron 不支持 window.prompt（会抛错）；请改用应用内输入弹窗。',
      }],
    },
  },
  {
    files: ['scripts/**/*.mjs', '.agents/**/*.mjs'],
    languageOptions: { globals: globals.node },
  },
  {
    // examples/ 是给用户复制的示例 DLC：独立的 CommonJS 小程序，不是本项目源码。
    // 仍然纳入 lint（防止示例随时间腐烂），但按 Node 脚本对待：
    // 给 node 全局、允许 require（.cjs 里 require 正是正确写法）。
    files: ['examples/**/*.{js,cjs,mjs}'],
    languageOptions: { ecmaVersion: 2022, sourceType: 'commonjs', globals: globals.node },
    rules: { '@typescript-eslint/no-require-imports': 'off' },
  },
)
