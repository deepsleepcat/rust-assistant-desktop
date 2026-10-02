/**
 * 铁锈助手手机版 · 应用外壳：
 * 主题（跟随系统/深浅色）+ 底部导航 5 Tab（项目 / 模板 / 检查 / AI / 设置）。
 * 编辑页为全屏模态（从项目进入），不占底部导航。
 */
import { useEffect } from "react";
import { useWorkspace, type MobileTab } from "./stores/workspace";
import { AppIcon, type AppIconName } from "./components/AppIcon";
import { ProjectsScreen } from "./screens/ProjectsScreen";
import { EditorScreen } from "./screens/EditorScreen";
import { LibraryScreen } from "./screens/LibraryScreen";
import { InspectScreen } from "./screens/InspectScreen";
import { AiScreen } from "./screens/AiScreen";
import { SettingsScreen } from "./screens/SettingsScreen";
import "./styles/tokens.css";
import "./styles/app.css";
import "./styles/components.css";
import "./styles/mobile.css";

interface TabDef {
  key: MobileTab
  label: string
  icon: AppIconName
}

const TABS: TabDef[] = [
  { key: "projects", label: "项目", icon: "folder" },
  { key: "library", label: "模板", icon: "tower" },
  { key: "inspect", label: "检查", icon: "check" },
  { key: "ai", label: "AI", icon: "sparkle" },
  { key: "settings", label: "设置", icon: "settings" },
]

function useTheme() {
  const settings = useWorkspace((s) => s.settings)
  useEffect(() => {
    const apply = () => {
      const dark =
        settings.theme === "dark" ||
        (settings.theme === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches)
      document.documentElement.dataset.theme = dark ? "dark" : "light"
    }
    apply()
    const mq = window.matchMedia("(prefers-color-scheme: dark)")
    mq.addEventListener("change", apply)
    return () => mq.removeEventListener("change", apply)
  }, [settings.theme])
}

function Splash() {
  return (
    <div className="m-splash">
      <AppIcon name="tower" size={44} />
      <p>铁锈助手 · 手机版</p>
    </div>
  )
}

function App() {
  useTheme()
  const ready = useWorkspace((s) => s.ready)
  const activeTab = useWorkspace((s) => s.activeTab)
  const setActiveTab = useWorkspace((s) => s.setActiveTab)
  const editorFile = useWorkspace((s) => s.editorFile)

  useEffect(() => {
    void useWorkspace.getState().init()
  }, [])

  if (!ready) return <Splash />

  // 编辑器全屏模态：不显示底部导航
  if (editorFile) return <EditorScreen />

  return (
    <div className="m-shell">
      <main className="m-content">
        {activeTab === "projects" && <ProjectsScreen />}
        {activeTab === "editor" && <EditorScreen />}
        {activeTab === "library" && <LibraryScreen />}
        {activeTab === "inspect" && <InspectScreen />}
        {activeTab === "ai" && <AiScreen />}
        {activeTab === "settings" && <SettingsScreen />}
      </main>
      <nav className="m-bottom-nav">
        {TABS.map((t) => (
          <button
            key={t.key}
            className={`m-nav-item${activeTab === t.key ? " active" : ""}`}
            onClick={() => setActiveTab(t.key)}
            aria-label={t.label}
          >
            <AppIcon name={t.icon} size={22} />
            <span>{t.label}</span>
          </button>
        ))}
      </nav>
    </div>
  )
}

export default App
