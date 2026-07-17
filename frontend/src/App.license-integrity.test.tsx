import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import App from './App'

const okJson = (body: unknown) => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) }) as Promise<Response>

function setAdminSession() {
  window.history.pushState({}, '', '/admin')
  window.sessionStorage.setItem('darven-admin-account', 'dv1788-Raylo888')
  window.sessionStorage.setItem('darven-admin-role', 'manager')
  window.sessionStorage.setItem('darven-admin-session-token', 'admin-session')
}

function nonLicenseResponse(url: string) {
  if (url.includes('/api/status')) return okJson({ connected: true, authenticated: true, tables: [], buildVersion: 'v100' })
  if (url.includes('/api/cloud-data/status')) return okJson({ ok: true, todayRoundCount: 0, dailyReports: [], tableStats: [] })
  return okJson({ items: [], reports: [], strategies: [], strategyRows: [], weakTables: [], strongTables: [], watchTables: [], suggestions: [] })
}

describe('admin license integrity', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    vi.setSystemTime(new Date(2026, 6, 16, 12, 0, 0))
    window.sessionStorage.clear()
    setAdminSession()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    window.sessionStorage.clear()
  })

  it('previews the actual local current date and current date plus clamped duration', async () => {
    vi.stubGlobal('fetch', vi.fn((url: string) => url.includes('/api/online-license/status')
      ? okJson({ configured: true, managers: [], agents: [], plans: [], licenses: [], agentRows: [], licenseRows: [] })
      : nonLicenseResponse(url)))
    render(<App />)

    fireEvent.change(await screen.findByLabelText('方案天數'), { target: { value: '10' } })
    const panel = screen.getByLabelText('建立會員驗證密碼')
    expect(within(panel).getByText('2026/07/16')).toBeInTheDocument()
    expect(within(panel).getByText('2026/07/26')).toBeInTheDocument()
  })

  it('normalizes one prefix for serial lookup so sequential members get 001 and 002 and both remain listed', async () => {
    const licenseRows: Array<{ member: string; code: string; status: string; remain: string; agentCode: string }> = []
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes('/api/online-license/licenses') && init?.method === 'POST') {
        const body = JSON.parse(String(init.body))
        licenseRows.unshift({ member: body.memberAccount, code: body.code, status: '啟用中', remain: `${body.durationDays}天`, agentCode: body.agentCode })
        return { ok: true, status: 200, json: () => Promise.resolve({ ok: true, row: { code: body.code } }) } as Response
      }
      if (url.includes('/api/online-license/status')) return { ok: true, status: 200, json: () => Promise.resolve({ configured: true, managers: [], agents: [], plans: [], licenses: [], agentRows: [], licenseRows: [...licenseRows] }) } as Response
      return nonLicenseResponse(url)
    }))
    render(<App />)
    const memberInput = await screen.findByPlaceholderText('請輸入會員帳號')

    fireEvent.change(memberInput, { target: { value: 'MemberA' } })
    fireEvent.click(screen.getByRole('button', { name: '建立授權' }))
    await waitFor(() => expect(screen.getByText('dv8888_001')).toBeInTheDocument())
    fireEvent.change(memberInput, { target: { value: 'MemberB' } })
    fireEvent.click(screen.getByRole('button', { name: '建立授權' }))

    const list = screen.getByLabelText('已建立驗證碼')
    await waitFor(() => expect(within(list).getByText('dv8888_002')).toBeInTheDocument())
    expect(within(list).getByText('dv8888_001')).toBeInTheDocument()
    expect(within(list).getByText('MemberA')).toBeInTheDocument()
    expect(within(list).getByText('MemberB')).toBeInTheDocument()
  })

  it('rapid double click sends only one create while the request is pending', async () => {
    let resolveCreate!: (value: Response) => void
    const pendingCreate = new Promise<Response>((resolve) => { resolveCreate = resolve })
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (url.includes('/api/online-license/licenses') && init?.method === 'POST') return pendingCreate
      if (url.includes('/api/online-license/status')) return okJson({ configured: true, managers: [], agents: [], plans: [], licenses: [], agentRows: [], licenseRows: [] })
      return nonLicenseResponse(url)
    })
    vi.stubGlobal('fetch', fetchMock)
    render(<App />)
    const button = await screen.findByRole('button', { name: '建立授權' })

    fireEvent.click(button)
    fireEvent.click(button)
    expect(fetchMock.mock.calls.filter(([url, init]) => String(url).includes('/api/online-license/licenses') && init?.method === 'POST')).toHaveLength(1)
    expect(button).toBeDisabled()

    resolveCreate({ ok: true, status: 200, json: () => Promise.resolve({ ok: true, row: { code: 'dv8888_001' } }) } as Response)
    await waitFor(() => expect(button).not.toBeDisabled())
  })

  it('reserves an expired serial without displaying it and allocates the next code', async () => {
    let createdCode = ''
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes('/api/online-license/licenses') && init?.method === 'POST') {
        const body = JSON.parse(String(init.body))
        createdCode = body.code
        return { ok: true, status: 200, json: () => Promise.resolve({ ok: true, durationDays: body.durationDays, row: { code: body.code } }) } as Response
      }
      if (url.includes('/api/online-license/status')) return { ok: true, status: 200, json: () => Promise.resolve({
        configured: true, managers: [], agents: [], plans: [], licenses: [], agentRows: [],
        usedLicenseCodes: createdCode ? ['dv8888_001', createdCode] : ['dv8888_001'],
        licenseRows: createdCode ? [{ member: 'MemberB', code: createdCode, status: '啟用中', remain: '10天', agentCode: 'dv1788-Raylo888' }] : [],
      }) } as Response
      return nonLicenseResponse(url)
    }))
    render(<App />)
    const memberInput = await screen.findByPlaceholderText('請輸入會員帳號')
    fireEvent.change(memberInput, { target: { value: 'MemberB' } })
    fireEvent.click(screen.getByRole('button', { name: '建立授權' }))

    await waitFor(() => expect(createdCode).toBe('dv8888_002'))
    expect(screen.queryByText('dv8888_001')).not.toBeInTheDocument()
    expect(await screen.findByText('dv8888_002')).toBeInTheDocument()
  })
})
