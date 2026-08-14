/**
 * AI 修改后自动质检（任务 3）：
 * writeFile 成功后，读取刚写入的文件跑一遍现有 rustLint，把诊断转成
 * 「文件 + 行号 + 原因 + 修复建议」的可操作清单，展示在对话工具卡片里。
 *
 * 设计：lint 数据层（代码表/值类型/词典）只在渲染层加载过，质检也放在渲染层
 * （工具结束事件到达时触发）；lint 与撤销/历史完全独立——质检发现问题不影响撤销。
 */
import type { AiLintItem } from '../../types/ai'
import { lintIniText } from '../editor/rustLint'
import { findCodeByCode, findValueType, getZhToEnDict, loadCodeData } from '../../services/codeData'

/** 偏移量 → 行号（从 1 起；lint 诊断给的是字符偏移，界面要行号才能定位） */
export function lineNumberAt(content: string, offset: number): number {
  let line = 1
  const end = Math.min(offset, content.length)
  for (let i = 0; i < end; i++) {
    if (content[i] === '\n') line++
  }
  return line
}

/** 按诊断类型给出可执行的修复建议（纯函数，供测试） */
export function suggestionFor(message: string): string {
  if (message.includes('不符合类型')) {
    return '对照编辑器右上角「代码表」修正该键的值，或让 AI 按值类型规则重写这一行'
  }
  if (message.includes('不在任何')) {
    return '把该行移入 [节] 内，或删除此行'
  }
  return '检查该行格式是否符合铁锈战争 .ini 规范'
}

/** lint 诊断 → 可操作清单（纯函数，供测试） */
export function toLintItems(
  content: string,
  diagnostics: Array<{ from: number; to: number; message: string; severity: 'error' | 'warning' }>,
): AiLintItem[] {
  return diagnostics.map((d) => ({
    line: lineNumberAt(content, d.from),
    message: d.message,
    severity: d.severity,
    suggestion: suggestionFor(d.message),
  }))
}

/**
 * AI 写文件后自动质检：读取刚写入的文件并跑一遍 rustLint。
 * 返回 null 表示无法检查（非 ini/读取失败）；空数组表示无问题。
 */
export async function checkAiWrittenFile(rootPath: string, relPath: string): Promise<AiLintItem[] | null> {
  if (!/\.(ini|template)$/i.test(relPath)) return null
  try {
    const { getBridge } = await import('../../services/bridge')
    const { content } = await getBridge().project.readFile(rootPath, relPath)
    await loadCodeData()
    const zhToEnDict = getZhToEnDict()
    const diagnostics = lintIniText(content, {
      findCode: (k) => findCodeByCode(k),
      findType: (t) => findValueType(t),
      zhToEn: (k) => zhToEnDict.get(k),
    })
    return toLintItems(content, diagnostics)
  } catch {
    // 文件被删/读取失败等：跳过质检，不影响对话与撤销
    return null
  }
}
