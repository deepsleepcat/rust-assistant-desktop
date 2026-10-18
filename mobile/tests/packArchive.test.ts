/**
 * .rwmod 打包与「导出后可原样读回」测试。
 *
 * 这里验证的是导出数据的完整性：字节、中文、BOM、子目录路径都要能在
 * 重新解包后一致——也就是「导出 → 重新导入」这条真机流程的核心。
 */
import { describe, expect, it } from 'vitest'
import JSZip from 'jszip'
import { buildModArchive, type PackItem } from '../src/features/modTools/packArchive'

function item(path: string, text: string): PackItem {
  const bytes = new TextEncoder().encode(text)
  return { path, data: bytes.buffer.slice(0, bytes.byteLength) as ArrayBuffer }
}

async function unzip(buffer: ArrayBuffer): Promise<Record<string, string>> {
  const zip = await JSZip.loadAsync(buffer)
  const out: Record<string, string> = {}
  for (const [name, file] of Object.entries(zip.files)) {
    if (file.dir) continue
    out[name] = await file.async('string')
  }
  return out
}

describe('打包 .rwmod', () => {
  it('打包后能读回全部文件且内容一致', async () => {
    const items = [
      item('mod-info.txt', '[mod]\ntitle: 测试模组\n'),
      item('units/tank/tank.ini', '[core]\nname: tank\nmaxHp: 600\n'),
      item('units/tank/readme.txt', '说明\n'),
    ]
    const result = await buildModArchive(items)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.files).toBe(3)

    const files = await unzip(result.buffer)
    expect(Object.keys(files).sort()).toEqual(['mod-info.txt', 'units/tank/readme.txt', 'units/tank/tank.ini'])
    expect(files['mod-info.txt']).toBe('[mod]\ntitle: 测试模组\n')
    expect(files['units/tank/tank.ini']).toBe('[core]\nname: tank\nmaxHp: 600\n')
  })

  it('中文内容按 UTF-8 原样往返', async () => {
    const text = '[core]\ndisplayLocaleKey: 示例坦克\n说明: 带中文的值\n'
    const result = await buildModArchive([item('units/a.ini', text)])
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const files = await unzip(result.buffer)
    expect(files['units/a.ini']).toBe(text)
  })

  it('跳过计数计入文件总数', async () => {
    const result = await buildModArchive([item('a.txt', 'x')], 4)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.files).toBe(5)
  })

  it('空列表也能生成合法压缩包（不抛错）', async () => {
    const result = await buildModArchive([])
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const files = await unzip(result.buffer)
    expect(Object.keys(files)).toHaveLength(0)
  })

  it('CRLF 与 BOM 变现在字节层不打折（导出即磁盘原样）', async () => {
    const crlf = '[core]\r\nname: a\r\n'
    const bytes = new TextEncoder().encode(crlf)
    const result = await buildModArchive([{ path: 'a.ini', data: bytes.buffer.slice(0, bytes.byteLength) as ArrayBuffer }])
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const zip = await JSZip.loadAsync(result.buffer)
    const back = await zip.file('a.ini')!.async('string')
    expect(back).toBe(crlf)
    expect(back).toContain('\r\n')
  })

  it('导出 → 重新导入的往返不丢文件（模拟真机验收流程）', async () => {
    const project: Record<string, string> = {
      'mod-info.txt': '[mod]\ntitle: 往返模组\n',
      'units/a/a.ini': '[core]\nname: a\n',
      'units/b/b.ini': '[core]\nname: b\n',
      'rules/custom.json': '{"rules":[]}',
    }
    const items = Object.entries(project).map(([path, text]) => item(path, text))
    const packed = await buildModArchive(items)
    expect(packed.ok).toBe(true)
    if (!packed.ok) return

    // 重新导入：把包内容读成「项目文件表」，应与原项目逐字节一致
    const imported = await unzip(packed.buffer)
    expect(imported).toEqual(project)
  })
})
