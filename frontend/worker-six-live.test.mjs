// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest'
import worker from './public/_worker.js'
afterEach(() => vi.unstubAllGlobals())
it('forwards SSE unchanged to the current origin with a server-only secret', async () => {
  const response = new Response('data: live\n\n', { headers: { 'Content-Type': 'text/event-stream' } })
  const upstream = vi.fn(async () => response)
  vi.stubGlobal('fetch', upstream)
  const request = new Request('https://darven-ai-baccarat.pages.dev/api/events?cursor=abc', { headers: { Authorization: 'Bearer test-session', 'cf-connecting-ip': 'test', 'x-forwarded-for': 'test' } })
  expect(await worker.fetch(request, { DARVEN_ORIGIN_SECRET: 'test-only-sentinel' })).toBe(response)
  const [url, options] = upstream.mock.calls[0]
  expect(String(url)).toBe('https://35.189.177.125.sslip.io/api/events?cursor=abc')
  expect(options.headers.get('X-Darven-Edge-Secret')).toBe('test-only-sentinel')
  expect(options.headers.get('Authorization')).toBe('Bearer test-session')
  expect(options.headers.has('cf-connecting-ip')).toBe(false)
  expect(options.headers.has('x-forwarded-for')).toBe(false)
  expect(options.redirect).toBe('manual')
  expect(options.body).toBeUndefined()
})
it('preserves POST bodies, health and static asset delegation', async () => {
  const upstream = vi.fn(async () => new Response('ok'))
  vi.stubGlobal('fetch', upstream)
  const request = new Request('https://darven-ai-baccarat.pages.dev/api/login', { method: 'POST', body: 'payload' })
  await worker.fetch(request, { DARVEN_ORIGIN_SECRET: 'test-only-sentinel' })
  expect(upstream.mock.calls[0][1].method).toBe('POST')
  expect(upstream.mock.calls[0][1].body).toBe(request.body)
  await worker.fetch(new Request('https://darven-ai-baccarat.pages.dev/health'), { DARVEN_ORIGIN_SECRET: 'test-only-sentinel' })
  expect(String(upstream.mock.calls[1][0])).toBe('https://35.189.177.125.sslip.io/health')
  const assets = { fetch: vi.fn(async () => new Response('asset')) }
  const asset = new Request('https://darven-ai-baccarat.pages.dev/login')
  await worker.fetch(asset, { ASSETS: assets })
  expect(assets.fetch).toHaveBeenCalledWith(asset)
  expect(upstream).toHaveBeenCalledTimes(2)
})
