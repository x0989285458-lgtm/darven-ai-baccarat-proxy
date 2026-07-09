import test from 'node:test'
import assert from 'node:assert/strict'
import { isWorkerAdminAuthorized } from '../src/admin-auth.js'

test('v090 worker admin key is backward compatible when unset', () => {
  const req = { headers: {}, url: '/snapshot' }
  assert.equal(isWorkerAdminAuthorized(req, ''), true)
  assert.equal(isWorkerAdminAuthorized(req, undefined), true)
})

test('v090 worker admin key accepts header or query when configured', () => {
  assert.equal(isWorkerAdminAuthorized({ headers: {}, url: '/snapshot' }, 'secret'), false)
  assert.equal(isWorkerAdminAuthorized({ headers: { 'x-worker-admin-key': 'secret' }, url: '/snapshot' }, 'secret'), true)
  assert.equal(isWorkerAdminAuthorized({ headers: {}, url: '/snapshot?adminKey=secret' }, 'secret'), true)
})
