import crypto from 'node:crypto'

export function isWorkerAdminAuthorized(req, configuredKey = process.env.WORKER_ADMIN_KEY, { allowQuery = false } = {}) {
  if (!configuredKey) return true
  const url = new URL(req.url ?? '/', `http://${req.headers?.host ?? 'localhost'}`)
  const headerKey = req.headers?.['x-worker-admin-key']
  const queryKey = allowQuery && String(req.method ?? 'GET').toUpperCase() === 'GET' ? url.searchParams.get('adminKey') : null
  return safeEqual(headerKey ?? queryKey ?? '', configuredKey)
}

function safeEqual(provided, expected) {
  if (provided == null || expected == null) return false
  const left = Buffer.from(String(provided))
  const right = Buffer.from(String(expected))
  if (left.length !== right.length) return false
  return crypto.timingSafeEqual(left, right)
}
