import { describe, expect, it } from 'vitest'
import { buildVersionRefreshUrl, frontendBuildMetadata } from './buildVersion'

describe('v100 unified frontend build metadata', () => {
  it('exposes one v100 product and strategy identity', () => {
    expect(frontendBuildMetadata).toEqual({
      buildVersion: 'v104',
      strategyVersion: 'v104',
    })
  })

  it('builds one cache-busting reload URL when the backend build differs', () => {
    expect(buildVersionRefreshUrl('https://darven-ai-baccarat.pages.dev/?table=BAG01#live', 'v102', 'v104', null))
      .toBe('https://darven-ai-baccarat.pages.dev/?table=BAG01&frontendBuild=v104#live')
    expect(buildVersionRefreshUrl('https://darven-ai-baccarat.pages.dev/', 'v102', 'v104', 'v104')).toBeNull()
    expect(buildVersionRefreshUrl('https://darven-ai-baccarat.pages.dev/', 'v104', 'v104', null)).toBeNull()
  })
})
