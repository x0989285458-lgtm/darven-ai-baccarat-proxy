import { describe, expect, it, vi } from 'vitest'
import { agentLogin, createOnlineLicense, deleteOnlineLicense, extendOnlineLicense, getOnlineLicenseStatus, memberLogin, setOnlineLicenseStatus } from './onlineLicenseClient'

describe('onlineLicenseClient v030', () => {
  it('posts member login using memberAccount and verificationPassword', async () => {
    const fetchImpl = vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true }) })) as unknown as typeof fetch
    const result = await memberLogin({ memberAccount: 'User001', verificationPassword: 'DVAI1788_001' }, fetchImpl)
    expect(result.ok).toBe(true)
    expect(fetchImpl).toHaveBeenCalledWith('http://127.0.0.1:8787/api/online-license/member-login', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ memberAccount: 'User001', verificationPassword: 'DVAI1788_001' }),
    }))
  })

  it('posts agent login using agentAccount only', async () => {
    const fetchImpl = vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true, account: { permission: 'all' } }) })) as unknown as typeof fetch
    const result = await agentLogin({ agentAccount: 'DV1788' }, fetchImpl)
    expect(result.account?.permission).toBe('all')
    expect(fetchImpl).toHaveBeenCalledWith('http://127.0.0.1:8787/api/online-license/agent-login', expect.objectContaining({
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
    const result = await createOnlineLicense({ code: 'DVAI0888_015', agentCode: 'DVAI', durationDays: 30 }, fetchImpl)
    expect(result.row?.code).toBe('DVAI0888_015')
    expect(fetchImpl).toHaveBeenCalledWith('http://127.0.0.1:8787/api/online-license/licenses', expect.objectContaining({ method: 'POST' }))
  })

  it('v031 posts suspend extend and delete license operations with DV1788 admin permission', async () => {
    const fetchImpl = vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true, row: { code: 'DVAI1788_001' } }) })) as unknown as typeof fetch
    await setOnlineLicenseStatus({ code: 'DVAI1788_001', status: 'suspended' }, fetchImpl)
    await extendOnlineLicense({ code: 'DVAI1788_001', days: 15 }, fetchImpl)
    await deleteOnlineLicense({ code: 'DVAI1788_001' }, fetchImpl)
    expect(fetchImpl).toHaveBeenNthCalledWith(1, 'http://127.0.0.1:8787/api/online-license/licenses/status', expect.objectContaining({ method: 'POST' }))
    expect(fetchImpl).toHaveBeenNthCalledWith(2, 'http://127.0.0.1:8787/api/online-license/licenses/extend', expect.objectContaining({ method: 'POST' }))
    expect(fetchImpl).toHaveBeenNthCalledWith(3, 'http://127.0.0.1:8787/api/online-license/licenses/delete', expect.objectContaining({ method: 'POST' }))
    expect(JSON.parse((fetchImpl as any).mock.calls[0][1].body)).toEqual({ adminAccount: 'DV1788', code: 'DVAI1788_001', status: 'suspended' })
    expect(JSON.parse((fetchImpl as any).mock.calls[1][1].body)).toEqual({ adminAccount: 'DV1788', code: 'DVAI1788_001', days: 15 })
    expect(JSON.parse((fetchImpl as any).mock.calls[2][1].body)).toEqual({ adminAccount: 'DV1788', code: 'DVAI1788_001' })
  })
})
