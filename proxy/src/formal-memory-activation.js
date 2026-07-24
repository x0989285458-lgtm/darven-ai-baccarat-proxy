export async function activateFormalReleaseMemory({ onlineCoreClient, manifest = {}, e2eEvidence = {} } = {}) {
  if (e2eEvidence.passed !== true) throw new Error('formal memory activation requires passed live E2E')
  if (Number(e2eEvidence.verifiedTables) !== 10) throw new Error('formal memory activation requires all 10 tables')
  if (typeof onlineCoreClient?.upsertStrategyVersion !== 'function') throw new Error('online core strategy version upsert is not configured')

  const activation = manifest.memoryActivation ?? {}
  return onlineCoreClient.upsertStrategyVersion({
    releaseVersion: manifest.releaseVersion,
    strategyVersion: manifest.strategyVersion,
    name: activation.name,
    status: 'active',
    mainWeights: activation.mainWeights,
    sideThresholds: activation.sideThresholds,
    metrics: { verifiedTables: 10, e2ePassed: true },
    notes: activation.notes,
    activatedAt: e2eEvidence.completedAt,
  })
}
