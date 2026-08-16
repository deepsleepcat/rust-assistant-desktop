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
  /** 键名回译表（code.json 译名 → 键名）：键位置词典兜底优先查，
   * 避免键译名被节名/旧词条译名撞车覆盖（价格→price 误成 prices） */
  keyZhToEn?: Map<string, string>
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
 * tracker 可选：传入时进入「追踪模式」——行感知回译：
 * - 键位置（: / = 前的键名段）：tracker 精确还原 + 词典兜底（表单/炮塔编辑器
 *   新增的中文键未登记 tracker，但键必须是英文才能被游戏识别，词典回译兜底）；
 * - 值位置：只还原 tracker 登记过的翻译产物，其余中文（用户手写/文件原有数据）
 *   一律保留——且替换要求两侧非词边界，词内撞串（用户值「攻击力强」里的「攻击」）
 *   不替换，防止保存把用户数据改写成英文；
 * - 键含 ASCII 前缀（x坐标 → x）也能整体命中（不再依赖汉字 run 正则分段）。
 * 不传 tracker 时保持旧行为（词典回译）。
 */
export function zhToEn(text: string, dict: TranslationDict, tracker?: TranslationTracker): string {
  if (!tracker) {
    // 非追踪模式：纯词典回译（lint/表单回译查询用）
    return dictFallback(text, dict, dict.zhToEn)
  }
  // 追踪模式：按行处理（键位置与值位置的回译规则不同）；
  // 空 tracker（本次打开没翻译出任何词）也要走追踪语义——值位置全保留，
  // 不能回落词典回译（会把用户中文数据改写成英文）
  return text
    .split('\n')
    .map((line) => zhToEnLine(line, dict, tracker))
    .join('\n')
}

/** 追踪模式单行回译：认 : 与 = 分隔符（与引擎解析一致）；
 * 键位置（含节头 [name]）允许键后跟 _（宏字段后缀/needName 节实例名），
 * 值位置严格边界（用户数据「攻击_力强」里的 攻击 不被改写） */
function zhToEnLine(line: string, dict: TranslationDict, tracker: TranslationTracker): string {
  const kv = /^(\s*)([^:=]*?)(\s*)([:=])(.*)$/.exec(line)
  if (!kv) {
    // 节头行（[name]）按键位置宽松边界处理；其余行（注释/普通文本）严格边界
    const isSection = line.trimStart().startsWith('[')
    return tracedReplace(line, tracker, isSection)
  }
  const [, indent, keyRaw, ws, sep, rest] = kv
  const keyEn = restoreKeyText(keyRaw, dict, tracker)
  const valEn = tracedReplace(rest, tracker, false)
  return indent + keyEn + ws + sep + valEn
}

/**
 * 追踪模式替换：tracker 键交替匹配 + 两侧非词边界。
 * 翻译层产生的中文是「完整词」（enToZh 按整词替换），用户手写中文是独立内容：
 * 词内撞串（攻击力强 里的 攻击）因两侧是词字符而不替换，保护用户数据；
 * 键含 ASCII 前缀（x坐标）也整体匹配。
 * allowUnderscoreRight：键位置/节头为 true——「中文_后缀」结构（[炮塔_主炮]、
 * 建造自_1_名称_2）需要键后跟 _ 时仍能命中；值位置 false 防止用户数据
 * 「攻击_力强」「坦克_2」被词典词前缀改写。
 */
function tracedReplace(text: string, tracker: TranslationTracker, allowUnderscoreRight = false): string {
  if (tracker.size === 0) return text
  const keys = [...tracker.keys()].sort((a, b) => b.length - a.length) // 最长优先，防短键先吞长键
  const right = allowUnderscoreRight ? '(?![\\u4e00-\\u9fffA-Za-z0-9])' : '(?![\\u4e00-\\u9fffA-Za-z0-9_])'
  const re = new RegExp('(?<![\\u4e00-\\u9fffA-Za-z0-9_])(' + keys.map(escapeRegExp).join('|') + ')' + right, 'g')
  return text.replace(re, (hit) => tracker.get(hit)!)
}

/** 键位置回译：tracker 精确还原优先；未覆盖（表单新增中文键）时词典兜底（整串 → 分段） */
function restoreKeyText(keyRaw: string, dict: TranslationDict, tracker: TranslationTracker): string {
  const traced = tracedReplace(keyRaw, tracker, true)
  if (traced !== keyRaw) return traced
  const keyMap = dict.keyZhToEn ?? dict.zhToEn
  const direct = keyMap.get(keyRaw.trim()) ?? dict.zhToEn.get(keyRaw.trim())
  if (direct) return keyRaw.replace(keyRaw.trim(), direct)
  return dictFallback(keyRaw, dict, keyMap)
}

/** 词典回译（整段优先查表，未命中按汉字 run 最长前缀拆解） */
function dictFallback(text: string, dict: TranslationDict, map: Map<string, string>): string {
  const direct = map.get(text.trim())
  if (direct !== undefined) return text.replace(text.trim(), direct)
  return text.replace(ZH_RUN_RE, (run) => {
    for (let end = run.length; end > 0; end--) {
      const part = run.slice(0, end)
      const en = map.get(part)
      if (en) return en + dictFallback(run.slice(end), dict, map)
    }
    return run
  })
}

/** 正则特殊字符集合（tracker 键转义用；逐字符判断） */
const REGEXP_SPECIALS = '.+*?^${}()|[]\\'

function escapeRegExp(s: string): string {
  let out = ''
  for (const ch of s) {
    out += REGEXP_SPECIALS.includes(ch) ? '\\' + ch : ch
  }
  return out
}

/** 构造词典对象（从快照 Map；keyZhToEn 可选：键位置词典兜底优先表） */
export function makeDict(enToZh: Map<string, string>, zhToEn: Map<string, string>, keyZhToEn?: Map<string, string>): TranslationDict {
  return { enToZh, zhToEn, keyZhToEn }
}
