export function buildWorkerHealth({ service, version, buildInfo = {}, configured, loginUrl, sourceError = null, source = null, push = {}, nowMs = Date.now(), sourceProgressMaxAgeMs = 3 * 60 * 1000, expectedTableCount = 10 } = {}) {
  const sourceProgressAt = source?.sourceProgressAt ?? null
  const normalizedSource = {
    sessionId: source?.sessionId == null ? null : String(source.sessionId),
    connected: source?.connected === true,
    authenticated: source?.authenticated === true,
    tableCount: finiteNonNegative(source?.tableCount ?? (Array.isArray(source?.tables) ? source.tables.length : 0)),
    snapshotAt: source?.snapshotAt ?? source?.timestamp ?? null,
    ...(sourceProgressAt == null ? {} : { sourceProgressAt: String(sourceProgressAt) }),
  }
  const normalizedPush = {
    active: Boolean(push.active),
    stateInvalid: Boolean(push.stateInvalid),
    legacyMutableQueueDetected: Boolean(push.legacyMutableQueueDetected),
    queueEntryCount: finiteNonNegative(push.queueEntryCount),
    queuedRoundKeyCount: finiteNonNegative(push.queuedRoundKeyCount),
    headSessionId: push.headSessionId == null ? null : String(push.headSessionId),
    headSequence: push.headSequence == null ? null : Number.isSafeInteger(Number(push.headSequence)) ? Number(push.headSequence) : null,
    consecutiveFailures: finiteNonNegative(push.consecutiveFailures),
    nextAttemptAtMs: finiteOrNull(push.nextAttemptAtMs),
    lastAttemptAtMs: finiteOrNull(push.lastAttemptAtMs),
    lastSuccessAtMs: finiteOrNull(push.lastSuccessAtMs),
    lastError: push.lastError == null ? null : sanitizePublicError(push.lastError),
    lastAcknowledgedSessionId: push.lastAcknowledgedSessionId == null ? null : String(push.lastAcknowledgedSessionId),
    lastAcknowledgedSequence: push.lastAcknowledgedSequence == null ? null : Number.isSafeInteger(Number(push.lastAcknowledgedSequence)) ? Number(push.lastAcknowledgedSequence) : null,
  }
  const sourceProgressAtMs = Date.parse(sourceProgressAt ?? '')
  const sourceProgressAgeMs = Number(nowMs) - sourceProgressAtMs
  const sourceReady = normalizedSource.connected
    && normalizedSource.authenticated
    && normalizedSource.tableCount === Number(expectedTableCount)
  const sourceProgressExpected = sourceReady && sourceProgressAt != null
  const sourceProgressStale = sourceProgressExpected
    && (!Number.isFinite(sourceProgressAtMs)
      || sourceProgressAgeMs > Math.max(1000, Number(sourceProgressMaxAgeMs) || 3 * 60 * 1000)
      || sourceProgressAgeMs < -60_000)
  const reason = normalizedPush.legacyMutableQueueDetected
    ? 'legacy_mutable_queue_requires_cutover'
    : normalizedPush.stateInvalid
      ? 'push_durable_state_invalid'
      : normalizedPush.queueEntryCount > 0 && normalizedPush.consecutiveFailures >= 1 && normalizedPush.lastError
        ? 'push_delivery_failed'
        : !configured
          ? 'worker_not_configured'
          : !sourceReady
            ? 'source_unavailable'
            : sourceError != null && String(sourceError).trim()
              ? 'source_error'
              : sourceProgressAt == null || sourceProgressStale
                ? 'source_progress_stale'
                : null
  return {
    ok: reason == null,
    reason,
    service,
    version,
    ...buildInfo,
    configured: Boolean(configured),
    loginUrl: loginUrl ?? null,
    lastError: sourceError == null ? null : sanitizePublicError(sourceError),
    source: normalizedSource,
    push: normalizedPush,
  }
}

export function updateSourceProgressTracker(previous = null, source = {}) {
  const tables = (Array.isArray(source?.tables) ? source.tables : [])
    .map((table) => [
      String(table?.tableId ?? ''), table?.shoe ?? null, table?.round ?? null, table?.state ?? null,
      table?.bigRoadRaw ?? null, table?.bigEyeRoadRaw ?? null, table?.smallRoadRaw ?? null, table?.cockroachRoadRaw ?? null,
    ])
    .sort((left, right) => left[0].localeCompare(right[0]))
  const rounds = (Array.isArray(source?.rounds) ? source.rounds : [])
    .map((round) => [String(round?.tableId ?? ''), round?.shoe ?? null, round?.round ?? null, round?.sourceAction ?? null])
    .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)))
  const fingerprint = JSON.stringify([tables, rounds])
  const snapshotAt = source?.snapshotAt ?? source?.timestamp ?? new Date().toISOString()
  return {
    fingerprint,
    sourceProgressAt: previous?.fingerprint === fingerprint && previous?.sourceProgressAt
      ? previous.sourceProgressAt
      : String(snapshotAt),
  }
}

function sanitizePublicError(value) {
  return String(value ?? '')
    .replace(/([?&](?:token|key|secret|password|auth|authorization)=)[^&\s]+/gi, '$1[redacted]')
    .replace(/\b(?:authorization\s*:\s*)?bearer\s+[A-Za-z0-9._~+\/-]+=*/gi, 'Authorization: Bearer [redacted]')
    .replace(/\b(token|key|secret|password|authorization)=\S+/gi, '$1=[redacted]')
    .slice(0, 240)
}

function finiteNonNegative(value) {
  const number = Number(value)
  return Number.isFinite(number) && number >= 0 ? number : 0
}

function finiteOrNull(value) {
  if (value == null || value === '') return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}
