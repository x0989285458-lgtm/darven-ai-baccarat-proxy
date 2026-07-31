export function createInMemoryIngestSourceFence(initial = null) {
  let current = initial == null ? null : normalizeSource(initial)
  let tail = Promise.resolve()

  function validateAndAdvance(candidate) {
    const operation = tail.then(() => {
      const next = normalizeSource(candidate)
      if (!current || next.epoch > current.epoch) {
        current = next
        return { status: 'advanced', source: structuredClone(current) }
      }
      if (next.epoch < current.epoch) throw new Error('stale_source_epoch')
      if (!sameSource(next, current)) throw new Error('source_epoch_fence_conflict')
      return { status: 'current', source: structuredClone(current) }
    })
    tail = operation.catch(() => {})
    return operation
  }

  function validateCurrent(candidate) {
    const next = normalizeSource(candidate)
    if (!current || next.epoch > current.epoch) return { status: 'candidate', source: structuredClone(next) }
    if (next.epoch < current.epoch) throw new Error('stale_source_epoch')
    if (!sameSource(next, current)) throw new Error('source_epoch_fence_conflict')
    return { status: 'current', source: structuredClone(current) }
  }

  function observeCommitted(candidate) {
    const operation = tail.then(() => {
      const next = normalizeSource(candidate)
      if (!current || next.epoch > current.epoch) current = next
      return { status: current === next ? 'advanced' : 'observed', source: structuredClone(current) }
    })
    tail = operation.catch(() => {})
    return operation
  }

  function validateEvents(envelopeSource, events = []) {
    const owner = normalizeSource(envelopeSource)
    for (const event of events) {
      const source = event?.source
      if (!source || !Number.isSafeInteger(Number(source.sequence)) || Number(source.sequence) < 1) {
        throw new Error('event_source_sequence_invalid')
      }
      const eventOwner = normalizeSource(source)
      if (!sameSource(owner, eventOwner)) throw new Error('event_source_mismatch')
    }
    return true
  }

  return { validateAndAdvance, validateCurrent, observeCommitted, validateEvents, snapshot: () => current && structuredClone(current) }
}

export function normalizeSource(source, { exact = false } = {}) {
  if (!source || typeof source !== 'object' || Array.isArray(source)) throw new Error('source_fence_invalid')
  const keys = Object.keys(source)
  if (exact && (keys.length !== 4 || !['mode', 'ownerId', 'epoch', 'fence'].every((key) => keys.includes(key)))) {
    throw new Error('source_fence_invalid')
  }
  const normalized = {
    mode: String(source.mode ?? ''),
    ownerId: String(source.ownerId ?? ''),
    epoch: Number(source.epoch),
    fence: String(source.fence ?? ''),
  }
  if (!['api', 'browser', 'replay'].includes(normalized.mode)
    || !normalized.ownerId.trim()
    || !Number.isSafeInteger(normalized.epoch) || normalized.epoch < 1
    || !normalized.fence.trim()) throw new Error('source_fence_invalid')
  return normalized
}

function sameSource(left, right) {
  return left.mode === right.mode && left.ownerId === right.ownerId
    && left.epoch === right.epoch && left.fence === right.fence
}
