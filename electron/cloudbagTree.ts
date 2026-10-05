/**
 * 云书包「树内可表示文件」口径的主进程侧实现（拉取覆盖语义与上传白名单必须同源）。
 *
 * 背景（第 4 轮审查 finding 1）：pull 用「zip 条目集合」对「本地全部文件」做差集，
 * 把差集内的一切文件 rename 进 .ohmytx/backup/（等效删除）；而上传侧只把
 * 白名单扩展名 + ≤50MiB + 合法 UTF-8 的文件当作可表示集合，其余「留在本地并如实上报」。
 * 两条集合口径不一致时，.gitignore/README.md/*.json/*.zip 产物/超限素材/GBK 文本
 * 会在 pull 后从项目根消失（对用户表现为「项目文件丢了」）。本模块把上传侧的
 * 可表示谓词在**主进程侧**复刻一份，供 cloudbagRestore 的「多余文件」判定使用。
 *
 * 与渲染层的同源关系：`src/features/community/cloudBagData.ts` 的
 * CLOUDBAG_ALLOWED_EXTENSIONS / isValidTreePath / classifyLocalFile 是同一口径的
 * 渲染层副本（渲染层不能 import electron 目录，反之亦然）；两份实现的一致性由
 * tests/cloudBagData.test.ts 的「口径同源」用例锁定（扩展名表逐项比对 + 判定表比对）。
 *
 * 上传时限策略也放在这里：渲染层副本在 src/services/cloudBagApi.ts，同样由测试锁定。
 */
/** 树内文件扩展名白名单（后端契约 §1.5，来源 modPack/modReport/tmx） */
export const CLOUDBAG_ALLOWED_EXTENSIONS = [
  '.ini', '.template', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp',
  '.ogg', '.wav', '.mp3', '.flac', '.tmx', '.tsx', '.txt',
] as const

/** 以文本形式读取的扩展名：上传前必须通过 UTF-8 校验（否则读取桥会改写内容而跳过） */
export const CLOUDBAG_TEXT_EXTENSIONS = ['.ini', '.template', '.txt', '.tmx', '.tsx'] as const

/** 单文件上传上限（J5：V1 无两阶段大文件上传；与渲染层 MAX_UPLOAD_FILE_BYTES 同值） */
export const CLOUD_BAG_MAX_UPLOAD_BYTES = 50 * 1024 * 1024

/**
 * Windows 保留设备名（与后端 cloudbagDeviceNameRE / cloudbag_base.go 同口径，逐路径段判定）：
 * 段本身或「设备名 + '.' 后缀」都不得作为路径段——`con/tank.ini` 会让 fs.mkdir('con') 失败、
 * `nul.ini` 在 NTFS 上指向空设备。此前谓词缺这一项，却自称与后端 validateCloudBagPath 同规则。
 */
const DEVICE_NAME_RE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i

/** 上传时限：至少 60s，随后按保守上行速率线性放宽（与渲染层 cloudBagApi 同策略同值） */
export const CLOUD_BAG_UPLOAD_TIMEOUT_MIN_MS = 60_000
export const CLOUD_BAG_UPLOAD_ASSUMED_BYTES_PER_SEC = 256 * 1024

/**
 * 单个 blob 的上传时限：60s 对 50MiB 意味着需要 ≥3.34MiB/s 的持续上行，普通家庭
 * 宽带上行远达不到——渲染层在 15s（旧值）就放弃、主进程在 60s 硬超时，合法大文件
 * 永远传不完。改为「下限 60s + 按字节数放宽」，两边用同一公式。
 */
export function cloudBagUploadTimeoutMs(bytes: number): number {
  if (!Number.isFinite(bytes) || bytes <= 0) return CLOUD_BAG_UPLOAD_TIMEOUT_MIN_MS
  const scaled = Math.ceil(bytes / CLOUD_BAG_UPLOAD_ASSUMED_BYTES_PER_SEC) * 1000
  return Math.max(CLOUD_BAG_UPLOAD_TIMEOUT_MIN_MS, scaled)
}

/**
 * 取扩展名：与后端 validateCloudBagPath（cloudbag_base.go:252-257）同口径——
 * 以最后一个 '.' 为界，**允许点号位于首位**（`.ini` 是合法条目，后端 strings.LastIndexByte
 * 只判 `dot < 0`）。旧的 `dot > 0` 守卫会把名为 `.ini/.png/.txt` 或 `sub/.ini` 的条目
 * 判成「无扩展名」而拒收，桌面因此整次中止拉取一个后端完全合法的版本树（无绕过出口）。
 */
function extensionOf(relPath: string): string {
  const name = relPath.split('/').pop() ?? relPath
  const dot = name.lastIndexOf('.')
  return dot >= 0 ? name.slice(dot).toLowerCase() : ''
}

/** 后端 Go strings.ToLower 的逐码点 simple lower；不作 NFC、去重音或 full case fold。
 * JS 整串 lower 会把词尾 Σ 变成 ς，İ 会扩展成 i + combining dot，均与 Go 不同。 */
export function cloudBagPathKey(relPath: string): string {
  return Array.from(relPath, (rune) => rune === '\u0130' ? 'i' : rune.toLowerCase()).join('')
}

export function isCloudBagTextPath(relPath: string): boolean {
  return (CLOUDBAG_TEXT_EXTENSIONS as readonly string[]).includes(extensionOf(relPath))
}

/**
 * 树内相对路径是否可被云书包表示（与渲染层 isValidTreePath 同规则，也与后端
 * validateCloudBagPath 同规则）：posix 相对路径，拒 `..`/`.`/空段、反斜杠、NUL、
 * 盘符、非白名单扩展名、超 200 rune。
 *
 * 额外补上「路径段级非法字符」：`: < > " | ? *` 与尾点/尾空格。Windows 上
 * `units/tank.ini:evil` 会落成 NTFS 备用数据流（ADS）而不是新文件——既不可见，
 * 又会让「本地树等价远端树」的判定与备份计数同时失效。主进程的既有命名纪律
 * 见 electron/fsIpc.ts 的 assertValidName。
 */
export function isCloudBagTreePath(relPath: string): boolean {
  // 长度按**码点**计（与后端 utf8.RuneCountInString / cloudBagPathMaxRunes 同口径）：
  // 旧实现用 relPath.length（UTF-16 码元），99 个 emoji 之类 astral 字符会按 2 码元计，
  // 让后端合法的 ≤200 rune 路径在桌面被拒（同样导致该版本树不可拉取）。
  if (!relPath || [...relPath].length > 200) return false
  if (relPath.includes('\\') || relPath.includes('\0')) return false
  if (/^[A-Za-z]:/.test(relPath) || relPath.startsWith('/')) return false
  const segments = relPath.split('/')
  for (const segment of segments) {
    if (segment === '' || segment === '.' || segment === '..') return false
    if (DEVICE_NAME_RE.test(segment)) return false
    // eslint-disable-next-line no-control-regex -- 控制字符在路径里不可见且易被滥用
    if (/[<>:"|?*\x00-\x1f\x7f]/.test(segment)) return false
    if (/[. ]$/.test(segment)) return false
  }
  return (CLOUDBAG_ALLOWED_EXTENSIONS as readonly string[]).includes(extensionOf(relPath))
}
