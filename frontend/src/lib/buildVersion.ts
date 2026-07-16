export const frontendBuildMetadata = Object.freeze({
  buildVersion: '098',
  strategyVersion: 'v098.20_六階段權重門檻整合版',
})

export function installFrontendBuildMetadata(root: HTMLElement = document.documentElement) {
  root.dataset.buildVersion = frontendBuildMetadata.buildVersion
  root.dataset.strategyVersion = frontendBuildMetadata.strategyVersion
}
