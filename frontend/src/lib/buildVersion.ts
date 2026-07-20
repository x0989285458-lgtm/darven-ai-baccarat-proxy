export const frontendBuildMetadata = Object.freeze({
  buildVersion: 'v102',
  strategyVersion: 'v102',
})

export function installFrontendBuildMetadata(root: HTMLElement = document.documentElement) {
  root.dataset.buildVersion = frontendBuildMetadata.buildVersion
  root.dataset.strategyVersion = frontendBuildMetadata.strategyVersion
}
