const V9_WRITER_METHODS = Object.freeze([
  'getV105ShadowV9History',
  'issueV105ShadowV9Prediction',
  'readV105ShadowV9Issuance',
  'settleV105ShadowV9Prediction',
  'getV105ShadowV9Counters',
])

export function createParentIpcV9Writer({
  processRef = process,
  requestTimeoutMs = Number(process.env.SUPABASE_REQUEST_TIMEOUT_MS ?? 30000),
} = {}) {
  let nextId = 1
  let disconnected = false
  const pending = new Map()

  function rejectAll(error) {
    for (const [id, request] of pending) {
      pending.delete(id)
      clearTimeout(request.timer)
      request.reject(error)
    }
  }

  processRef.on('message', (message) => {
    if (!message || message.type !== 'writer_response') return
    const request = pending.get(message.id)
    if (!request) return
    pending.delete(message.id)
    clearTimeout(request.timer)
    if (message.ok === true) request.resolve(message.result ?? null)
    else request.reject(Object.assign(new Error(String(message.error?.message ?? 'V9 writer request failed')), {
      code: String(message.error?.code ?? 'V9_WRITER_REQUEST_FAILED'),
    }))
  })
  processRef.once('disconnect', () => {
    disconnected = true
    rejectAll(new Error('V9 writer IPC disconnected'))
  })

  function call(method, args) {
    if (disconnected || processRef.connected === false) return Promise.reject(new Error('V9 writer IPC disconnected'))
    const id = nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(Object.assign(new Error('V9 writer IPC request timeout'), { code: 'V9_WRITER_REQUEST_TIMEOUT' }))
      }, Math.max(1, Number(requestTimeoutMs) || 30000))
      timer.unref?.()
      pending.set(id, { resolve, reject, timer })
      try {
        processRef.send?.({ type: 'writer_request', id, method, args: structuredClone(args) }, (error) => {
          if (!error) return
          const request = pending.get(id)
          if (!request) return
          pending.delete(id)
          clearTimeout(request.timer)
          request.reject(Object.assign(new Error('V9 writer IPC send failed'), { code: 'V9_WRITER_IPC_SEND_FAILED' }))
        })
      } catch {
        const request = pending.get(id)
        if (!request) return
        pending.delete(id)
        clearTimeout(request.timer)
        request.reject(Object.assign(new Error('V9 writer IPC send failed'), { code: 'V9_WRITER_IPC_SEND_FAILED' }))
      }
    })
  }

  const writer = { configured: true }
  for (const method of V9_WRITER_METHODS) writer[method] = (...args) => call(method, args)
  return writer
}

export { V9_WRITER_METHODS }
