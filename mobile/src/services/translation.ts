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
/**
 * 中文 run：允许夹带数字与下划线（[抛射体_1]、[建造自_1_名称] 这类
 * 编号/宏字段键的翻译串是「中文_数字_中文」结构，必须整体匹配才能命中
 * 追踪表并还原成英文键；否则保存会把中文键/节名直接写盘，游戏无法识别）。
 */
const ZH_RUN_RE = /[\u4e00-\u9fff][\u4e00-\u9fff0-9_]*/g

/**
 * 翻译追踪表（中文显示串 → 原始英文串）。
 * enToZh 在产生中文时逐条记录；zhToEn 优先按它精确还原原文
 * （含大小写），保证保存不改变磁盘内容。
 */
export type TranslationTracker = Map<string, string>

/**
 * 英文词 → 中文（保留首字母大写的原文风格；全大写常量不翻译，保护数据）。
 * tracker 可选：开启时记录「中文显示串 → 原始英文串」，供保存时精确回译。
 */
export function enToZh(text: string, dict: TranslationDict, tracker?: TranslationTracker): string {
  return text.replace(EN_WORD_RE, (word) => {
    // 全大写且长度 > 1：视为常量/引用标识符，不翻译，避免保存时信息丢失
    if (word.length > 1 && word === word.toUpperCase()) return word

    // 记录翻译串（中文 → 原始英文词）：
    // - 首次出现：登记；
    // - 同一中文串对应不同原文（如 true/True 都译成「是」）：多对一取首会让保存时
    //   所有同串都被归一化成一个大小写（改写磁盘）。放弃翻译该词、显示层保留英文
    //   原文，保存无歧义。
    const record = (zh: string): string => {
      if (!tracker) return zh
      const existing = tracker.get(zh)
      if (existing === undefined) {
        tracker.set(zh, word)
        return zh
      }
      return existing === word ? zh : word
    }

    // 兜底链：①带编号后缀（projectile_1 → projectile）
    // ②以 _ 结尾的节名前缀（global_resource_聚能 → global_resource_ → global_resource）
    // 均翻译基础词后拼回原文后缀
    const numbered = /^(.+?)_(\d+)$/.exec(word)
    if (numbered) {
      const styled = lookupBase(numbered[1], dict)
      if (styled) return record(styled + '_' + numbered[2])
    }
    if (word.endsWith('_')) {
      const styled = lookupBase(word.slice(0, -1), dict)
      if (styled) return record(styled + '_')
    }
    // 宏字段分段翻译：builtFrom_1_name / canBuild_2_tooltip 这类
    // 「前缀_数字_后缀」占位字段，整体查不到时按段翻译（builtFrom→建造自，1 保留，name→名称）
    if (word.includes('_')) {
      const segments = word.split('_')
      const translated = segments.map((seg) => {
        if (/^\d+$/.test(seg)) return seg
        const styled = lookupBase(seg, dict)
        return styled || seg
      })
      const joined = translated.join('_')
      if (joined !== word) return record(joined)
    }

    const zh = dict.enToZh.get(word.toLowerCase())
    if (!zh) return word
    if (/^[A-Z]/.test(word) && !/^[A-Z]/.test(zh)) {
      return record(zh.charAt(0).toUpperCase() + zh.slice(1))
    }
    return record(zh)
  })
}

/** 查基础词翻译并保留首字母大写风格（找不到返回空） */
function lookupBase(base: string, dict: TranslationDict): string {
  const zh = dict.enToZh.get(base.toLowerCase())
  if (!zh) return ''
  return /^[A-Z]/.test(base) && !/^[A-Z]/.test(zh) ? zh.charAt(0).toUpperCase() + zh.slice(1) : zh
}

/**
 * 连续汉字 → 英文（按最长匹配优先，防止短词先替换）。
 * tracker 可选：传入时进入「追踪模式」——只还原翻译层产生的中文
 * （本次打开时 enToZh 记录的），其余中文（用户手写/文件里原有的中文数据）
 * 一律保留，防止保存把数据改写成英文；不传时保持旧行为（词典回译）。
 */
export function zhToEn(text: string, dict: TranslationDict, tracker?: TranslationTracker): string {
  return text.replace(ZH_RUN_RE, (run) => {
    // 贪心回溯：从最长的前缀开始尝试匹配
    for (let end = run.length; end > 0; end--) {
      const part = run.slice(0, end)
      if (tracker) {
        // 追踪模式：只还原本次翻译产生的中文（精确还原原文，含大小写）
        const traced = tracker.get(part)
        if (traced !== undefined) {
          return traced + zhToEn(run.slice(end), dict, tracker)
        }
      } else {
        const en = dict.zhToEn.get(part)
        if (en) {
          const rest = zhToEn(run.slice(end), dict, tracker)
          return en + rest
        }
      }
    }
    return run
  })
}

/** 构造词典对象（从快照 Map） */
export function makeDict(enToZh: Map<string, string>, zhToEn: Map<string, string>): TranslationDict {
  return { enToZh, zhToEn }
}
