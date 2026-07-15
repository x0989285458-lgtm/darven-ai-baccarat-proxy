import { describe, expect, it } from 'vitest'
import { frontendBuildMetadata } from './buildVersion'

describe('v098 frontend build metadata', () => {
  it('exposes buildVersion 098 with the formal v098 strategy identity', () => {
    expect(frontendBuildMetadata).toEqual({
      buildVersion: '098',
      strategyVersion: 'v098_主信心實際命中校準版',
    })
  })
})
