export const frontendBuildMetadata = Object.freeze({
  buildVersion: 'v98',
  strategyVersion: 'v98',
})

export function installFrontendBuildMetadata(root: HTMLElement = document.documentElement) {
  root.dataset.buildVersion = frontendBuildMetadata.buildVersion
  root.dataset.strategyVersion = frontendBuildMetadata.strategyVersion
}
