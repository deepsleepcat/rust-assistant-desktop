/** 透明、非正方形的品牌 R 标记。Logo 是品牌，不使用功能图标库替代。 */
export function LogoR({ size = 'header' }: { size?: 'header' | 'welcome' | 'about' }) {
  const dimensions = size === 'welcome' ? { width: 50, height: 34 } : size === 'about' ? { width: 58, height: 38 } : { width: 28, height: 20 }
  return (
    <svg
      viewBox="0 0 42 28"
      width={dimensions.width}
      height={dimensions.height}
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      role="img"
      aria-label="铁锈工坊 R Logo"
      style={{ display: 'block', flexShrink: 0 }}
    >
      <path
        d="M7 23V5h8.7c4.6 0 7.3 2.2 7.3 6 0 2.7-1.4 4.6-3.8 5.5L24 23h-4.8l-4.1-5.8h-3.6V23H7Zm4.5-9.5h3.7c2.1 0 3.3-.8 3.3-2.5s-1.2-2.5-3.3-2.5h-3.7v5Z"
        fill="currentColor"
      />
          </svg>
  )
}
