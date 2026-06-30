#!/usr/bin/env node
import http from 'node:http'
import { buildMockCloudWorkerSnapshot } from '../src/mock-cloud-worker.js'

const port = Number(process.env.MOCK_CLOUD_WORKER_PORT ?? process.argv[2] ?? 9797)
const tableCount = Number(process.env.MOCK_CLOUD_WORKER_TABLES ?? 9)
let round = Number(process.env.MOCK_CLOUD_WORKER_ROUND ?? 1)

const server = http.createServer((req, res) => {
  if (req.url === '/health') return send(res, { ok: true, service: 'v042 mock cloud worker' })
  if (req.url === '/snapshot') {
    const body = buildMockCloudWorkerSnapshot({ sessionId: 'v042-mock-worker', tableCount, round })
    round += 1
    return send(res, body)
  }
  send(res, { error: 'Not Found' }, 404)
})

server.listen(port, '127.0.0.1', () => {
  console.log(JSON.stringify({ ok: true, url: `http://127.0.0.1:${port}/snapshot` }))
})

function send(res, body, status = 200) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}
