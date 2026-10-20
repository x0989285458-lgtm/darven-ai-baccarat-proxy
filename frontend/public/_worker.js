// Public Edge -> Origin must use certificate-verified HTTPS. Never fall back
// to HTTP; the origin's final nginx -> proxy hops remain on VM loopback only.
function unavailable(status) {
  return new Response('Upstream unavailable', {
    status,
    headers: { 'Cache-Control': 'no-store', 'Content-Type': 'text/plain; charset=utf-8' },
  })
}

export default {
  async fetch(request, env) {
    const incoming = new URL(request.url)
    if (incoming.pathname === '/health' || incoming.pathname.startsWith('/api/')) {
      if (incoming.protocol !== 'https:') return unavailable(426)
      if (typeof env.DARVEN_ORIGIN_SECRET !== 'string' || !env.DARVEN_ORIGIN_SECRET.trim()) {
        return unavailable(503)
      }
      const origin = new URL(`https://35.189.177.125.sslip.io${incoming.pathname}${incoming.search}`)
      const headers = new Headers(request.headers)
      headers.set('Host', origin.host)
      headers.set('X-Darven-Edge-Secret', env.DARVEN_ORIGIN_SECRET)
      headers.delete('cf-connecting-ip')
      headers.delete('x-forwarded-for')
      try {
        const response = await fetch(origin, {
          method: request.method,
          headers,
          body: request.method === 'GET' || request.method === 'HEAD' ? undefined : request.body,
          redirect: 'manual',
        })
        // Never propagate a redirect that could resend login/API credentials to
        // HTTP or an untrusted host. Ordinary errors and SSE pass through intact.
        if ([301, 302, 303, 307, 308].includes(response.status)) {
          if (response.body) await response.body.cancel()
          return unavailable(502)
        }
        return response
      } catch {
        return unavailable(502)
      }
    }
    return env.ASSETS.fetch(request)
  },
}
