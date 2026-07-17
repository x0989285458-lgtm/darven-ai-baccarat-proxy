import { describe, expect, it } from 'vitest'
import { frontendBuildMetadata } from './buildVersion'

describe('v098.23 frontend build metadata', () => {
  it('exposes buildVersion 098.23 while preserving the formal v098.20 strategy identity', () => {
    expect(frontendBuildMetadata).toEqual({
      buildVersion: 'v98',
      strategyVersion: 'v98',
    })
  })
})
