/**
 * 设置 → AI：提供者选择、DeepSeek Key 保管（safeStorage 独立通道）、模型、连接测试、本地用量统计。
 * 从 SettingsModal 拆出（M39 巨型函数治理）。
 */
import { useEffect, useState } from 'react'
import { useWorkspaceStore } from '../../../stores/workspace'
import { getBridge } from '../../../services/bridge'
import { parseStoredUsage, summarizeUsage, type AiUsageSummary } from '../../ai/usageStats'

export function AiSettingsTab() {
  const settings = useWorkspaceStore((s) => s.settings)
  const updateSettings = useWorkspaceStore((s) => s.updateSettings)
  const notify = useWorkspaceStore((s) => s.notify)
  const [aiCheck, setAiCheck] = useState<string | null>(null)
  const [aiChecking, setAiChecking] = useState(false)
  // DeepSeek Key 只经独立通道保存/清除（本体进主进程 safeStorage，不进设置持久化）
  const [deepSeekKeyDraft, setDeepSeekKeyDraft] = useState('')
  const [deepSeekKeySaving, setDeepSeekKeySaving] = useState(false)
  // M23：本地 AI 用量统计
  const [usage, setUsage] = useState<AiUsageSummary | null>(null)

  // M23：进入页签时加载本地用量统计
  useEffect(() => {
    let alive = true
    void getBridge()
      .store.get('aiUsage')
      .then((raw) => alive && setUsage(summarizeUsage(parseStoredUsage(raw))))
      .catch(() => alive && setUsage({ totalCalls: 0, totalTokens: 0, todayCalls: 0, todayTokens: 0, weekCalls: 0, weekTokens: 0 }))
    return () => {
      alive = false
    }
  }, [])

  // 与主进程安全存储对账「已配置」标志：启动迁移可能已把旧明文 Key 搬入 safeStorage，
  // 持久化标志还是 false
  useEffect(() => {
    let alive = true
    getBridge()
      .ai.deepSeekKey.status()
      .then(({ configured }) => {
        if (!alive || configured === settings.ai.deepseekKeyConfigured) return
        updateSettings({ ai: { ...settings.ai, deepseekKeyConfigured: configured } })
      })
      .catch(() => undefined)
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /** 清空本地用量统计（不影响对话历史） */
  const clearUsage = async () => {
    try {
      await getBridge().store.set('aiUsage', [])
      setUsage({ totalCalls: 0, totalTokens: 0, todayCalls: 0, todayTokens: 0, weekCalls: 0, weekTokens: 0 })
      notify('本地 AI 用量统计已清空')
    } catch (err) {
      notify(`清空失败：${err instanceof Error ? err.message : String(err)}（统计记录保留）`)
    }
  }

  return (
    <div className="setting-section">
      <div className="setting-title">AI 助手</div>
      <div className="setting-row">
        <span className="label">
          AI 提供者
          <div className="desc">AI 对话当前仅支持 DeepSeek；社区服务器用于帖子和账号，不会自动作为 AI 提供者</div>
        </span>
        <div className="seg-group">
          <button className={settings.ai.provider === 'deepseek' ? 'active' : ''} onClick={() => updateSettings({ ai: { ...settings.ai, provider: 'deepseek' } })}>
            DeepSeek
          </button>
          <button
            className={settings.ai.provider === 'community' ? 'btn primary' : 'btn'}
            disabled={settings.ai.provider !== 'community'}
            title="社区服务器当前只提供社区内容 API，AI 对话尚未接入"
            onClick={() => updateSettings({ ai: { ...settings.ai, provider: 'deepseek' } })}
          >
            {settings.ai.provider === 'community' ? '切换回 DeepSeek' : '社区后端（AI 未接入）'}
          </button>
        </div>
      </div>

      {settings.ai.provider === 'deepseek' && (
        <>
          <div className="setting-row">
            <span className="label">
              API Key
              <div className="desc">
                {settings.ai.deepseekKeyConfigured
                  ? '已保存到系统安全存储（加密，不落明文文件）；输入新 Key 保存可覆盖'
                  : '在 platform.deepseek.com 获取，保存进系统安全存储（加密，不落明文文件）'}
              </div>
            </span>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <input
                type="password"
                style={{ width: 260 }}
                placeholder="sk-..."
                value={deepSeekKeyDraft}
                onChange={(e) => setDeepSeekKeyDraft(e.target.value)}
              />
              <button
                className="btn primary"
                disabled={!deepSeekKeyDraft.trim() || deepSeekKeySaving}
                onClick={async () => {
                  setDeepSeekKeySaving(true)
                  try {
                    await getBridge().ai.deepSeekKey.save(deepSeekKeyDraft)
                    updateSettings({ ai: { ...settings.ai, deepseekKeyConfigured: true } })
                    setDeepSeekKeyDraft('')
                    setAiCheck('✓ 密钥已保存到系统安全存储')
                  } catch (err) {
                    setAiCheck(`✗ ${err instanceof Error ? err.message : String(err)}`)
                  } finally {
                    setDeepSeekKeySaving(false)
                  }
                }}
              >
                {deepSeekKeySaving ? '保存中…' : '保存密钥'}
              </button>
              {settings.ai.deepseekKeyConfigured && (
                <button
                  className="btn"
                  onClick={async () => {
                    try {
                      await getBridge().ai.deepSeekKey.clear()
                      updateSettings({ ai: { ...settings.ai, deepseekKeyConfigured: false } })
                      setDeepSeekKeyDraft('')
                      setAiCheck(null)
                    } catch (err) {
                      setAiCheck(`✗ ${err instanceof Error ? err.message : String(err)}`)
                    }
                  }}
                >
                  清除密钥
                </button>
              )}
            </div>
          </div>
          <div className="setting-row">
            <span className="label">
              模型
              <div className="desc">v4-flash 便宜快速；v4-pro 更强（价格见 DeepSeek 官网）</div>
            </span>
            <select
              value={settings.ai.deepseekModel}
              onChange={(e) => updateSettings({ ai: { ...settings.ai, deepseekModel: e.target.value } })}
            >
              <option value="deepseek-v4-flash">deepseek-v4-flash（推荐）</option>
              <option value="deepseek-v4-pro">deepseek-v4-pro</option>
            </select>
          </div>
          <div className="setting-row">
            <span className="label">连接测试</span>
            <button
              className="btn"
              disabled={aiChecking}
              onClick={async () => {
                setAiChecking(true)
                setAiCheck(null)
                try {
                  const result = await getBridge().ai.check(settings.ai)
                  setAiCheck(result.ok ? `✓ ${result.message}` : `✗ ${result.message}`)
                } catch (err) {
                  setAiCheck(`✗ 测试失败：${err instanceof Error ? err.message : String(err)}`)
                } finally {
                  setAiChecking(false)
                }
              }}
            >
              {aiChecking ? '测试中…' : '测试连接'}
            </button>
            {aiCheck && <span style={{ fontSize: 12, color: aiCheck.startsWith('✓') ? 'var(--text-secondary)' : 'var(--danger)' }}>{aiCheck}</span>}
          </div>
        </>
      )}

      <div className="setting-divider" />
      <div className="setting-title">本地 AI 用量统计（M23）</div>
      <div className="desc" style={{ marginBottom: 8 }}>
        调用次数与 token 为估算值（字符数/4），仅保存在本机，供未来服务器阶段对接成本核算。
      </div>
      <div className="data-version-list">
        <div className="data-version-row"><span>今日</span><code>{usage ? `${usage.todayCalls} 次 · ${usage.todayTokens} token` : '…'}</code></div>
        <div className="data-version-row"><span>近 7 天</span><code>{usage ? `${usage.weekCalls} 次 · ${usage.weekTokens} token` : '…'}</code></div>
        <div className="data-version-row"><span>累计</span><code>{usage ? `${usage.totalCalls} 次 · ${usage.totalTokens} token` : '…'}</code></div>
      </div>
      <div className="setting-row">
        <span className="label">
          清空统计
          <div className="desc">删除本地全部用量记录（不影响对话历史）</div>
        </span>
        <button className="btn" onClick={() => void clearUsage()}>清空</button>
      </div>
    </div>
  )
}
