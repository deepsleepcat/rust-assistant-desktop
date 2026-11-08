// @vitest-environment jsdom
/**
 * 文件树面板交互回归：
 * 重命名「已展开的目录」后，新目录必须保持展开（子文件仍可见），
 * 且不能按旧路径重载。旧实现只重载 expanded 里的旧路径，改名后的目录
 * 会折叠、里面的文件从界面上消失。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createMemoryBridge, type MemoryBridgeHandle } from './fixtures/memoryBridge'
import { FileTreePanel } from '../src/features/editor/FileTreePanel'

const hoisted = vi.hoisted(() => ({ handle: null as MemoryBridgeHandle | null }))

vi.mock('../src/services/bridge', () => ({
  getBridge: () => hoisted.handle!.bridge,
}))

const ROOT = '/app/projects/demo'
const UNIT = `${ROOT}/units/a.ini`

beforeEach(() => {
  hoisted.handle = createMemoryBridge({
    files: {
      [UNIT]: '[core]\nname: a\n',
      [`${ROOT}/mod-info.txt`]: '[mod]\ntitle: 示例\n',
    },
  })
})

afterEach(cleanup)

describe('FileTreePanel 目录重命名', () => {
  it('重命名已展开目录后保持展开，子文件仍可见', async () => {
    render(
      <FileTreePanel
        projectRoot={ROOT}
        showHidden={false}
        refreshToken={0}
        onOpenText={() => {}}
        onOpenAsset={() => {}}
      />,
    )

    // 展开 units 目录
    fireEvent.click(await screen.findByText('units'))
    await screen.findByText('a.ini')

    // 更多操作 → 重命名
    fireEvent.click(screen.getByLabelText('units 的更多操作'))
    fireEvent.click(await screen.findByText('重命名'))

    const input = await screen.findByRole('textbox')
    fireEvent.change(input, { target: { value: 'units2' } })
    fireEvent.click(screen.getByRole('button', { name: '重命名' }))

    await waitFor(() => expect(hoisted.handle!.has(`${ROOT}/units2/a.ini`)).toBe(true))
    // 修复前：重载用的是旧路径 expanded，units2 折叠、a.ini 消失
    await screen.findByText('units2')
    await screen.findByText('a.ini')
  })
})
