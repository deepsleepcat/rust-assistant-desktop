/**
 * 设置 → 社区：服务器连接测试、浏览器设备配对登录、邮箱认证、退出。
 * 从 SettingsModal 拆出（M39 巨型函数治理）；认证状态来自工作区 store 的 communityAuth。
 */
import { useState } from 'react'
import { useWorkspaceStore } from '../../../stores/workspace'
import { createCommunityApi } from '../../../services/communityApi'

export function CommunitySettingsTab() {
  const settings = useWorkspaceStore((s) => s.settings)
  const communityAuth = useWorkspaceStore((s) => s.communityAuth)
  const loginCommunity = useWorkspaceStore((s) => s.loginCommunity)
  const checkCommunityPairing = useWorkspaceStore((s) => s.checkCommunityPairing)
  const cancelCommunityPairing = useWorkspaceStore((s) => s.cancelCommunityPairing)
  const logoutCommunity = useWorkspaceStore((s) => s.logoutCommunity)
  const [communityCheck, setCommunityCheck] = useState<string | null>(null)
  const [communityChecking, setCommunityChecking] = useState(false)
  const communityUser = communityAuth.user
  const [communityEmail, setCommunityEmail] = useState('')
  const [communityVerificationCode, setCommunityVerificationCode] = useState('')
  const [communityVerificationBusy, setCommunityVerificationBusy] = useState(false)
  const [communityBindingBusy, setCommunityBindingBusy] = useState(false)

  // 社区页签错误直接派生显示（communityCheck 为操作反馈，communityAuth.error 为认证错误）
  const communityError = communityCheck ?? (communityAuth.status === 'error' ? communityAuth.error : null)

  const requestCommunityVerification = async () => {
    setCommunityVerificationBusy(true)
    setCommunityCheck(null)
    try {
      await createCommunityApi(settings.ai.communityEndpoint).requestVerification(communityEmail.trim())
      setCommunityCheck('✓ 验证码已发送，请查收邮箱')
    } catch (err) {
      setCommunityCheck(`✗ ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setCommunityVerificationBusy(false)
    }
  }

  const bindCommunityEmail = async () => {
    if (communityAuth.status !== 'signed_in') return
    setCommunityBindingBusy(true)
    setCommunityCheck(null)
    try {
      const user = await createCommunityApi(settings.ai.communityEndpoint).bindEmail(communityEmail.trim(), communityVerificationCode.trim())
      useWorkspaceStore.setState({ communityAuth: { status: 'signed_in', user, error: null, pairing: null } })
      setCommunityVerificationCode('')
      setCommunityCheck('✓ 邮箱认证完成')
    } catch (err) {
      setCommunityCheck(`✗ ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setCommunityBindingBusy(false)
    }
  }

  return (
    <div className="setting-section">
      <div className="setting-title">社区账号</div>
      <div className="setting-row">
        <span className="label">服务器连接</span>
        <button
          className="btn"
          disabled={communityChecking}
          onClick={async () => {
            setCommunityChecking(true)
            setCommunityCheck(null)
            try {
              const result = await createCommunityApi(settings.ai.communityEndpoint).health()
              setCommunityCheck(`✓ 在线 · ${result.version ?? '未知版本'}`)
            } catch (err) {
              setCommunityCheck(`✗ ${err instanceof Error ? err.message : String(err)}`)
            } finally {
              setCommunityChecking(false)
            }
          }}
        >
          {communityChecking ? '测试中…' : '测试连接'}
        </button>
        {communityError && <span style={{ fontSize: 12, color: communityError.startsWith('✓') ? 'var(--text-secondary)' : 'var(--danger)' }}>{communityError}</span>}
      </div>
      <div className="setting-row community-auth-row">
        <span className="label">
          浏览器登录
          <div className="desc">登录页面将在浏览器中打开，应用不会接收或保存密码。</div>
        </span>
        {communityAuth.status !== 'loading' && <button className="btn primary" onClick={() => void loginCommunity()}>
          {communityAuth.status === 'signed_in' ? '重新登录' : '在浏览器中登录'}
        </button>}
        {communityAuth.status === 'loading' && communityAuth.pairing && <>
          <code>配对码：{communityAuth.pairing.userCode}</code>
          <button className="btn primary" onClick={() => void checkCommunityPairing()}>手动检查</button>
          <button className="btn" onClick={() => void cancelCommunityPairing()}>取消配对</button>
        </>}
        {communityAuth.status === 'error' && <span className="setting-error-inline">{communityAuth.error}</span>}
      </div>
      {communityUser && <div className="local-note">当前账号：{communityUser.display_name ?? communityUser.username} · 会话已安全保存在本机</div>}
      {communityUser && communityUser.email_verified === false && <div className="setting-row community-auth-row">
        <span className="label">
          完成邮箱认证
          <div className="desc">服务器要求邮箱认证时，认证后才能发布、评论、点赞和关注</div>
        </span>
        <input aria-label="认证邮箱" type="email" value={communityEmail} onChange={(e) => setCommunityEmail(e.target.value)} placeholder="邮箱" style={{ width: 180 }} />
        <input aria-label="认证邮箱验证码" value={communityVerificationCode} onChange={(e) => setCommunityVerificationCode(e.target.value)} placeholder="邮箱验证码" style={{ width: 140 }} />
        <button className="btn" disabled={communityVerificationBusy || !communityEmail.trim()} onClick={() => void requestCommunityVerification()}>{communityVerificationBusy ? '发送中…' : '发送验证码'}</button>
        <button className="btn primary" disabled={communityBindingBusy || !communityEmail.trim() || !communityVerificationCode.trim()} onClick={() => void bindCommunityEmail()}>{communityBindingBusy ? '认证中…' : '完成认证'}</button>
      </div>}
      {communityAuth.status === 'signed_in' && <div className="setting-row"><span className="label">退出社区账号</span><button className="btn" onClick={() => {
        void logoutCommunity().then(() => setCommunityCheck('已退出社区账号'))
      }}>退出登录</button></div>}
    </div>
  )
}
