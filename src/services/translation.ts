/**
 * 中文翻译显示层：安全版旧版翻译功能。
 *
 * 设计原则（修复旧版痛点）：
 * - 打开文件时 original 保存英文原文，显示层 = 翻译后的中文；
 * - 保存时把显示内容转回英文再写盘，并更新快照；
 * - 翻译开关切换基于 original 重新生成，不覆盖用户编辑；
 * - 纯函数实现，词典由调用方注入，方便测试。
 */

export interface TranslationDict {
  enToZh: Map<string, string>
  zhToEn: Map<string, string>
}

const EN_WORD_RE = /\b[a-zA-Z_][a-zA-Z0-9_]*\b/g
const ZH_RUN_RE = /[\u4e00-\u9fff]+/g

/** 英文词 → 中文（保留首字母大写的原文风格；全大写常量不翻译，保护数据） */
export function enToZh(text: string, dict: TranslationDict): string {
  return text.replace(EN_WORD_RE, (word) => {
    // 全大写且长度 > 1：视为常量/引用标识符，不翻译，避免保存时信息丢失
    if (word.length > 1 && word === word.toUpperCase()) return word
    const zh = dict.enToZh.get(word.toLowerCase())
    if (!zh) return word
    if (/^[A-Z]/.test(word) && !/^[A-Z]/.test(zh)) {
      return zh.charAt(0).toUpperCase() + zh.slice(1)
    }
    return zh
  })
}

/** 连续汉字 → 英文（按最长匹配优先，防止短词先替换） */
export function zhToEn(text: string, dict: TranslationDict): string {
  return text.replace(ZH_RUN_RE, (run) => {
    // 贪心回溯：从最长的前缀开始尝试匹配
    for (let end = run.length; end > 0; end--) {
      const part = run.slice(0, end)
      const en = dict.zhToEn.get(part)
      if (en) {
        const rest = zhToEn(run.slice(end), dict)
        return en + rest
      }
    }
    return run
  })
}

/** 构造词典对象（从快照 Map） */
export function makeDict(enToZh: Map<string, string>, zhToEn: Map<string, string>): TranslationDict {
  return { enToZh, zhToEn }
}
