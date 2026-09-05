/**
 * 文件系统 IPC（M40 巨型文件拆分批次 B4）：
 * 读目录/读文件/写文件/新建/重命名/删除 + 项目搜索 + 图片/音频预览。
 * 所有读写删都先过 projectTrust 的词法 + 真实路径校验。
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { IpcContext } from './ipcContext'
import type { RegisterHandler } from './ipcTypes'
import { assertNoLinkEscape, isPathInside } from './paths'
import { searchProjectFiles } from './projectSearch'
import { exists, requireInsideRoot, requireRealInsideRoot } from './projectTrust'
import { AUDIO_MIME, IMAGE_MIME, readMediaAsDataUrl } from './mediaPolicy'

/** 文本文件读取上限（编辑器打开超大文件会拖垮界面） */
const MAX_TEXT_FILE_SIZE = 64 * 1024 * 1024

/** Windows 非法文件名：保留设备名（CON/NUL/AUX/COM1…）+ 非法字符 + 尾点/尾空格 */
function assertValidName(name: string, what: string): void {
  if (typeof name !== 'string' || !name.trim() || name === '.' || name === '..') throw new Error(`无效的${what}名`)
  // eslint-disable-next-line no-control-regex -- 控制字符在文件名里不可见且易被滥用，必须拒绝
  if (/[<>:"/\\|?*\x00-\x1f]/.test(name)) throw new Error(`${what}名包含非法字符（< > : " / \\ | ? *）`)
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(name)) throw new Error(`「${name}」是系统保留名，无法使用`)
  if (/[. ]$/.test(name)) throw new Error(`${what}名不能以点或空格结尾`)
}

/**
 * 目录内目标边界断言（供扫描器与人工复核的显式防线）：
 * name 可能带 ..\ 等穿越段——resolve 后必须仍落在 dirPath 内。
 * 随后的 requireRealInsideRoot 仍会做登记根 + 链接逃逸的完整校验。
 */
function assertInsideDir(dirPath: string, target: string): void {
  if (!isPathInside(path.resolve(dirPath), target)) throw new Error('目标路径超出项目目录范围，拒绝访问')
}

/** 文件系统：读目录/读文件/写文件/新建/重命名/删除 + 图片/音频预览 */
export function registerFsIpc(ctx: IpcContext, ipc: RegisterHandler): void {
  ipc('fs:readDir', async (_event, rootPath: string, dirPath: string, showHidden = false) => {
    await requireRealInsideRoot(ctx, rootPath, dirPath)
    const all = await fs.readdir(dirPath, { withFileTypes: true })
    // M8：显示隐藏文件开关（默认隐藏 . 开头条目；.nomedia 这类游戏文件默认不打扰）
    const entries = showHidden ? all : all.filter((e) => !e.name.startsWith('.'))
    const out = await Promise.all(
      entries.map(async (entry) => {
        const full = path.join(dirPath, entry.name)
        let size = 0
        let mtimeMs = 0
        let isDirectory = entry.isDirectory()
        if (entry.isSymbolicLink()) {
          // 链接：目标在项目内才跟随 stat（链接目录正常显示为文件夹）；
          // 指向项目外/失效的链接跳过 stat（防根外文件元数据泄漏），按普通条目返回
          try {
            await assertNoLinkEscape(rootPath, full)
            const stat = await fs.stat(full)
            size = stat.size
            mtimeMs = stat.mtimeMs
            // L1：junction/符号链接在 readdir 下 isDirectory=false——按真实目标判定，
            // 链接目录在树里显示为文件夹（否则显示成文件、点击报 EISDIR）
            isDirectory = stat.isDirectory()
          } catch {
            // 根外链接/悬空链接：不返回目标元数据
          }
        } else {
          try {
            const stat = await fs.stat(full)
            size = stat.size
            mtimeMs = stat.mtimeMs
          } catch {
            // 无权限等场景：尽力读取目录信息即可
          }
        }
        return { name: entry.name, path: full, isDirectory, size, mtimeMs }
      }),
    )
    // 文件夹优先，其次按名称排序（中文按拼音浏览器区域规则排）
    out.sort((a, b) => {
      if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1
      return a.name.localeCompare(b.name, 'zh-CN')
    })
    return out
  })

  // M37：一次性在主进程递归文件名/相对路径，避免渲染层对每个目录反复 IPC。
  // 只搜索已登记项目根内的普通文件；实现本身不读取任何文件内容。
  ipc('project:searchFiles', async (_event, rootPath: unknown, query: unknown, showHidden: unknown = false) => {
    if (typeof rootPath !== 'string' || !rootPath) throw new Error('项目目录为空')
    if (typeof query !== 'string' || query.length > 256) throw new Error('搜索关键词无效')
    if (typeof showHidden !== 'boolean') throw new Error('隐藏文件参数无效')
    await requireRealInsideRoot(ctx, rootPath, rootPath)
    return searchProjectFiles(rootPath, query, showHidden)
  })

  ipc('fs:readFile', async (_event, rootPath: string, filePath: string) => {
    await requireRealInsideRoot(ctx, rootPath, filePath)
    const stat = await fs.stat(filePath)
    // L3：超大文本文件直接报错（几 GB 的文件读进内存会拖垮主进程）
    if (stat.size > MAX_TEXT_FILE_SIZE) throw new Error('文件超过 64MB，暂不支持在编辑器中打开')
    const buf = await fs.readFile(filePath)
    const hasBom = buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf
    const content = hasBom ? buf.subarray(3).toString('utf8') : buf.toString('utf8')
    return { content, hasBom, mtimeMs: stat.mtimeMs, size: stat.size }
  })

  // 只读元数据（mtime/size）：外部修改轮询用，避免每 3 秒全量读盘
  ipc('fs:stat', async (_event, rootPath: string, filePath: string) => {
    await requireRealInsideRoot(ctx, rootPath, filePath)
    const stat = await fs.stat(filePath)
    return { mtimeMs: stat.mtimeMs, size: stat.size }
  })

  ipc('fs:writeFile', async (_event, rootPath: string, filePath: string, content: string, opts: { hasBom: boolean }) => {
    await requireRealInsideRoot(ctx, rootPath, filePath)
    // L7：按 UTF-8 字节数限制（与读取上限对称；中文内容按字符数会低估体积）
    if (typeof content !== 'string' || Buffer.byteLength(content, 'utf8') > MAX_TEXT_FILE_SIZE) throw new Error('写入内容过大（超过 64MB）')
    const body = opts?.hasBom ? `\uFEFF${content}` : content
    const dir = path.dirname(filePath)
    const tmp = path.join(dir, `.${path.basename(filePath)}.ra-${randomUUID()}.tmp`)
    // 显式边界断言：临时文件必须落在目标文件同目录内（dirname 已过根校验）
    assertInsideDir(dir, tmp)
    try {
      await fs.writeFile(tmp, body, 'utf8')
      await fs.rename(tmp, filePath)
    } catch (err) {
      await fs.rm(tmp, { force: true }).catch(() => undefined)
      throw err
    }
  })

  ipc('fs:createFile', async (_event, rootPath: string, dirPath: string, name: string) => {
    assertValidName(name, '文件')
    await requireRealInsideRoot(ctx, rootPath, dirPath)
    // name 也可能带路径分隔符（..\ 穿越）：显式边界断言 + 拼接结果完整校验，双保险
    // basename 取纯文件名（assertValidName 已禁分隔符，此处为语义等价的显式消毒）
    const target = path.join(dirPath, path.basename(name))
    assertInsideDir(dirPath, target)
    await requireRealInsideRoot(ctx, rootPath, target)
    // M2：已存在同名文件时拒绝（writeFile 会截断覆盖已有内容）
    if (await exists(target)) throw new Error('已存在同名文件，不会覆盖')
    await fs.writeFile(target, '', 'utf8')
  })

  ipc('fs:createFolder', async (_event, rootPath: string, dirPath: string, name: string) => {
    assertValidName(name, '文件夹')
    await requireRealInsideRoot(ctx, rootPath, dirPath)
    // basename 取纯文件名（assertValidName 已禁分隔符，此处为语义等价的显式消毒）
    const target = path.join(dirPath, path.basename(name))
    assertInsideDir(dirPath, target)
    await requireRealInsideRoot(ctx, rootPath, target)
    await fs.mkdir(target, { recursive: false })
  })

  ipc('fs:rename', async (_event, rootPath: string, oldPath: string, newPath: string) => {
    // LOW：重命名的新名字也走非法名校验（与新建一致，避免 CON/非法字符等到系统层才报错）
    assertValidName(path.basename(newPath), '文件')
    // LOW-3：链接条目重命名只改链接本身（不触碰目标内容），词法校验即可
    let isLinkEntry = false
    try {
      isLinkEntry = (await fs.lstat(oldPath)).isSymbolicLink()
    } catch {
      /* 目标不存在：交给后续校验报错 */
    }
    if (isLinkEntry) {
      requireInsideRoot(ctx, rootPath, oldPath)
      requireInsideRoot(ctx, rootPath, newPath)
      // B：目标父目录可能经 junction 指向根外——链接条目不能创建/移动到根外目录；
      // LOW-1：源侧父目录同样校验（根外目录里的链接条目不能被移走）
      await assertNoLinkEscape(rootPath, path.dirname(oldPath))
      await assertNoLinkEscape(rootPath, path.dirname(newPath))
    } else {
      await requireRealInsideRoot(ctx, rootPath, oldPath)
      await requireRealInsideRoot(ctx, rootPath, newPath)
    }
    // M2：目标已存在时拒绝（Windows rename 会静默覆盖，与「已存在不覆盖」原则一致）。
    // 纯大小写改名（a.txt → A.txt）在大小写不敏感文件系统上 exists(newPath) 会命中
    // oldPath 自身——比较 lstat 的 dev+ino：同一文件放行，不同文件（Linux 真实冲突）仍拒绝
    const caseOnly = path.resolve(oldPath).toLowerCase() === path.resolve(newPath).toLowerCase() && oldPath !== newPath
    let sameTarget = false
    if (caseOnly) {
      try {
        // C：优先用 realpath 判定——大小写不敏感文件系统上两个路径解析到同一真实路径
        // 即同一文件（网络盘 ino 恒 0 时 realpath 仍可靠）；realpath 不一致再用 ino 辅助
        const [ra, rb] = await Promise.all([fs.realpath(oldPath), fs.realpath(newPath)])
        if (ra.toLowerCase() === rb.toLowerCase()) {
          sameTarget = true
        } else {
          const [a, b] = await Promise.all([fs.lstat(oldPath), fs.lstat(newPath)])
          // ino 非零才可信（个别网络盘 nFileIndex 恒 0，0===0 会把不同文件误判为同一目标）
          sameTarget = a.dev === b.dev && a.ino !== 0 && a.ino === b.ino
        }
      } catch {
        // realpath 失败（个别 Windows 配置/网络盘）：退回 lstat dev+ino 兜底判定，
        // 避免纯大小写改名被误报「已存在同名文件」
        try {
          const [a, b] = await Promise.all([fs.lstat(oldPath), fs.lstat(newPath)])
          sameTarget = a.dev === b.dev && a.ino !== 0 && a.ino === b.ino
        } catch {
          /* newPath 不存在（正常改名）：非同一目标 */
        }
      }
    }
    if (!sameTarget && (await exists(newPath))) throw new Error('已存在同名文件/文件夹，不会覆盖')
    await fs.rename(oldPath, newPath)
  })

  ipc('fs:delete', async (_event, rootPath: string, targetPath: string) => {
    // LOW-3：符号链接/junction 条目本身可以删除（不触碰目标内容）——
    // 用 lstat 判定：链接条目只做词法校验；真实文件/目录走完整链接逃逸校验
    let isLinkEntry = false
    try {
      isLinkEntry = (await fs.lstat(targetPath)).isSymbolicLink()
    } catch {
      /* 目标不存在：交给后续校验报错 */
    }
    if (!isLinkEntry) await requireRealInsideRoot(ctx, rootPath, targetPath)
    else {
      requireInsideRoot(ctx, rootPath, targetPath)
      // B：父目录可能经 junction 指向根外——链接条目不能从根外目录删除
      await assertNoLinkEscape(rootPath, path.dirname(targetPath))
    }
    // 优先移入系统回收站；回收站失败时不静默永久删除，直接报错
    await ctx.shell.trashItem(targetPath)
  })

  ipc('image:readAsDataUrl', async (_event, rootPath: string, imagePath: string) => {
    return readMediaAsDataUrl(ctx, rootPath, imagePath, IMAGE_MIME)
  })

  // M6.5 音频预览：与图片同一套安全校验（限项目内 + 白名单 + 大小上限）
  ipc('media:readAsDataUrl', async (_event, rootPath: string, mediaPath: string) => {
    return readMediaAsDataUrl(ctx, rootPath, mediaPath, AUDIO_MIME)
  })
}
