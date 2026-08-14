/**
 * 编辑器悬停文档（hover）：鼠标悬停查看键名/节名/颜色的说明。
 * - 键名（key:）→ 中文名、类型、所属节、说明、示例（demo）、版本区间
 * - 节名（[core]）→ 节的中文名
 * - 颜色值（#RRGGBB）→ 色卡预览
 * 数据来自 codeData（code.json / section.json），与补全、lint 同源。
 */
import { hoverTooltip } from '@codemirror/view'
import type { EditorView } from '@codemirror/view'
import { findCodeByCode, findLogicBoolean, findSectionsByQuery, loadCodeData, zhToEnKeySegments } from '../../services/codeData'

/** 行内注释剥离（值后面以空格开头 # 的注释部分），颜色值 #000000 不受影响 */
function stripComment(line: string): string {
  return line.replace(/[ \t]+#.*$/, '')
}

const COLOR_RE = /#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})\b/
const SECTION_RE = /^\s*\[(.+?)\]\s*(?:#.*)?$/

function colorCard(hex: string): string {
  const c = hex.replace('#', '')
  const full = c.length === 3 ? c.split('').map((x) => x + x).join('') : c
  const r = parseInt(full.slice(0, 2), 16)
  const g = parseInt(full.slice(2, 4), 16)
  const b = parseInt(full.slice(4, 6), 16)
  const a = full.length === 8 ? (parseInt(full.slice(6, 8), 16) / 255).toFixed(2) : '1'
  return `<div style="display:flex;align-items:center;gap:8px;padding:2px 0">
    <span style="display:inline-block;width:26px;height:26px;border-radius:5px;border:1px solid rgba(127,127,127,.4);background:${hex};box-shadow:inset 0 0 0 999px rgba(255,255,255,.06)"></span>
    <span style="font-family:var(--font-mono),monospace">${hex} · rgba(${r}, ${g}, ${b}, ${a})</span>
  </div>`
}

/** 悬停工具：查键/节/颜色，构造 tooltip DOM（异步加载代码表数据） */
export const rustHoverExtension = hoverTooltip(async (view: EditorView, pos: number, _side: number) => {
  await loadCodeData()
  // 数据加载期间文档可能被改短：越界 pos 直接放弃（lineAt 会抛 RangeError）
  if (pos > view.state.doc.length) return null
  const line = view.state.doc.lineAt(pos)
  const lineText = stripComment(line.text)
  const inLine = pos - line.from

  // 1) 节头悬停：[core] 的中文名（区间只到 ]，行尾注释不纳入）
  const secMatch = SECTION_RE.exec(lineText)
  if (secMatch) {
    const secStart = lineText.indexOf('[')
    const secEnd = secStart + lineText.indexOf(']', secStart) + 1
    if (inLine >= secStart && inLine <= secEnd) {
      const secName = secMatch[1].trim()
      // 编号节（[turret_1]/[spawnUnits_2]）：剥离数字后缀匹配基础节名，才有中文名；
      // 回退只保留「基础节名是编号节的前缀」（turret_1 → turret），不做反向匹配
      const baseSec = secName.replace(/_\d+$/, '')
      const candidates = findSectionsByQuery(baseSec, 10)
      const sec = candidates.find((s) => s.code === baseSec) ?? candidates.find((s) => s.code.startsWith(baseSec))
      const zh = sec?.translate && sec.translate !== baseSec ? sec.translate : ''
      return {
        pos: line.from + secStart,
        end: line.from + secEnd,
        create: () => {
          const dom = document.createElement('div')
          dom.className = 'cm-hover-doc'
          // secName 来自模组文件内容（可能含 HTML 特殊字符）：必须转义
          dom.innerHTML = `<b>[${escapeHtml(secName)}]</b>${zh ? ` · ${escapeHtml(zh)}` : ''}<div class="cm-hover-muted">节（Section）</div>`
          return { dom }
        },
      }
    }
  }

  // 2) 键名/值悬停：key: value 行
  const kv = /^([^:#]+?)\s*:\s*(.*)$/.exec(lineText)
  if (kv) {
    const keyStart = 0
    const keyEnd = kv[1].length
    const valStart = lineText.length - kv[2].length

    // 值区间：颜色色卡 + 逻辑布尔函数（self.xxx() / 关键字）
    if (inLine >= valStart) {
      const colorMatch = COLOR_RE.exec(lineText.slice(valStart))
      if (colorMatch && inLine >= valStart + colorMatch.index && inLine <= valStart + colorMatch.index + colorMatch[0].length) {
        const hex = colorMatch[0]
        return {
          pos: valStart + colorMatch.index,
          end: valStart + colorMatch.index + hex.length,
          create: () => {
            const dom = document.createElement('div')
            dom.className = 'cm-hover-doc'
            dom.innerHTML = colorCard(hex)
            return { dom }
          },
        }
      }
      // 逻辑布尔函数：self.xxx( ... ) 或独立函数名/关键字（and/or/not/if…）
      const valueText = lineText.slice(valStart)
      for (const m of valueText.matchAll(/self\.([a-zA-Z_][a-zA-Z0-9_]*)\(|(?<![\w.])if\b|(?<![\w.])(?:and|or|not|true|false)\b/g)) {
        const fn = m[1] ?? m[0]
        const start = valStart + (m.index ?? 0)
        const end = valStart + (m.index ?? 0) + m[0].length
        if (inLine >= start && inLine <= end) {
          const lb = findLogicBoolean(fn)
          if (!lb) continue
          return {
            pos: start,
            end,
            create: () => {
              const dom = document.createElement('div')
              dom.className = 'cm-hover-doc'
              const parts = [`<b>${escapeHtml(fn)}</b>`]
              if (lb.description && lb.description !== fn) parts.push(`<div style="margin-top:3px">${escapeHtml(lb.description)}</div>`)
              if (lb.example) parts.push(`<pre class="cm-hover-demo">${escapeHtml(lb.example)}</pre>`)
              dom.innerHTML = parts.join('')
              return { dom }
            },
          }
        }
      }
    }

    // 键区间（含中文分段回译）：查代码表
    if (inLine >= keyStart && inLine <= keyEnd) {
      const key = kv[1].trim()
      const en = findCodeByCode(key) ?? (key.includes('_') ? findCodeByCode(zhToEnKeySegments(key)) : undefined)
      if (!en) return null
      const vt = en.type
      return {
        pos: line.from + keyStart,
        end: line.from + keyEnd,
        create: () => {
          const dom = document.createElement('div')
          dom.className = 'cm-hover-doc'
          const parts: string[] = []
          // en.code/translate 可能含 HTML 特殊字符：统一转义（key 是用户文件内容）
          parts.push(`<b>${escapeHtml(en.code)}</b>${en.translate && en.translate !== en.code ? ` · ${escapeHtml(en.translate)}` : ''}`)
          if (en.description && en.description !== en.translate) parts.push(`<div style="margin-top:3px">${escapeHtml(en.description)}</div>`)
          parts.push(`<div class="cm-hover-muted" style="margin-top:3px">类型：${escapeHtml(vt)}${en.section && en.section !== 'all' ? ` · 节：${escapeHtml(en.section)}` : ''}</div>`)
          if (en.demo) parts.push(`<pre class="cm-hover-demo">${escapeHtml(en.demo)}</pre>`)
          dom.innerHTML = parts.join('')
          return { dom }
        },
      }
    }
  }
  return null
})

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}
