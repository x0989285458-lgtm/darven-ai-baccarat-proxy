export function isWorkerAdminAuthorized(req, configuredKey = process.env.WORKER_ADMIN_KEY) {
  if (!configuredKey) return true
  const url = new URL(req.url ?? '/', `http://${req.headers?.host ?? 'localhost'}`)
  const headerKey = req.headers?.['x-worker-admin-key']
  const queryKey = url.searchParams.get('adminKey')
  return String(headerKey ?? queryKey ?? '') === String(configuredKey)
}
