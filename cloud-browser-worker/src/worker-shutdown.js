export async function quiesceWorkerProducers({
  sourceRuntime,
  backupJournalRuntime,
  browserSourceRuntime,
  snapshotPusher,
  abortAfterTimeout,
  closeBrowser = async () => {},
} = {}) {
  await sourceRuntime?.stop?.()
  await backupJournalRuntime?.stop?.()
  await browserSourceRuntime?.stop?.()
  try {
    await snapshotPusher?.drain?.()
  } finally {
    await snapshotPusher?.stopAndWait?.({ abortAfterTimeout })
  }
  await closeBrowser()
}
