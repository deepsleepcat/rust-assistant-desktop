import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import reactHooks from 'eslint-plugin-react-hooks'
import globals from 'globals'

export default tseslint.config(
  { ignores: ['dist/**', 'dist-electron/**', 'node_modules/**', 'coverage/**', 'vendor/**', 'promo/**', 'promo-v2/**', 'scripts/capture-promo.mjs'] },
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
