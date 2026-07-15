export const frontendBuildMetadata = Object.freeze({
  buildVersion: '098',
  strategyVersion: 'v098_主信心實際命中校準版',
})

export function installFrontendBuildMetadata(root: HTMLElement = document.documentElement) {
  root.dataset.buildVersion = frontendBuildMetadata.buildVersion
  root.dataset.strategyVersion = frontendBuildMetadata.strategyVersion
}
