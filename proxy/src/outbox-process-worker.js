import { createApp } from './server.js'

const app = createApp({ autoConnect: false, port: 0, host: '127.0.0.1' })
let running = false
let pending = false
let stopping = false

async function drain() {
  if (stopping) return
  if (running) {
    pending = true
    return
  }
  running = true
  try {
    do {
      pending = false
      await app.drainCaptureOutbox()
    } while (pending && !stopping)
  } catch (error) {
    process.send?.({ type: 'drain_error', error: error?.message ?? String(error) })
  } finally {
    running = false
  }
}

process.on('message', (message) => {
  if (message?.type === 'wake') void drain()
  if (message?.type === 'stop') {
    stopping = true
    void app.stop().finally(() => process.exit(0))
  }
})
process.on('disconnect', () => {
  stopping = true
  void app.stop().finally(() => process.exit(0))
})
process.on('uncaughtException', (error) => {
  process.send?.({ type: 'fatal', error: error?.message ?? String(error) })
  process.exit(70)
})
process.on('unhandledRejection', (error) => {
  process.send?.({ type: 'fatal', error: error?.message ?? String(error) })
  process.exit(70)
})

try {
  await app.start()
  process.send?.({ type: 'ready' })
  void drain()
} catch (error) {
  process.send?.({ type: 'fatal', error: error?.message ?? String(error) })
  await app.stop().catch(() => {})
  process.exit(70)
}
