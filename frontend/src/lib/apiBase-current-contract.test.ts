import { describe, expect, it } from 'vitest'
import { resolveDravenApiBaseUrl } from './apiBase'

describe('production API base contract', () => {
  it('fails closed instead of falling back to localhost when production configuration is missing', () => {
    expect(() => resolveDravenApiBaseUrl({ PROD: true })).toThrow(/production|正式|VITE_DRAVEN_CLOUD_API_URL/i)
  })

  it('accepts only an explicit HTTPS cloud API in production', () => {
    expect(() => resolveDravenApiBaseUrl({
      PROD: true,
      VITE_DRAVEN_API_MODE: 'cloud',
      VITE_DRAVEN_CLOUD_API_URL: 'http://api.darvenai.example',
    })).toThrow(/HTTPS/i)

    expect(resolveDravenApiBaseUrl({
      PROD: true,
      VITE_DRAVEN_API_MODE: 'cloud',
      VITE_DRAVEN_CLOUD_API_URL: 'https://api.darvenai.example/',
    })).toBe('https://api.darvenai.example')
  })
})
