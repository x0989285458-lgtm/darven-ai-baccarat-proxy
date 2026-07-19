export const frontendBuildMetadata = Object.freeze({
  buildVersion: 'v101',
  strategyVersion: 'v101',
})

export function installFrontendBuildMetadata(root: HTMLElement = document.documentElement) {
  root.dataset.buildVersion = frontendBuildMetadata.buildVersion
  root.dataset.strategyVersion = frontendBuildMetadata.strategyVersion
}
