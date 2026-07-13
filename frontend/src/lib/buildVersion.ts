export const frontendBuildMetadata = Object.freeze({
  buildVersion: '098',
  strategyVersion: 'v097_副預測命中校準與門檻降5版',
})

export function installFrontendBuildMetadata(root: HTMLElement = document.documentElement) {
  root.dataset.buildVersion = frontendBuildMetadata.buildVersion
  root.dataset.strategyVersion = frontendBuildMetadata.strategyVersion
}
