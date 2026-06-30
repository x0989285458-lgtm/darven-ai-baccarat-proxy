export function buildPersistableLiveReport(report = {}, {
  strategyVersion = 'v034-auto-memory',
  reportType = '300_round_live_test',
  reportPath = null,
  metadata = {},
} = {}) {
  return {
    ...report,
    strategyVersion,
    reportType,
    reportPath,
    metadata: {
      source: 'local_chrome',
      cloudReady: true,
      ...metadata,
    },
  }
}

export async function persistFinalLiveReport(report = {}, {
  onlineCoreClient,
  projectSlug = 'ai-baccarat',
  strategyVersion = 'v034-auto-memory',
  reportType = '300_round_live_test',
  reportPath = null,
  metadata = {},
} = {}) {
  if (!onlineCoreClient?.configured || typeof onlineCoreClient.persistTestReport !== 'function') {
    return { skipped: true, reason: 'online core not configured' }
  }
  const payload = buildPersistableLiveReport(report, { strategyVersion, reportType, reportPath, metadata })
  return onlineCoreClient.persistTestReport(payload, projectSlug)
}
