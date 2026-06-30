import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import config from '../ecosystem.config.cjs'

test('v003 PM2 ecosystem keeps MT proxy alive with logs and restart policy', () => {
  const app = config.apps[0]
  assert.equal(app.name, 'draven-mt-proxy-v004')
  assert.equal(app.script, './src/server.js')
  assert.equal(app.instances, 1)
  assert.equal(app.autorestart, true)
  assert.equal(app.watch, false)
  assert.match(app.out_file, /logs/)
  assert.match(app.error_file, /logs/)
  assert.equal(app.env.PORT, '8787')
  assert.equal(app.env.AUTO_CONNECT, 'true')
})

test('v003 includes Windows helper launchers for persistent operation', () => {
  const files = [
    '啟動代理伺服器_Chrome背景抓取.bat',
    '啟動代理伺服器_PM2常駐.bat',
    '停止代理伺服器_PM2.bat',
    '查看代理伺服器狀態.bat',
    '更新MT網址或TOKEN.bat',
  ]
  for (const file of files) {
    assert.equal(existsSync(file), true, `${file} should exist`)
    assert.match(readFileSync(file, 'utf8'), /Draven|PM2|MT|代理/)
  }
})
