export default {
  async fetch(request, env) {
    const incoming = new URL(request.url)
    if (incoming.pathname === '/health' || incoming.pathname.startsWith('/api/')) {
      const origin = new URL(`http://104.155.237.57.sslip.io${incoming.pathname}${incoming.search}`)
      const headers = new Headers(request.headers)
      headers.set('X-Darven-Edge-Secret', env.DARVEN_ORIGIN_SECRET)
      headers.delete('cf-connecting-ip')
      headers.delete('x-forwarded-for')
      return fetch(origin, {
        method: request.method,
        headers,
        body: request.method === 'GET' || request.method === 'HEAD' ? undefined : request.body,
        redirect: 'manual',
      })
    }
    return env.ASSETS.fetch(request)
  },
}
