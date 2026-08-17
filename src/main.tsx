import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import './styles/tokens.css'
import './styles/app.css'
import './styles/m3-visual.css'
import './styles/m3-finish.css'
import './styles/components.css'
import './styles/layout.css'
import './styles/community.css'
import './styles/animations.css'

// 首帧前同步应用上次的主题（读 localStorage 缓存；设置数据随后经 IPC 异步加载，
// App 的 useEffect 会按真实设置再校正一次，幂等）——避免深色用户启动时白屏闪烁。
// 注意：CSP 禁止内联脚本，只能放在模块入口顶部同步执行。
try {
  const cached = localStorage.getItem('ra-theme')
  const dark =
    cached === 'dark' ||
    (cached === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches)
  document.documentElement.dataset.theme = dark ? 'dark' : 'light'
} catch {
  // 存储不可用（隐私模式等）：保持默认浅色，不阻塞应用启动
}

const rootEl = document.getElementById('root')
if (!rootEl) throw new Error('找不到 #root 挂载点')

createRoot(rootEl).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
