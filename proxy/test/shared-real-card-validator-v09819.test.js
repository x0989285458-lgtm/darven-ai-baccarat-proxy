import test from 'node:test'
import assert from 'node:assert/strict'
import { isProvisionalRoundAction, isVerifiedFinalRoundAction } from '../../shared/real-card-validator.js'

test('v098.19 classifies show_poker as provisional and only verified final MT actions as final', () => {
  assert.equal(isProvisionalRoundAction('/api/v1/gametype/*/game/*/room/*/table/*/show_poker'), true)
  assert.equal(isVerifiedFinalRoundAction('/api/v1/gametype/*/game/*/room/*/table/*/show_poker'), false)
  assert.equal(isVerifiedFinalRoundAction('/api/v1/gametype/*/game/*/room/*/table/*/summary'), true)
  assert.equal(isVerifiedFinalRoundAction('/api/v1/gametype/*/game/*/room/*/table/*/show_win'), true)
  assert.equal(isVerifiedFinalRoundAction('/api/v1/gametype/*/game/*/room/*/table/*/roundResult'), false)
  assert.equal(isVerifiedFinalRoundAction(null), false)
  for (const spoofed of [
    '/summary/anything', '/show_win/forged', '/evil/summary',
    'summary?forged=1', '/summary#forged', '/summary%2fanything',
    ' /summary', '/summary ', 'pre-summary', 'summary-suffix',
  ]) assert.equal(isVerifiedFinalRoundAction(spoofed), false, spoofed)
})
