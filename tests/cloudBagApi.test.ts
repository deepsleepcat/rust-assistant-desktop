/**
 * 云书包 API 客户端回归（桌面契约 §7.1/§8/§10）：
 * - 请求 URL/method/body 符合后端契约 §3（端点族 /api/community/cloudbag/**）
 * - 信封按 HTTP 200 + success:false + code 分支（J3：不看 HTTP 状态码）
 * - version_conflict 携带 head 摘要；幂等重放走 success:true + data.sync.replay（非错误码）
 * - blob 上传 multipart 形状（sha256 + session_id 表单字段 + file 后置）
 * - 导出下载：大小上限 + 安全文件名
 * 全部注入假 fetch，不触网。
 */
import { describe, expect, it, vi } from 'vitest'
import {
  CloudBagApiError,
  createCloudBagApi,
  describeCloudBagCode,
} from '../src/services/cloudBagApi'

const ENDPOINT = 'https://xn--gmqtc392bzw0a.xn--6qq986b3xl'

function envelope(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function ok(data: unknown): Response {
  return envelope({ success: true, message: '', data })
}

function fail(code: string, data: unknown = null): Response {
  return envelope({ success: false, message: '', data, code })
}

describe('cloudBagApi 请求形状', () => {
  it('仓库列表走 mine/q/page 查询参数，认证意图标记（不带本地令牌）', async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input))
      expect(url.pathname).toBe('/api/community/cloudbag/repos')
      expect(url.searchParams.get('mine')).toBe('1')
      expect(url.searchParams.get('q')).toBe('坦克')
      expect(url.searchParams.get('page')).toBe('2')
      expect((init as { authenticated?: boolean } | undefined)?.authenticated).toBe(true)
      expect(new Headers(init?.headers).has('Authorization')).toBe(false)
      return ok({ items: [], total: 0 })
    })
    const api = createCloudBagApi(ENDPOINT, fetcher)
    await api.repos({ mine: true, q: '坦克', page: 2 })
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('创建仓库 POST body 符合契约（title/slug/visibility/tags；后端只认 slug）', async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(new URL(String(input)).pathname).toBe('/api/community/cloudbag/repos')
      expect(init?.method).toBe('POST')
      // 键名必须是后端 cloudBagRepoRequest 认识的 slug；slug_suggestion 会被
      // encoding/json 静默忽略（用户填的标识永不生效）。
      expect(JSON.parse(String(init?.body))).toEqual({
        title: '铁幕重坦',
        slug: 'iron-curtain',
        description: '',
        visibility: 'private',
        tags: ['陆军'],
      })
      return ok({ repo: { id: 1, slug: 'iron-curtain', title: '铁幕重坦', quota: { usedBytes: 0, limitBytes: 0 }, tags: ['陆军'] } })
    })
    const repo = await createCloudBagApi(ENDPOINT, fetcher).createRepo({
      title: '铁幕重坦', slugSuggestion: 'iron-curtain', visibility: 'private', tags: ['陆军'],
    })
    expect(repo.slug).toBe('iron-curtain')
  })

  it('版本推送 POST body 带 base_version_no/message/client_op_id/files，可带 restore_from', async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input))
      expect(url.pathname).toBe('/api/community/cloudbag/repos/iron-curtain/versions')
      expect(JSON.parse(String(init?.body))).toEqual({
        base_version_no: 3,
        message: 'revert of #2',
        client_op_id: 'op-1',
        files: [],
        restore_from: 2,
      })
      // 后端成功/重放信封：data = {sync:{resultVersionNo}}（契约 §3.3）
      return ok({ sync: { clientOpId: 'op-1', status: 'applied', resultVersionNo: 4, replay: false } })
    })
    const result = await createCloudBagApi(ENDPOINT, fetcher).pushVersion('iron-curtain', {
      baseVersionNo: 3, message: 'revert of #2', clientOpId: 'op-1', files: [], restoreFrom: 2,
    })
    expect(result.versionNo).toBe(4)
  })

  it('仓库详情/版本详情展开 data.repo、data.version；差异展开 data.items', async () => {
    const api = createCloudBagApi(ENDPOINT, vi.fn(async (input: RequestInfo | URL) => {
      const path = new URL(String(input)).pathname
      if (path.endsWith('/versions/3/diff')) return ok({ items: [{ path: 'a.ini', change: 'removed' }], from: 2, to: 3 })
      if (path.endsWith('/versions/3')) return ok({ version: { id: 1, versionNo: 3, message: 'm' } })
      return ok({ repo: { id: 1, slug: 'iron-curtain', title: '铁幕', headVersionNo: 3, myRole: 'owner' } })
    }))
    const repo = await api.repo('iron-curtain')
    expect(repo.title).toBe('铁幕')
    expect(repo.headVersionNo).toBe(3)
    const version = await api.version('iron-curtain', 3)
    expect(version.versionNo).toBe(3)
    const diff = await api.diff('iron-curtain', 3, 2)
    expect(Array.isArray(diff)).toBe(true)
    expect(diff[0]).toMatchObject({ path: 'a.ini', change: 'removed' })
  })

  it('开同步会话读后端 sessionId（cloudbag_object.go 字段名），暴露为 id', async () => {
    const fetcher = vi.fn(async () => ok({ sessionId: 'tok-1', status: 'open', files: [] }))
    const session = await createCloudBagApi(ENDPOINT, fetcher).openSession('iron-curtain', { opType: 'push', baseVersionNo: 1, files: [] })
    expect(session.id).toBe('tok-1')
  })

  it('blob 上传为 multipart：session_id/sha256 表单字段 + file 最后追加', async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input))
      expect(url.pathname).toBe('/api/community/cloudbag/repos/iron-curtain/blobs')
      expect(init?.method).toBe('POST')
      const form = init?.body
      expect(form).toBeInstanceOf(FormData)
      const fd = form as FormData
      expect(fd.get('session_id')).toBe('sess-1')
      expect(fd.get('sha256')).toBe('a'.repeat(64))
      const file = fd.get('file')
      expect(file).toBeInstanceOf(File)
      expect((file as File).name).toBe('units/tank.ini'.split('/').pop())
      return ok(null)
    })
    await createCloudBagApi(ENDPOINT, fetcher).uploadBlob('iron-curtain', {
      sessionId: 'sess-1',
      path: 'units/tank.ini',
      sha256: 'a'.repeat(64),
      bytes: new TextEncoder().encode('[core]').buffer as ArrayBuffer,
      fileName: 'tank.ini',
      contentType: 'application/octet-stream',
    })
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('路径参数做入参防御：非法 slug/版本号不发出请求', async () => {
    const fetcher = vi.fn(async () => ok(null))
    const api = createCloudBagApi(ENDPOINT, fetcher)
    await expect(api.repo('../evil')).rejects.toThrow('标识不合法')
    await expect(api.version('ok-slug', -1)).rejects.toThrow('版本号不合法')
    expect(fetcher).not.toHaveBeenCalled()
  })
})

describe('cloudBagApi 信封与 code 分支（J3）', () => {
  it('业务错误 HTTP 200 + success:false + code：映射为用户文案并携带 code', async () => {
    const fetcher = vi.fn(async () => fail('quota_exceeded', { usedBytes: 100, limitBytes: 100 }))
    const api = createCloudBagApi(ENDPOINT, fetcher)
    await expect(api.repo('a')).rejects.toMatchObject({ kind: 'quota_exceeded', message: describeCloudBagCode('quota_exceeded') })
  })

  it('version_conflict：错误对象携带服务端 head 摘要，文案与 code 一致', async () => {
    // 后端 headSummary 是对象（cloudbag_version.go 的 headSummary，契约 §7.1）：
    // 类型声明若保持扁平数组，客户端读 headSummary.files 会 undefined
    const head = {
      headVersionNo: 5,
      headSummary: {
        versionNo: 5, message: '远端版本', fileCount: 1, totalSize: 12,
        files: [{ path: 'units/tank.ini', sha256: 'b'.repeat(64) }],
      },
    }
    const fetcher = vi.fn(async () => fail('version_conflict', head))
    const api = createCloudBagApi(ENDPOINT, fetcher)
    const err = await api.pushVersion('a', { baseVersionNo: 3, message: 'x', clientOpId: 'op', files: [] }).catch((e: unknown) => e) as CloudBagApiError
    expect(err).toBeInstanceOf(CloudBagApiError)
    expect(err.kind).toBe('version_conflict')
    expect(err.conflict).toEqual(head)
    expect(err.message).toBe('远端已有新版本，请先查看差异再选择合并方式')
  })

  it('幂等重放：服务端 success:true + data.sync.replay（不是错误码），同 client_op_id 结果同形', async () => {
    let calls = 0
    const fetcher = vi.fn(async () => {
      calls++
      return ok({ sync: { clientOpId: 'same', status: 'applied', resultVersionNo: 7, replay: calls > 1 } })
    })
    const api = createCloudBagApi(ENDPOINT, fetcher)
    await expect(api.pushVersion('a', { baseVersionNo: 6, message: 'm', clientOpId: 'same', files: [] })).resolves.toEqual({ versionNo: 7 })
    await expect(api.pushVersion('a', { baseVersionNo: 6, message: 'm', clientOpId: 'same', files: [] })).resolves.toEqual({ versionNo: 7 })
    expect(calls).toBe(2)
  })

  it('网络层错误（fetch 抛错）统一为「连接社区服务器失败」，绝不显示为成功', async () => {
    const fetcher = vi.fn(async () => { throw new TypeError('network down') })
    const api = createCloudBagApi(ENDPOINT, fetcher)
    await expect(api.repos()).rejects.toMatchObject({ kind: 'network', message: '连接社区服务器失败，请检查网络后重试' })
  })

  it('§8 文案映射逐字覆盖', () => {
    expect(describeCloudBagCode('version_conflict')).toBe('远端已有新版本，请先查看差异再选择合并方式')
    expect(describeCloudBagCode('file_too_large')).toBe('单文件超过 50 MiB，本轮不支持更大文件')
    expect(describeCloudBagCode('forbidden')).toBe('你在该仓库没有执行此操作的权限')
    expect(describeCloudBagCode('not_found')).toBe('仓库或版本不存在')
    expect(describeCloudBagCode('unknown_code')).toBe('云书包操作失败')
  })
})

describe('cloudBagApi 导出下载', () => {
  it('导出 .rwmod：解析 filename* 头并清洗安全文件名', async () => {
    const fetcher = vi.fn(async () => new Response(new Uint8Array([1, 2, 3]).buffer, {
      status: 200,
      headers: { 'content-disposition': "attachment; filename*=UTF-8''%E9%93%81%E5%B9%95-v3.rwmod" },
    }))
    const download = await createCloudBagApi(ENDPOINT, fetcher).exportRwmod('iron-curtain', 3)
    const firstCall = (fetcher.mock.calls as unknown[][])[0]
    expect(new URL(String(firstCall[0])).pathname).toBe('/api/community/cloudbag/repos/iron-curtain/versions/3/export.rwmod')
    expect(download.filename).toBe('铁幕-v3.rwmod')
    expect(download.bytes.byteLength).toBe(3)
  })

  it('畸形 percent 编码的 filename* 回退到确定性文件名，且不冒充网络故障', async () => {
    // 服务端返回截断的 percent 序列（%E4%B8）：decodeURIComponent 抛 URIError，
    // 旧实现把它归入 catch 的 kind:'network'「连接社区服务器失败，请检查网络后重试」，
    // 用户被指向错误的排查方向（实际是响应头格式问题）
    const fetcher = vi.fn(async () => new Response(new Uint8Array([1]).buffer, {
      status: 200,
      headers: { 'content-disposition': "attachment; filename*=UTF-8''%E4%B8" },
    }))
    const download = await createCloudBagApi(ENDPOINT, fetcher).exportRwmod('iron-curtain', 3)
    expect(download.filename).toBe('iron-curtain-v3.rwmod')
    expect(download.bytes.byteLength).toBe(1)
  })

  it('非 2xx 且响应体不是 JSON：报导出失败（http），不报网络故障', async () => {
    const fetcher = vi.fn(async () => new Response('<html>502</html>', { status: 502, headers: { 'content-type': 'text/html' } }))
    const err = await createCloudBagApi(ENDPOINT, fetcher).exportRwmod('iron-curtain', 3).catch((e: unknown) => e) as CloudBagApiError
    expect(err).toBeInstanceOf(CloudBagApiError)
    expect(err.kind).toBe('http')
    expect(err.status).toBe(502)
  })
})

describe('cloudBagApi 超时分类（上传与 JSON 分开）', () => {
  it('blob 上传按字节数放宽时限：50MiB 不再套用 15s 的 JSON 超时', async () => {
    vi.useFakeTimers()
    try {
      let aborted = false
      const fetcher = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => { aborted = true; reject(new DOMException('Aborted', 'AbortError')) })
      }))
      const api = createCloudBagApi(ENDPOINT, fetcher as unknown as typeof fetch)
      const bytes = new ArrayBuffer(50 * 1024 * 1024)
      const pending = api.uploadBlob('iron-curtain', { sessionId: 's', path: 'units/a.ogg', sha256: 'a'.repeat(64), bytes, fileName: 'a.ogg', contentType: 'application/octet-stream' }).catch((e: unknown) => e)
      // 15s（旧 JSON 时限）早已过去：不得中止
      await vi.advanceTimersByTimeAsync(15_000)
      expect(aborted).toBe(false)
      await vi.advanceTimersByTimeAsync(60_000)
      expect(aborted).toBe(false)
      // 到达按字节数放宽后的上限才中止，且分类为 timeout（不是 network，不触发整包重发）
      await vi.advanceTimersByTimeAsync(200_000)
      const err = await pending as CloudBagApiError
      expect(aborted).toBe(true)
      expect(err).toBeInstanceOf(CloudBagApiError)
      expect(err.kind).toBe('timeout')
      expect(err.message).toContain('上传超时')
    } finally {
      vi.useRealTimers()
    }
  })

  it('普通 JSON 请求仍是 15s 超时，文案与上传区分', async () => {
    vi.useFakeTimers()
    try {
      const fetcher = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))
      }))
      const api = createCloudBagApi(ENDPOINT, fetcher as unknown as typeof fetch)
      const pending = api.repo('iron-curtain').catch((e: unknown) => e)
      await vi.advanceTimersByTimeAsync(15_000)
      const err = await pending as CloudBagApiError
      expect(err.kind).toBe('timeout')
      expect(err.message).toBe('社区服务器请求超时')
    } finally {
      vi.useRealTimers()
    }
  })
})
