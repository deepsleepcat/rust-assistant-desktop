/**
 * 局部补丁编辑（M27-1）纯函数测试：unified diff 解析（格式/行数校验）+
 * 应用（全量校验先于修改、从后往前应用、上下文行不信任 AI、换行风格保持）。
 */
import { describe, expect, it } from 'vitest'
import { applyUnifiedDiff, parseUnifiedDiff, MAX_DIFF_BYTES, MAX_HUNKS } from '../electron/applyDiff'

describe('parseUnifiedDiff', () => {
  it('解析标准格式（含行数）', () => {
    const hunks = parseUnifiedDiff('@@ -1,2 +1,2 @@\n a\n-b\n+c\n')
    expect(hunks).toHaveLength(1)
    expect(hunks[0]).toMatchObject({ oldStart: 1, oldCount: 2, newStart: 1, newCount: 2 })
    expect(hunks[0].lines).toEqual([
      { type: 'ctx', text: 'a' },
      { type: 'del', text: 'b' },
      { type: 'add', text: 'c' },
    ])
  })

  it('无行数时按 1 处理（@@ -5 +5 @@）', () => {
    const hunks = parseUnifiedDiff('@@ -5 +5 @@\n-x\n+y\n')
    expect(hunks[0]).toMatchObject({ oldStart: 5, oldCount: 1, newStart: 5, newCount: 1 })
  })

  it('多个 hunk 顺序保留；\\ No newline 标记忽略；\r\n 兼容', () => {
    const hunks = parseUnifiedDiff('@@ -1,1 +1,1 @@\r\n-a\r\n+a\r\n\\ No newline at end of file\r\n@@ -9,1 +9,1 @@\r\n-b\r\n+b\r\n')
    expect(hunks).toHaveLength(2)
    expect(hunks[1].lines.map((l) => l.type)).toEqual(['del', 'add'])
  })

  it('hunk 头之前允许空行（模型输出常见），但拒绝无头内容行', () => {
    expect(parseUnifiedDiff('\n\n@@ -1,1 +1,1 @@\n-a\n+b\n')).toHaveLength(1)
    expect(() => parseUnifiedDiff('random line\n@@ -1,1 +1,1 @@\n-a\n+b\n')).toThrow(/缺少 @@ hunk 头/)
  })

  it('拒绝：无 hunk 头、空 diff、非法前缀', () => {
    expect(() => parseUnifiedDiff('--- a/x\n+++ b/x\n')).toThrow(/缺少 @@ hunk 头/)
    expect(() => parseUnifiedDiff('')).toThrow(/内容为空/)
    expect(() => parseUnifiedDiff('@@ -1,1 +1,1 @@\n|bad\n')).toThrow(/前缀非法/)
  })

  it('拒绝：声明行数与实际行数不符（严格校验，防行号错位）', () => {
    expect(() => parseUnifiedDiff('@@ -1,3 +1,3 @@\n a\n-b\n')).toThrow(/行数不符/)
    expect(() => parseUnifiedDiff('@@ -1,2 +1,3 @@\n a\n-b\n+c\n')).toThrow(/行数不符/)
  })

  it('拒绝：超大 diff（>1MB）', () => {
    const big = '@@ -1,2 +1,2 @@\n a\n-b\n+c\n' + ' x'.repeat(MAX_DIFF_BYTES)
    expect(() => parseUnifiedDiff(big)).toThrow(/过大/)
  })
})

describe('applyUnifiedDiff', () => {
  const old = ['[core]', 'name = "a"', 'maxHp = 100', '', '[attack]', 'range = 50', ''].join('\n')

  it('替换一行（上下文行保留原样）', () => {
    const hunks = parseUnifiedDiff('@@ -3,3 +3,3 @@\n maxHp = 100\n-\n+damage = 20\n [attack]\n')
    const r = applyUnifiedDiff(old, hunks)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.text).toBe(['[core]', 'name = "a"', 'maxHp = 100', 'damage = 20', '[attack]', 'range = 50', ''].join('\n'))
    }
  })

  it('删除行 + 新增行组合', () => {
    const hunks = parseUnifiedDiff('@@ -2,2 +2,1 @@\n name = "a"\n-maxHp = 100\n')
    const r = applyUnifiedDiff(old, hunks)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.text.split('\n')).not.toContain('maxHp = 100')
  })

  it('文件末尾追加（oldCount=0，在末行之前插入）', () => {
    const hunks = parseUnifiedDiff('@@ -7,0 +7,1 @@\n+[extra]\n')
    const r = applyUnifiedDiff(old, hunks)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.text).toContain('range = 50\n[extra]\n')
    }
  })

  it('多 hunk 从后往前应用（前面的行号不受后面修改影响）', () => {
    const hunks = parseUnifiedDiff('@@ -1,1 +1,1 @@\n-[core]\n+[root]\n@@ -6,1 +6,1 @@\n-range = 50\n+range = 99\n')
    const r = applyUnifiedDiff(old, hunks)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.text).toContain('[root]')
      expect(r.text).toContain('range = 99')
    }
  })

  it('ctx 行参与匹配校验：AI 伪造的上下文行与文件不符 → 拒绝（防错位误改）', () => {
    const hunks = parseUnifiedDiff('@@ -2,2 +2,1 @@\n name = "被篡改"\n-maxHp = 100\n')
    const r = applyUnifiedDiff(old, hunks)
    expect(r.ok).toBe(false)
  })

  it('上下文不匹配 → 整体失败且文件文本不变（原子性）', () => {
    const hunks = parseUnifiedDiff('@@ -1,3 +1,3 @@\n xxxx\n name = "a"\n maxHp = 100\n')
    const r = applyUnifiedDiff(old, hunks)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('上下文不匹配')
  })

  it('行号越界 → 整体失败并提示文件行数', () => {
    const hunks = parseUnifiedDiff('@@ -999,1 +999,1 @@\n-x\n+y\n')
    const r = applyUnifiedDiff(old, hunks)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('超出文件范围')
  })

  it('\r\n 换行风格保持；尾换行保持/去除一致', () => {
    const crlf = '[core]\r\nname = "a"\r\nmaxHp = 100\r\n'
    const hunks = parseUnifiedDiff('@@ -2,2 +2,2 @@\n name = "a"\n-maxHp = 100\n+damage = 5\n')
    const r = applyUnifiedDiff(crlf, hunks)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.text).toBe('[core]\r\nname = "a"\r\ndamage = 5\r\n')
    }
    const noTrailing = '[core]\nname = "a"'
    const r2 = applyUnifiedDiff(noTrailing, parseUnifiedDiff('@@ -2,1 +2,1 @@\n-name = "a"\n+name = "b"\n'))
    expect(r2.ok).toBe(true)
    if (r2.ok) expect(r2.text.endsWith('\n')).toBe(false)
  })

  it('空 hunks 拒绝', () => {
    const r = applyUnifiedDiff(old, [])
    expect(r.ok).toBe(false)
  })

  it('重叠 hunk 拒绝（LLM 可能生成区间覆盖的 diff，静默应用会损坏文件）', () => {
    // 前 hunk 覆盖 2-3 行，后 hunk 覆盖 3-4 行：区间重叠
    const hunks = parseUnifiedDiff('@@ -2,2 +2,2 @@\n name = "a"\n-maxHp = 100\n+maxHp = 1\n@@ -3,2 +3,2 @@\n maxHp = 1\n-[attack]\n+[weapon]\n')
    const r = applyUnifiedDiff(old, hunks)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('重叠')
  })

  it('相邻但不重叠的 hunk 正常应用', () => {
    const hunks = parseUnifiedDiff('@@ -2,1 +2,1 @@\n-name = "a"\n+name = "b"\n@@ -5,1 +5,1 @@\n-[attack]\n+[weapon]\n')
    const r = applyUnifiedDiff(old, hunks)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.text).toContain('name = "b"')
      expect(r.text).toContain('[weapon]')
    }
  })

  it('紧邻边界（一个结束于 N、另一个开始于 N）不误判重叠', () => {
    const hunks = parseUnifiedDiff('@@ -2,1 +2,1 @@\n-name = "a"\n+name = "b"\n@@ -3,1 +3,1 @@\n-maxHp = 100\n+maxHp = 200\n')
    const r = applyUnifiedDiff(old, hunks)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.text).toContain('name = "b"')
      expect(r.text).toContain('maxHp = 200')
    }
  })

  it('非升序 hunk 顺序：按行号排序后应用，不静默损坏文件', () => {
    // LLM 可能按非升序输出：先给第 3 行的替换 hunk，再给第 1 行前的插入 hunk。
    // 若无排序，倒序应用会先插入（行号整体后移），第 3 行 hunk 落在错误行上
    const hunks = parseUnifiedDiff(
      '@@ -3,1 +3,1 @@\n-maxHp = 100\n+maxHp = 200\n@@ -1,0 +1,1 @@\n+; 注释行\n',
    )
    const r = applyUnifiedDiff(old, hunks)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.text.startsWith('; 注释行')).toBe(true)
      expect(r.text).toContain('maxHp = 200')
      expect(r.text).not.toContain('maxHp = 100')
      // 插入 1 行 + 替换 1 行：7 → 8 行
      expect(r.text.split('\n').length).toBe(8)
    }
  })

  it('同位追加 + 替换同起始行（@@ -N,0 与 @@ -N,1）：输入顺序不影响结果', () => {
    // 追加在旧行 N 之前 + 替换旧行 N：语义兼容，两种顺序都应通过并得到相同结果
    const a = parseUnifiedDiff('@@ -2,0 +2,1 @@\n+; 注释\n@@ -2,1 +2,1 @@\n-name = "a"\n+name = "b"\n')
    const b = parseUnifiedDiff('@@ -2,1 +2,1 @@\n-name = "a"\n+name = "b"\n@@ -2,0 +2,1 @@\n+; 注释\n')
    const ra = applyUnifiedDiff(old, a)
    const rb = applyUnifiedDiff(old, b)
    expect(ra.ok).toBe(true)
    expect(rb.ok).toBe(true)
    if (ra.ok && rb.ok) expect(ra.text).toBe(rb.text)
  })

  it('同位双追加（两个 @@ -N,0）：按输入顺序保留，不误判重叠', () => {
    const hunks = parseUnifiedDiff('@@ -1,0 +1,1 @@\n+A\n@@ -1,0 +1,1 @@\n+B\n')
    const r = applyUnifiedDiff('x\n', hunks)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.text).toBe('A\nB\nx\n')
  })

  it('追加点落在替换区间内部 → 拒绝（防插入占用位置导致 splice 错位）', () => {
    // 替换 2-4 行（区间 [2,4)）+ 在第 3 行前插入：插入点严格在区间内部
    const hunks = parseUnifiedDiff(
      '@@ -2,2 +2,2 @@\n name = "a"\n-maxHp = 100\n+maxHp = 1\n@@ -3,0 +3,1 @@\n+; 注释\n',
    )
    const r = applyUnifiedDiff(old, hunks)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('重叠')
  })

  it('追加点 == 区间终点（相邻）放行；追加点在两个相邻区间之间放行', () => {
    // 替换 [2,4) + 追加在行 4 前（oldStart=4 == 区间终点）：合法，不应误拒
    const adjacent = parseUnifiedDiff(
      '@@ -2,2 +2,2 @@\n name = "a"\n-maxHp = 100\n+maxHp = 1\n@@ -4,0 +4,1 @@\n+; 注释\n',
    )
    const ra = applyUnifiedDiff(old, adjacent)
    expect(ra.ok).toBe(true)
    if (ra.ok) {
      expect(ra.text).toContain('maxHp = 1')
      expect(ra.text).toContain('; 注释')
    }
    // 追加点位于两个相邻区间之间（[2,4) 与 [4,5) 之间的 pos 4）
    const between = parseUnifiedDiff(
      '@@ -2,2 +2,2 @@\n name = "a"\n-maxHp = 100\n+maxHp = 1\n@@ -4,0 +4,1 @@\n+; 注释\n@@ -4,1 +4,1 @@\n-\n+X\n',
    )
    const rb = applyUnifiedDiff(old, between)
    expect(rb.ok).toBe(true)
    if (rb.ok) {
      expect(rb.text).toContain('; 注释')
      expect(rb.text).toContain('X')
      expect(rb.text).toContain('[attack]')
    }
  })

  it('空文件标准格式 @@ -0,0 +1,N @@ 支持（GNU diff 对空文件即输出此格式）', () => {
    const hunks = parseUnifiedDiff('@@ -0,0 +1,2 @@\n+[core]\n+name = "a"\n')
    const r = applyUnifiedDiff('', hunks)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.text).toBe('[core]\nname = "a"')
  })

  it('oldStart=0 且 oldCount>0 非法拒绝', () => {
    const hunks = parseUnifiedDiff('@@ -0,2 +0,2 @@\n-a\n-b\n+x\n+y\n')
    const r = applyUnifiedDiff('', hunks)
    expect(r.ok).toBe(false)
  })
})

describe('上限常量', () => {
  it('MAX_HUNKS 生效于解析后的数量控制（工具层检查）', () => {
    expect(MAX_HUNKS).toBe(200)
    expect(MAX_DIFF_BYTES).toBe(1024 * 1024)
  })
})
