/**
 * 编辑器悬停文档（hover）：鼠标悬停查看键名/节名/颜色的说明。
 * - 键名（key:）→ 中文名、类型、所属节、说明、示例（demo）、版本区间
 * - 节名（[core]）→ 节的中文名
 * - 颜色值（#RRGGBB）→ 色卡预览
 * 数据来自 codeData（code.json / section.json），与补全、lint 同源。
 */
import { activateHover, closeHoverTooltip, EditorView, hoverTooltip } from '@codemirror/view'
import type { Tooltip } from '@codemirror/view'
import { findConfigCommentStart, findKeyValueSeparator, splitTopLevelConfigValue } from '../../services/configSyntax'
import { findCodeByCode, findLogicBoolean, findSectionsByQuery, findValueTypes, getDialectWords, getKeyZhToEnDict, getLogicIdentifierZhToEnDict, getPluginEnumExplanation, getValueZhDict, getZhToEnDict, loadCodeData, normalizeSectionName, parseValueList, versionNumberToName, zhToEnKeySegments } from '../../services/codeData'

/**
 * 键位置中文回译（导出供测试）：中文模式下键是中文译名（名称/主体图像），
 * 先查键名回译表（键译名不被节名覆盖），再回落通用词典，最后按 _ 分段回译；
 * 纯英文键原样返回（findCodeByCode 会直接命中）。
 */
export function resolveKeyEn(key: string): string {
  const trimmed = key.trim()
  if (!trimmed) return trimmed
  return getKeyZhToEnDict().get(trimmed) ?? getZhToEnDict().get(trimmed) ?? zhToEnKeySegments(trimmed)
}

/** 逻辑表达式 self.xxx 中的函数名回译：只查已知词典，未知中文保持原样。 */
export function resolveLogicFunctionEn(name: string): string {
  return getLogicIdentifierZhToEnDict().get(name) ?? getKeyZhToEnDict().get(name) ?? getZhToEnDict().get(name) ?? name
}

const COLOR_RE = /#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})\b/
const SECTION_RE = /^\s*\[(.+?)\]\s*(?:#.*)?$/

function topLevelSegmentAt(value: string, offset: number): { start: number; end: number; text: string } {
  let start = 0
  const parts = splitTopLevelConfigValue(value)
  for (const [index, part] of parts.entries()) {
    const end = start + part.length
    if (offset <= end || index === parts.length - 1) {
      return { start, end, text: part }
    }
    start = end + 1
  }
  return { start: 0, end: value.length, text: value }
}

function colorCard(hex: string): string {
  const c = hex.replace('#', '')
  const full = c.length === 3 ? c.split('').map((x) => x + x).join('') : c
  const r = parseInt(full.slice(0, 2), 16)
  const g = parseInt(full.slice(2, 4), 16)
  const b = parseInt(full.slice(4, 6), 16)
  const a = full.length === 8 ? (parseInt(full.slice(6, 8), 16) / 255).toFixed(2) : '1'
  return `<div style="display:flex;align-items:center;gap:8px;padding:2px 0">
    <span style="display:inline-block;width:26px;height:26px;border-radius:5px;border:1px solid rgba(127,127,127,.4);background:${hex};box-shadow:inset 0 0 0 999px rgba(255,255,255,.06)"></span>
    <span style="font-family:var(--font-mono),monospace">${hex}，rgba(${r}, ${g}, ${b}, ${a})</span>
  </div>`
}

/** 悬停工具：查键/节/颜色，构造 tooltip DOM（异步加载代码表数据） */
export async function rustTooltipAt(view: EditorView, pos: number): Promise<Tooltip | null> {
  const doc = view.state.doc
  await loadCodeData()
  // 数据加载期间文档可能被改短：越界 pos 直接放弃（lineAt 会抛 RangeError）
  if (view.state.doc !== doc || pos < 0 || pos > doc.length) return null
  const line = view.state.doc.lineAt(pos)
  const lineText = line.text
  const inLine = pos - line.from
  if (findConfigCommentStart(lineText) >= 0 || /^\s*;/.test(lineText)) return null

  // 1) 节头悬停：[core] 的中文名（区间只到 ]，行尾注释不纳入）
  const secMatch = SECTION_RE.exec(lineText)
  if (secMatch) {
    const secStart = lineText.indexOf('[')
    const secEnd = lineText.indexOf(']', secStart) + 1
    if (inLine >= secStart && inLine <= secEnd) {
      const secName = secMatch[1].trim()
      // 编号/命名节（[turret_1]/[turret_main]）：归一化到已知基础节名，才有中文名；
      // 未知节不猜测归类，避免把用户自定义节误显示成官方节。
      const baseSec = normalizeSectionName(secName)
      const candidates = findSectionsByQuery(baseSec, 10)
      const sec = candidates.find((s) => s.code.toLowerCase() === baseSec) ?? candidates.find((s) => s.code.toLowerCase().startsWith(baseSec))
      const zh = sec?.translate && sec.translate !== baseSec ? sec.translate : ''
      return {
        pos: line.from + secStart,
        end: line.from + secEnd,
        create: () => {
          const dom = document.createElement('div')
          dom.className = 'cm-hover-doc'
          // secName 来自模组文件内容（可能含 HTML 特殊字符）：必须转义
          dom.innerHTML = `${zh ? `<b>${escapeHtml(zh)}</b><br>` : ''}<small>[${escapeHtml(secName)}]</small><div class="cm-hover-muted">节（Section）</div>`
          return { dom }
        },
      }
    }
  }

  // 2) 键名/值悬停：key: value 行（引擎解析同时认 : 和 =，与 lint/补全一致）。
  // 手动找分隔符（正则含 = 会被安全扫描误报）
  const sepIdx = findKeyValueSeparator(lineText)
  const kv = sepIdx > 0 ? [lineText.slice(0, sepIdx), lineText.slice(sepIdx + 1)] : null
  if (kv) {
    const keyStart = 0
    const keyEnd = kv[0].length
    const valStart = lineText.length - kv[1].length
    const key = resolveKeyEn(kv[0].trim())
    const code = findCodeByCode(key)
    const isLogicValue = code?.type.split(',').some((type) => /bool|logic/i.test(type)) ?? false

    // 值区间：颜色色卡 + 逻辑布尔函数（self.xxx() / 关键字）
    if (inLine >= valStart) {
      const colorMatch = COLOR_RE.exec(lineText.slice(valStart))
      if (colorMatch && inLine >= valStart + colorMatch.index && inLine <= valStart + colorMatch.index + colorMatch[0].length) {
        const hex = colorMatch[0]
        return {
          pos: line.from + valStart + colorMatch.index,
          end: line.from + valStart + colorMatch.index + hex.length,
          create: () => {
            const dom = document.createElement('div')
            dom.className = 'cm-hover-doc'
            dom.innerHTML = colorCard(hex)
            return { dom }
          },
        }
      }
      // 逻辑布尔函数：self.xxx( ... ) 或独立函数名/关键字（and/or/not/if…）。
      // 中文显示层会把 self.hp() 显示为 self.血量()，因此 self. 后允许已翻译的汉字 token；
      // 真正的函数表仍只用回译后的英文名查询，未知中文不猜测。
      const valueText = lineText.slice(valStart)
      if (isLogicValue) for (const m of valueText.matchAll(/"(?:\\.|[^"\\])*(?:"|$)|'(?:\\.|[^'\\])*(?:'|$)|(?<![\w.一-鿿])self\.([a-zA-Z_一-鿿][a-zA-Z0-9_一-鿿]*)|(?<![\w.一-鿿])(?:if|and|or|not|true|false|真|假|是|否)(?![\w一-鿿])/gi)) {
        // Strings are data even when they contain known logical tokens.
        if (m[0].startsWith('"') || m[0].startsWith("'")) continue
        const fn = m[1] ?? m[0]
        const booleanAliases: Record<string, string> = { 真: 'true', 是: 'true', 假: 'false', 否: 'false' }
        const fnEn = m[1] ? resolveLogicFunctionEn(fn) : booleanAliases[fn] ?? fn.toLowerCase()
        const start = valStart + (m.index ?? 0)
        const end = valStart + (m.index ?? 0) + m[0].length
        if (inLine >= start && inLine <= end) {
          const dialect = m[1] ? getDialectWords(fnEn).find((item) => item.word.toLowerCase() === fnEn.toLowerCase()) : undefined
          const lb = findLogicBoolean(fnEn) ?? (dialect ? { description: dialect.explanation, example: '' } : undefined)
          if (!lb) continue
          return {
            pos: line.from + start,
            end: line.from + end,
            create: () => {
              const dom = document.createElement('div')
              dom.className = 'cm-hover-doc'
              const parts = [`<b>${escapeHtml(fn)}</b>${fnEn !== fn ? `，${escapeHtml(fnEn)}` : ''}`]
              if (lb.description && lb.description !== fnEn) parts.push(`<div style="margin-top:3px">${escapeHtml(lb.description)}</div>`)
              if (lb.example) parts.push(`<pre class="cm-hover-demo">${escapeHtml(lb.example)}</pre>`)
              dom.innerHTML = parts.join('')
              return { dom }
            },
          }
        }
      }
      // 枚举值中文解释：只对当前字段允许的 list 值提示，避免资源路径中普通英文
      // 被误识别为枚举。带参数枚举用括号前基础值查 value_zh，原参数串仍完整保留。
      const types = code ? findValueTypes(code.type) : []
      const allowed = new Set(types.flatMap((type) => parseValueList(type.list)).map((value) => value.toLowerCase()))
      const allowedBases = new Set([...allowed].map((value) => {
        const open = value.indexOf('(')
        return (open >= 0 ? value.slice(0, open) : value).trim()
      }))
      const typeHint = types
        .map((type) => [type.name, type.describe].filter(Boolean).join('：'))
        .filter(Boolean)
        .join('，')
      const fullValue = valueText.trim()
      const valueZh = getValueZhDict()
      const enumTooltip = (raw: string, start: number, end: number) => {
        const base = raw.slice(0, raw.indexOf('(') >= 0 ? raw.indexOf('(') : raw.length)
        const zh = valueZh.get(raw.toLowerCase()) ?? valueZh.get(base.toLowerCase()) ?? getPluginEnumExplanation(key, base)
        if (!zh || (!allowed.has(raw.toLowerCase()) && !allowedBases.has(base.trim().toLowerCase()))) return null
        return {
          pos: line.from + start,
          end: line.from + end,
          create: () => {
            const dom = document.createElement('div')
            dom.className = 'cm-hover-doc'
            const field = code?.translate ? `${code.code}：${code.translate}` : code?.code
            dom.innerHTML = `<b>${escapeHtml(raw)}</b>：${escapeHtml(zh)}${field ? `<div class="cm-hover-muted">${escapeHtml(field)}</div>` : ''}${typeHint ? `<div class="cm-hover-muted">${escapeHtml(typeHint)}</div>` : ''}<div class="cm-hover-muted">枚举值（引擎保留原写法）</div>`
            return { dom }
          },
        }
      }
      const valueOffset = valStart + valueText.length - valueText.trimStart().length
      const whole = enumTooltip(fullValue, valueOffset, valueOffset + fullValue.length)
      if (whole) return whole
      // 逗号分隔的多枚举值：括号内逗号属于参数，不切断当前枚举项。
      const segmentRange = topLevelSegmentAt(fullValue, Math.max(0, inLine - valueOffset))
      const segStart = valueOffset + segmentRange.start + segmentRange.text.length - segmentRange.text.trimStart().length
      const segEnd = valueOffset + segmentRange.end - (segmentRange.text.length - segmentRange.text.trimEnd().length)
      const segment = enumTooltip(segmentRange.text.trim(), segStart, segEnd)
      if (segment && inLine >= segStart && inLine <= segEnd) return segment
    }

    // 键区间（含中文回译）：中文模式下键是中文译名（名称/主体图像），
    // 先查键名回译表（键译名不被节名覆盖），再回落通用词典，最后按 _ 分段回译
    if (inLine >= keyStart && inLine <= keyEnd) {
      const key = kv[0].trim()
      const back = resolveKeyEn(key)
      const en = findCodeByCode(key) ?? (back !== key ? findCodeByCode(back) : undefined)
      if (!en) return null
      const vt = en.type
      // M11：版本信息行（加入版本/移除弃用；版本表缺失时显示版本号）
      const versionParts: string[] = []
      if (typeof en.addVersion === 'number' && en.addVersion > 0) {
        const name = versionNumberToName(en.addVersion)
        versionParts.push(`加入：${name ?? en.addVersion}`)
      }
      if (typeof en.removeVersion === 'number' && en.removeVersion >= 0) {
        const name = versionNumberToName(en.removeVersion)
        versionParts.push(`已移除：${name ?? en.removeVersion}`)
      }
      return {
        pos: line.from + keyStart,
        end: line.from + keyEnd,
        create: () => {
          const dom = document.createElement('div')
          dom.className = 'cm-hover-doc'
          const parts: string[] = []
          // en.code/translate 可能含 HTML 特殊字符：统一转义（key 是用户文件内容）
          parts.push(`${en.translate && en.translate !== en.code ? `<b>${escapeHtml(en.translate)}</b><br>` : ''}<small>${escapeHtml(en.code)}</small>`)
          if (en.description && en.description !== en.translate) parts.push(`<div style="margin-top:3px">${escapeHtml(en.description)}</div>`)
          parts.push(`<div class="cm-hover-muted" style="margin-top:3px">类型：${escapeHtml(vt)}${en.section && en.section !== 'all' ? `，节：${escapeHtml(en.section)}` : ''}</div>`)
          if (versionParts.length > 0) parts.push(`<div class="cm-hover-muted">${escapeHtml(versionParts.join('，'))}</div>`)
          if (en.demo) parts.push(`<pre class="cm-hover-demo">${escapeHtml(en.demo)}</pre>`)
          dom.innerHTML = parts.join('')
          return { dom }
        },
      }
    }
  }
  return null
}

export const rustHoverExtension = hoverTooltip(rustTooltipAt)

/** Explicit activation keeps double-click help independent of hover timers. */
export const rustDoubleClickHelp = EditorView.domEventHandlers({
  blur(_event, view) {
    view.dispatch({ effects: closeHoverTooltip(rustHoverExtension) })
  },
  keydown(event, view) {
    if (event.key === 'Escape') view.dispatch({ effects: closeHoverTooltip(rustHoverExtension) })
    return false
  },
  dblclick(event, view) {
    const pos = view.posAtCoords({ x: event.clientX, y: event.clientY })
    if (pos === null) return false
    view.dispatch({ effects: closeHoverTooltip(rustHoverExtension) })
    activateHover(view, pos, 1, {
      tooltip: rustHoverExtension,
      until: (transaction) => transaction.docChanged || !!transaction.selection,
    })
    // CodeMirror still owns the normal double-click word selection.
    return false
  },
})

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}
