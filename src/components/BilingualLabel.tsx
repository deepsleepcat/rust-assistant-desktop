/** Visible translation and original term; never used as saved content. */
export function BilingualLabel({ zh, en }: { zh: string; en: string }) {
  return <span style={{ display: 'inline-flex', flexDirection: 'column', alignItems: 'flex-start', lineHeight: 1.3, minWidth: 0 }}>
    <span>{zh}</span>
    <small lang="en" style={{ fontSize: '0.8em', color: 'var(--text-secondary)', overflowWrap: 'anywhere' }}>{en}</small>
  </span>
}
