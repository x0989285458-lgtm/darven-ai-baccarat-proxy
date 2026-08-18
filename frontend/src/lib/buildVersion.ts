export const frontendBuildMetadata = Object.freeze({
  buildVersion: 'v106',
  strategyVersion: 'v106',
})

export function installFrontendBuildMetadata(root: HTMLElement = document.documentElement) {
  root.dataset.buildVersion = frontendBuildMetadata.buildVersion
  root.dataset.strategyVersion = frontendBuildMetadata.strategyVersion
}
