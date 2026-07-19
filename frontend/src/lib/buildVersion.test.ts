import { describe, expect, it } from 'vitest'
import { frontendBuildMetadata } from './buildVersion'

describe('v100 unified frontend build metadata', () => {
  it('exposes one v100 product and strategy identity', () => {
    expect(frontendBuildMetadata).toEqual({
      buildVersion: 'v101',
      strategyVersion: 'v101',
    })
  })
})
