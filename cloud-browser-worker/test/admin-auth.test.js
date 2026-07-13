import test from 'node:test'
import assert from 'node:assert/strict'
import { isWorkerAdminAuthorized } from '../src/admin-auth.js'

test('v098 worker admin key is backward compatible outside validated production when unset', () => {
  const originalKey = process.env.WORKER_ADMIN_KEY
  delete process.env.WORKER_ADMIN_KEY
  const req = { headers: {}, url: '/snapshot' }
  try {
    assert.equal(isWorkerAdminAuthorized(req, ''), true)
    assert.equal(isWorkerAdminAuthorized(req, undefined), true)
  } finally {
    if (originalKey === undefined) delete process.env.WORKER_ADMIN_KEY
    else process.env.WORKER_ADMIN_KEY = originalKey
  }
})

test('v098 worker admin key accepts only the header by default', () => {
  assert.equal(isWorkerAdminAuthorized({ method: 'GET', headers: {}, url: '/snapshot' }, 'secret'), false)
  assert.equal(isWorkerAdminAuthorized({ method: 'GET', headers: { 'x-worker-admin-key': 'secret' }, url: '/snapshot' }, 'secret'), true)
  assert.equal(isWorkerAdminAuthorized({ method: 'GET', headers: {}, url: '/snapshot?adminKey=secret' }, 'secret'), false)
})

test('v093 worker control actions require header token and do not accept query token', () => {
  assert.equal(isWorkerAdminAuthorized({ method: 'POST', headers: {}, url: '/reload?adminKey=secret' }, 'secret', { allowQuery: false }), false)
  assert.equal(isWorkerAdminAuthorized({ method: 'POST', headers: { 'x-worker-admin-key': 'secret' }, url: '/reload' }, 'secret', { allowQuery: false }), true)
})
