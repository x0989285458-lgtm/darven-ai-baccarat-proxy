import test from 'node:test'
import assert from 'node:assert/strict'
import { assertMtFinalUrl, assertMtNavigationResponse } from '../src/runtime-config.js'

test('v098 worker rejects redirected or cross-origin MT navigation', () => {
  assert.throws(() => assertMtFinalUrl('https://mt.example/login', 'https://evil.example/game'), /origin/)
  assert.throws(() => assertMtFinalUrl('https://mt.example/login', 'http://mt.example/game'), /HTTPS/)
  assert.throws(() => assertMtNavigationResponse({ request: () => ({ redirectedFrom: () => ({}) }) }), /redirect/i)
})
