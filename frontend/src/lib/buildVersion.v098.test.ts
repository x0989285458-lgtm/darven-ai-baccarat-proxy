import { describe, expect, it } from 'vitest'
import { frontendBuildMetadata } from './buildVersion'

describe('v098.23 frontend build metadata', () => {
  it('exposes buildVersion 098.23 while preserving the formal v098.20 strategy identity', () => {
    expect(frontendBuildMetadata).toEqual({
      buildVersion: '098.23',
      strategyVersion: 'v098.20_六階段權重門檻整合版',
    })
  })
})
