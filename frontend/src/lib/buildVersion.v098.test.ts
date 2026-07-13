import { describe, expect, it } from 'vitest'
import { frontendBuildMetadata } from './buildVersion'

describe('v098 frontend build metadata', () => {
  it('exposes buildVersion 098 without changing the v097 strategy identity', () => {
    expect(frontendBuildMetadata).toEqual({
      buildVersion: '098',
      strategyVersion: 'v097_副預測命中校準與門檻降5版',
    })
  })
})
