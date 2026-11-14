import { AppIcon } from '../../components/AppIcon'
import { LogoR } from '../../components/LogoR'
import { runGameAction } from '../../components/desktop/runGame'
import { DESKTOP_NAV_ITEMS } from '../../components/desktop/shellContract'
import { useWorkspaceStore } from '../../stores/workspace'

export function SurfaceNav() {
  const activeSurface = useWorkspaceStore((state) => state.activeSurface)
  const setActiveSurface = useWorkspaceStore((state) => state.setActiveSurface)

  return (
    <aside className="desktop-rail" aria-label="主导航">
      <div className="desktop-rail-brand" aria-label="铁锈工坊"><LogoR size="header" /></div>
      <nav className="desktop-rail-nav" aria-label="工作面">
        {DESKTOP_NAV_ITEMS.map((item) => {
          const active = activeSurface === item.id
          return (
            <button key={item.id} type="button" className={`desktop-rail-button${active ? ' active' : ''}`}
              aria-current={active ? 'page' : undefined} aria-label={`${item.label} ${item.en}`} title={`${item.label} ${item.en}`}
              onClick={() => {
                if (item.id === 'launchGame') void runGameAction()
                else setActiveSurface(item.id)
              }}>
              <AppIcon name={item.icon} size={18} />
              <span className="desktop-rail-tooltip" aria-hidden="true">
                <span>{item.label}</span>
                <small lang="en">{item.en}</small>
              </span>
            </button>
          )
        })}
      </nav>
    </aside>
  )
}
