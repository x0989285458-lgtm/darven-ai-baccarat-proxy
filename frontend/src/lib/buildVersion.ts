export const frontendBuildMetadata = Object.freeze({
  buildVersion: 'v104',
  strategyVersion: 'v104',
})

export function buildVersionRefreshUrl(currentHref: string, currentBuildVersion: string, remoteBuildVersion: string, lastAttemptedBuild: string | null): string | null {
  const remote = String(remoteBuildVersion ?? '').trim()
  if (!remote || remote === String(currentBuildVersion ?? '').trim() || lastAttemptedBuild === remote) return null
  try {
    const url = new URL(currentHref)
    url.searchParams.set('frontendBuild', remote)
    return url.href
  } catch {
    return null
  }
}

export function installFrontendBuildMetadata(root: HTMLElement = document.documentElement) {
  root.dataset.buildVersion = frontendBuildMetadata.buildVersion
  root.dataset.strategyVersion = frontendBuildMetadata.strategyVersion
}
