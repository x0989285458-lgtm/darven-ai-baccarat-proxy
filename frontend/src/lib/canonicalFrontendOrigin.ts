const CANONICAL_FRONTEND_HOST = 'darven-ai-baccarat.pages.dev'
const PREVIEW_HOST_SUFFIX = `.${CANONICAL_FRONTEND_HOST}`

export function canonicalFrontendUrlForCloudflarePreview(currentHref: string): string | null {
  let currentUrl: URL
  try {
    currentUrl = new URL(currentHref)
  } catch {
    return null
  }

  if (currentUrl.protocol !== 'https:' || currentUrl.hostname === CANONICAL_FRONTEND_HOST) return null
  if (!currentUrl.hostname.endsWith(PREVIEW_HOST_SUFFIX)) return null

  const previewLabel = currentUrl.hostname.slice(0, -PREVIEW_HOST_SUFFIX.length)
  if (!previewLabel || !/^[a-z0-9-]+$/i.test(previewLabel)) return null

  currentUrl.hostname = CANONICAL_FRONTEND_HOST
  currentUrl.port = ''
  return currentUrl.href
}
