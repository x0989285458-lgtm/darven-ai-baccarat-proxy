// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest'
import worker from './public/_worker.js'

afterEach(() => vi.unstubAllGlobals())
const env = { DARVEN_ORIGIN_SECRET: 'test-only-origin-secret' }

it.each([301, 302, 303, 307, 308])('blocks upstream redirect %s without exposing a downgrade destination', async status => {
  const upstream = vi.fn(async () => new Response(null, {
    status, headers: { Location: 'http://untrusted.example/api/login' },
  }))
  vi.stubGlobal('fetch', upstream)
  const response = await worker.fetch(new Request('https://site.example/api/login', {
    method: 'POST', body: 'test-only-login', headers: { Authorization: 'Bearer test-only-session' },
  }), env)
  expect(response.status).toBe(502)
  expect(response.headers.has('location')).toBe(false)
  expect(upstream).toHaveBeenCalledTimes(1)
  expect(upstream.mock.calls[0][1].redirect).toBe('manual')
})

it('fails closed on TLS/network error without HTTP fallback or sensitive diagnostics', async () => {
  const upstream = vi.fn(async () => { throw new Error('TLS error test-only-origin-secret') })
  vi.stubGlobal('fetch', upstream)
  const response = await worker.fetch(new Request('https://site.example/api/status'), env)
  expect(response.status).toBe(502)
  expect(await response.text()).not.toContain(env.DARVEN_ORIGIN_SECRET)
  expect(upstream).toHaveBeenCalledTimes(1)
  expect(upstream.mock.calls[0][0].protocol).toBe('https:')
})

it.each([undefined, '', '   '])('does not forward credentials with missing origin authentication (%s)', async secret => {
  const upstream = vi.fn()
  vi.stubGlobal('fetch', upstream)
  const response = await worker.fetch(new Request('https://site.example/api/login', {
    method: 'POST', body: 'test-only-login',
  }), { DARVEN_ORIGIN_SECRET: secret })
  expect(response.status).toBe(503)
  expect(upstream).not.toHaveBeenCalled()
})

it('rejects plaintext incoming API without forwarding the body', async () => {
  const upstream = vi.fn()
  vi.stubGlobal('fetch', upstream)
  const response = await worker.fetch(new Request('http://site.example/api/login', {
    method: 'POST', body: 'test-only-login',
  }), env)
  expect(response.status).toBe(426)
  expect(upstream).not.toHaveBeenCalled()
})

it('pins Host to the TLS origin instead of copying the incoming Pages virtual host', async () => {
  const upstream = vi.fn(async () => new Response('ok'))
  vi.stubGlobal('fetch', upstream)
  await worker.fetch(new Request('https://darven-ai-baccarat.pages.dev/api/status', {
    headers: { Host: 'darven-ai-baccarat.pages.dev' },
  }), env)
  const [url, options] = upstream.mock.calls[0]
  expect(options.headers.get('host')).toBe(url.host)
  expect(url.host).toBe('35.189.177.125.sslip.io')
})

it('preserves login/API body and authentication only on the fixed HTTPS origin', async () => {
  const upstream = vi.fn(async () => new Response('{}', { status: 401 }))
  vi.stubGlobal('fetch', upstream)
  const body = JSON.stringify({ username: 'transport-test', password: 'test-only-password' })
  const request = new Request('https://site.example/api/login?return=table', {
    method: 'POST', body, headers: {
      Authorization: 'Bearer test-only-session', 'Content-Type': 'application/json',
      'X-Darven-Edge-Secret': 'untrusted-input',
    },
  })
  const response = await worker.fetch(request, env)
  expect(response.status).toBe(401)
  const [url, options] = upstream.mock.calls[0]
  expect(String(url)).toBe('https://35.189.177.125.sslip.io/api/login?return=table')
  expect(options.headers.get('authorization')).toBe('Bearer test-only-session')
  expect(options.headers.get('x-darven-edge-secret')).toBe(env.DARVEN_ORIGIN_SECRET)
  expect(options.headers.get('content-type')).toBe('application/json')
  expect(await new Response(options.body).text()).toBe(body)
})
