import { describe, expect, it } from 'vitest'
import { resolveDravenApiBaseUrl } from './apiBase'

describe('v038 cloud/local API base resolver', () => {
  it('uses local API by default for development fallback', () => {
    expect(resolveDravenApiBaseUrl({})).toBe('http://127.0.0.1:8787')
  })

  it('uses cloud API when VITE_DRAVEN_API_MODE is cloud', () => {
    expect(resolveDravenApiBaseUrl({
      VITE_DRAVEN_API_MODE: 'cloud',
      VITE_DRAVEN_CLOUD_API_URL: 'https://api.darvenai.example/',
      VITE_DRAVEN_LOCAL_API_URL: 'http://127.0.0.1:9999',
    })).toBe('https://api.darvenai.example')
  })

  it('keeps legacy VITE_DRAVEN_PROXY_API_URL as local compatibility', () => {
    expect(resolveDravenApiBaseUrl({
      VITE_DRAVEN_PROXY_API_URL: 'http://127.0.0.1:8788/',
    })).toBe('http://127.0.0.1:8788')
  })
})
