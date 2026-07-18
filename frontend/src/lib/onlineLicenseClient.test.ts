import { describe, expect, it, vi } from 'vitest'
import { agentLogin, createOnlineLicense, deleteOnlineLicense, extendOnlineLicense, getOnlineLicenseStatus, memberLogin, setOnlineLicenseStatus, validateMemberSession } from './onlineLicenseClient'

describe('onlineLicenseClient ', () => {
  it('posts member login using memberAccount and verificationPassword', async () => {
    const fetchImpl = vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true }) })) as unknown as typeof fetch
    const result = await memberLogin({ memberAccount: 'User001', verificationPassword: 'DVAI1788_001' }, fetchImpl)
    expect(result.ok).toBe(true)
    expect(String((fetchImpl as any).mock.calls[0][0])).toContain('/api/online-license/member-login')
    expect((fetchImpl as any).mock.calls[0][1]).toEqual(expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ memberAccount: 'User001', verificationPassword: 'DVAI1788_001' }),
    }))
  })

  it('validates the short-lived member session through the backend bearer token flow', async () => {
    const fetchImpl = vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true, sessionExpiresAt: '2026-07-13T20:30:00.000Z' }) })) as unknown as typeof fetch
    const result = await validateMemberSession('member-session-1', fetchImpl)

    expect(result.ok).toBe(true)
    expect(String((fetchImpl as any).mock.calls[0][0])).toContain('/api/online-license/member-session')
    expect((fetchImpl as any).mock.calls[0][1]).toEqual(expect.objectContaining({
      method: 'POST',
      headers: expect.objectContaining({ Authorization: 'Bearer member-session-1' }),
    }))
  })

  it('posts agent login using agentAccount only', async () => {
    const fetchImpl = vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true, account: { permission: 'all' } }) })) as unknown as typeof fetch
    const result = await agentLogin({ agentAccount: 'DV1788' }, fetchImpl)
    expect(result.account?.permission).toBe('all')
    expect(String((fetchImpl as any).mock.calls[0][0])).toContain('/api/online-license/agent-login')
    expect((fetchImpl as any).mock.calls[0][1]).toEqual(expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ agentAccount: 'DV1788' }),
    }))
  })

  it('maps online license status into display rows', async () => {
    const fetchImpl = vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve({
      managers: [{ username: 'DV1788', role: 'total', is_active: true }],
      agents: [{ code: 'DVAI', name: 'DV1788超級代理' }],
      plans: [{ name: '正式月卡', duration_days: 30 }],
      licenses: [{ code: 'DVAI1788_001', status: 'active', agent_code: 'DVAI', plan_name: '正式月卡', expires_on: '2026-07-29' }],
    }) })) as unknown as typeof fetch
    const status = await getOnlineLicenseStatus(fetchImpl)
    expect(status.managers[0].username).toBe('DV1788')
    expect(status.agentRows[0].account).toBe('DVAI')
    expect(status.licenseRows[0].code).toBe('DVAI1788_001')
    expect(status.licenseRows[0].status).toBe('啟用中')
  })

  it('creates online license through backend API', async () => {
    const fetchImpl = vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true, row: { code: 'DVAI0888_015' } }) })) as unknown as typeof fetch
    const result = await createOnlineLicense({ memberAccount: 'User0888', code: 'DVAI0888_015', agentCode: 'DVAI', durationDays: 30, adminSessionToken: 'session-1' }, fetchImpl)
    expect(result.row?.code).toBe('DVAI0888_015')
    expect(String((fetchImpl as any).mock.calls[0][0])).toContain('/api/online-license/licenses')
    expect((fetchImpl as any).mock.calls[0][1]).toEqual(expect.objectContaining({ method: 'POST' }))
  })

  it('posts suspend extend and delete license operations with DV1788 admin permission', async () => {
    const fetchImpl = vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true, row: { code: 'DVAI1788_001' } }) })) as unknown as typeof fetch
    await setOnlineLicenseStatus({ code: 'DVAI1788_001', status: 'suspended', adminSessionToken: 'session-1' }, fetchImpl)
    await extendOnlineLicense({ code: 'DVAI1788_001', days: 15, adminSessionToken: 'session-1' }, fetchImpl)
    await deleteOnlineLicense({ code: 'DVAI1788_001', adminSessionToken: 'session-1' }, fetchImpl)
    expect(String((fetchImpl as any).mock.calls[0][0])).toContain('/api/online-license/licenses/status')
    expect(String((fetchImpl as any).mock.calls[1][0])).toContain('/api/online-license/licenses/extend')
    expect(String((fetchImpl as any).mock.calls[2][0])).toContain('/api/online-license/licenses/delete')
    expect((fetchImpl as any).mock.calls[0][1]).toEqual(expect.objectContaining({ method: 'POST' }))
    expect((fetchImpl as any).mock.calls[1][1]).toEqual(expect.objectContaining({ method: 'POST' }))
    expect((fetchImpl as any).mock.calls[2][1]).toEqual(expect.objectContaining({ method: 'POST' }))
    expect(JSON.parse((fetchImpl as any).mock.calls[0][1].body)).toEqual({ adminSessionToken: 'session-1', code: 'DVAI1788_001', status: 'suspended' })
    expect(JSON.parse((fetchImpl as any).mock.calls[1][1].body)).toEqual({ adminSessionToken: 'session-1', code: 'DVAI1788_001', days: 15 })
    expect(JSON.parse((fetchImpl as any).mock.calls[2][1].body)).toEqual({ adminSessionToken: 'session-1', code: 'DVAI1788_001' })
  })
})
