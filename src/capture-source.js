export function chooseCaptureSource({ chromeCaptureUrl = '', cloudBrowserUrl = '', token = '' } = {}) {
  if (cloudBrowserUrl) return 'cloud_browser'
  if (chromeCaptureUrl) return 'local_chrome'
  if (token) return 'node_ws'
  return 'offline'
}

export function describeCaptureStatus(status = {}) {
  const source = status.captureSource ?? status.captureMode ?? 'offline'
  const tableCount = Number(status.tableCount ?? 0)
  const error = status.errorMessage
  const connected = Boolean(status.connected)
  const authenticated = Boolean(status.authenticated)

  if (source === 'cloud_browser') {
    if (authenticated && tableCount > 0) return `雲端瀏覽器已抓到${tableCount}桌`
    if (connected) return '雲端瀏覽器已連接，等待MT登入驗證'
    if (error) return `雲端瀏覽器連線失敗：${error}`
    return '雲端瀏覽器待啟動'
  }

  if (source === 'local_chrome' || source === 'chrome') {
    if (authenticated && tableCount > 0) return `Chrome已抓到${tableCount}桌`
    if (authenticated) return 'Chrome已驗證，等待桌況資料'
    if (connected || status.chromeStarted) return 'Chrome已連接，等待MT登入驗證'
    if (error) return `Chrome抓取失敗：${error}`
    return 'Chrome未啟動'
  }

  if (source === 'node_ws') {
    if (authenticated && tableCount > 0) return `Token直連已抓到${tableCount}桌`
    if (connected && authenticated) return 'Token直連已驗證，等待桌況資料'
    if (connected) return 'Token直連已連線，Token驗證中'
    if (error) return `Token直連被拒絕：${error}`
    return 'Token直連待連線'
  }

  return '離線模式'
}
