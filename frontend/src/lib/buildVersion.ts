export const frontendBuildMetadata = Object.freeze({
  buildVersion: 'v104',
  strategyVersion: 'v104',
})

export function installFrontendBuildMetadata(root: HTMLElement = document.documentElement) {
  root.dataset.buildVersion = frontendBuildMetadata.buildVersion
  root.dataset.strategyVersion = frontendBuildMetadata.strategyVersion
}
