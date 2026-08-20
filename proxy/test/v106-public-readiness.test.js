import test from 'node:test'
import assert from 'node:assert/strict'
import { verifyV106PublicReadiness } from '../../scripts/verify-v106-public-readiness.mjs'

const expected = {
  url: 'https://example.test',
  expectedRelease: 'v106.0.0-formal.20',
  expectedPackage: '1.0.77',
  expectedCommit: 'a'.repeat(40),
  intervalMs: 0,
  requestTimeoutMs: 100,
}

const response = (body, status = 200) => ({ status, json: async () => body })
const exact = () => response({
  ok: true, version: 'v106', buildVersion: 'v106',
  releaseVersion: expected.expectedRelease, packageVersion: expected.expectedPackage, commit: expected.expectedCommit,
})

test('Formal.20 readiness blocks an older v106 release even when public health is HTTP 200', async () => {
  const probes = []
  await assert.rejects(verifyV106PublicReadiness({
    ...expected, attempts: 2,
    fetchImpl: async () => response({
      ok: true, version: 'v106', buildVersion: 'v106',
      releaseVersion: 'v106.0.0-formal.20', packageVersion: '1.0.77', commit: 'b'.repeat(40),
    }),
    onProbe: (probe) => probes.push(probe),
  }), (error) => error?.code === 'PUBLIC_PROXY_READINESS_BLOCK')
  assert.deepEqual(probes.map(({ passed, streak }) => ({ passed, streak })), [
    { passed: false, streak: 0 }, { passed: false, streak: 0 },
  ])
})

test('Formal.20 readiness requires two consecutive exact public identities and resets after any mismatch', async () => {
  const responses = [exact(), response({ ok: false }), exact(), exact()]
  const probes = []
  const result = await verifyV106PublicReadiness({
    ...expected, attempts: responses.length,
    fetchImpl: async () => responses.shift(),
    onProbe: (probe) => probes.push(probe),
  })
  assert.equal(result.verdict, 'PASS')
  assert.equal(result.consecutive, 2)
  assert.deepEqual(probes.map(({ passed, streak }) => ({ passed, streak })), [
    { passed: true, streak: 1 }, { passed: false, streak: 0 },
    { passed: true, streak: 1 }, { passed: true, streak: 2 },
  ])
})

test('Formal.20 readiness caps even direct caller attempts at the bound maximum of 30', async () => {
  let calls = 0
  await assert.rejects(verifyV106PublicReadiness({
    ...expected, attempts: 31, intervalMs: 0,
    fetchImpl: async () => { calls += 1; return response({ ok: false }) },
  }), (error) => error?.code === 'PUBLIC_PROXY_READINESS_BLOCK')
  assert.equal(calls, 30)
})

test('Formal.20 readiness rejects redirects instead of following a counterfeit health responder', async () => {
  const redirects = []
  await assert.rejects(verifyV106PublicReadiness({
    ...expected, attempts: 2,
    fetchImpl: async (_url, options) => {
      redirects.push(options?.redirect)
      if (options?.redirect !== 'error') return exact()
      const error = new TypeError('redirect blocked')
      error.name = 'TypeError'
      throw error
    },
  }), (error) => error?.code === 'PUBLIC_PROXY_READINESS_BLOCK')
  assert.deepEqual(redirects, ['error', 'error'])
})

test('Formal.20 readiness rejects an unbounded or incomplete identity contract before network access', async () => {
  let calls = 0
  await assert.rejects(verifyV106PublicReadiness({
    ...expected, expectedCommit: '', fetchImpl: async () => { calls += 1; return exact() },
  }), /public_readiness_commit_required/)
  assert.equal(calls, 0)
})
