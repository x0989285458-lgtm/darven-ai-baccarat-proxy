import { open } from 'node:fs/promises'

// Prototype only. Single owning process; explicit path, pre-existing parent directory.
// No rotation/deletion/retention policy and no production startup wiring.
export async function createDeliveryReceiptJournal({ filePath, maxBytes = 8388608, maxRecords = 4096, afterSync = () => {} } = {}) {
  if (!filePath || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 8388608
      || !Number.isSafeInteger(maxRecords) || maxRecords < 1 || maxRecords > 4096) throw new Error('receipt_limits_invalid')
  const handle = await open(filePath, 'a+', 0o600)
  const entries = new Map()
  let bytes = 0
  let busy = false
  let poisoned = false
  try {
    bytes = (await handle.stat()).size
    if (bytes > maxBytes) throw new Error('receipt_capacity')
    const text = await handle.readFile('utf8')
    if (text && !text.endsWith('\n')) throw new Error('receipt_torn_tail_requires_owner_recovery')
    for (const line of text.split('\n').filter(Boolean)) {
      if (Buffer.byteLength(line) > 16384) throw new Error('receipt_record_capacity')
      const raw = JSON.parse(line)
      if (raw.version !== 1 || raw.type !== 'delivery_ack') throw new Error('receipt_version_invalid')
      const record = normalize(raw)
      const key = JSON.stringify([record.sessionId, record.sequence])
      const canonical = JSON.stringify(record)
      if (entries.has(key)) throw new Error('receipt_duplicate_on_disk')
      entries.set(key, canonical)
      if (entries.size > maxRecords) throw new Error('receipt_capacity')
    }
  } catch (error) { await handle.close(); throw error }
  return {
    async append(receipt) {
      if (poisoned || busy) throw new Error('receipt_writer_unavailable')
      const record = normalize(receipt)
      const key = JSON.stringify([record.sessionId, record.sequence])
      const canonical = JSON.stringify(record)
      if (entries.has(key)) {
        if (entries.get(key) !== canonical) throw new Error('receipt_identity_conflict')
        return false
      }
      const data = Buffer.from(canonical + '\n')
      if (data.length > 16384) throw new Error('receipt_record_capacity')
      if (entries.size >= maxRecords || bytes + data.length > maxBytes) throw new Error('receipt_capacity')
      busy = true
      try {
        // writeFile may issue multiple writes; an incomplete tail is never truncated on restore.
        await handle.writeFile(data)
        await handle.sync()
        afterSync()
        entries.set(key, canonical)
        bytes += data.length
        return true
      } catch (error) { poisoned = true; throw error }
      finally { busy = false }
    },
    async close() { if (busy) throw new Error('receipt_writer_busy'); poisoned = true; await handle.close() },
  }
}

function normalize(receipt) {
  const s = receipt?.source
  if (typeof receipt?.sessionId !== 'string' || !receipt.sessionId
      || !Number.isSafeInteger(receipt.sequence) || receipt.sequence < 1
      || !Array.isArray(receipt.acceptedRoundKeys) || receipt.acceptedRoundKeys.some(k => typeof k !== 'string' || !k)
      || typeof receipt.receiverNormalizedPayloadHash !== 'string' || !/^[a-f0-9]{64}$/.test(receipt.receiverNormalizedPayloadHash)
      || !Number.isSafeInteger(receipt.ackReceivedAtMs) || receipt.ackReceivedAtMs < 0
      || (s != null && (!['api', 'browser', 'replay'].includes(s.mode) || typeof s.ownerId !== 'string' || !s.ownerId
        || !Number.isSafeInteger(s.epoch) || s.epoch < 1 || typeof s.fence !== 'string' || !s.fence))) throw new Error('receipt_metadata_invalid_or_legacy_gap')
  return {
    version: 1, type: 'delivery_ack', sessionId: receipt.sessionId, sequence: receipt.sequence,
    acceptedRoundKeys: [...receipt.acceptedRoundKeys],
    ...(s ? { source: { mode: s.mode, ownerId: s.ownerId, epoch: s.epoch, fence: s.fence } } : {}),
    receiverNormalizedPayloadHash: receipt.receiverNormalizedPayloadHash,
    ackReceivedAtMs: receipt.ackReceivedAtMs,
  }
}
