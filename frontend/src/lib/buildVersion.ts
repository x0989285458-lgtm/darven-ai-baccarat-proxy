export const frontendBuildMetadata = Object.freeze({
  buildVersion: 'v105',
  strategyVersion: 'v105',
})

export function installFrontendBuildMetadata(root: HTMLElement = document.documentElement) {
  root.dataset.buildVersion = frontendBuildMetadata.buildVersion
  root.dataset.strategyVersion = frontendBuildMetadata.strategyVersion
}
