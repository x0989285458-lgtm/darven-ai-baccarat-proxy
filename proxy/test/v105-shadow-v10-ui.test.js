import test from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

test('V10 adds no frontend or admin UI source and remains member-invisible', () => {
  const root = fileURLToPath(new URL('../../frontend/src/', import.meta.url))
  const files = readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.(?:js|jsx|ts|tsx|css|html)$/.test(entry.name))
  const matches = files.flatMap((entry) => {
    const source = readFileSync(join(entry.parentPath, entry.name), 'utf8')
    return /v105[_-]shadow[_-]v10|shadow[_-]v10|uncommon[_-]road[_-]structure/i.test(source) ? [entry.name] : []
  })
  assert.deepEqual(matches, [])
})
