export const frontendBuildMetadata = Object.freeze({
  buildVersion: 'v100',
  strategyVersion: 'v100',
})

export function installFrontendBuildMetadata(root: HTMLElement = document.documentElement) {
  root.dataset.buildVersion = frontendBuildMetadata.buildVersion
  root.dataset.strategyVersion = frontendBuildMetadata.strategyVersion
}
