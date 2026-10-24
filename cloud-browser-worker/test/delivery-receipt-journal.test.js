import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'

const moduleUrl = new URL('../src/delivery-receipt-journal.js', import.meta.url)
const receipt = { sessionId: 's', sequence: 1, acceptedRoundKeys: [], source: { mode: 'api', ownerId: 'o', epoch: 1, fence: 'f' }, receiverNormalizedPayloadHash: 'a'.repeat(64), ackReceivedAtMs: 2000 }

test('bounded independent v1 journal survives reopen, deduplicates and rejects capacity without dropping', async t => {
  assert.equal(existsSync(moduleUrl), true, 'independent receipt journal not implemented')
  const { createDeliveryReceiptJournal } = await import(moduleUrl)
  const dir = await mkdtemp(path.join(tmpdir(), 'ack-journal-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const filePath = path.join(dir, 'delivery-v1.jsonl')
  let syncs = 0
  const journal = await createDeliveryReceiptJournal({ filePath, maxRecords: 1, afterSync: () => { syncs++ } })
  assert.equal(await journal.append(receipt), true)
  assert.equal(await journal.append(receipt), false)
  assert.equal(syncs, 1, 'one extra fsync per unique receipt, none for replay')
  await journal.close()
  const restarted = await createDeliveryReceiptJournal({ filePath, maxRecords: 1 })
  assert.equal(await restarted.append(receipt), false)
  await assert.rejects(restarted.append({ ...receipt, sequence: 2 }), /receipt_capacity/)
  await assert.rejects(restarted.append({ ...receipt, receiverNormalizedPayloadHash: 'b'.repeat(64) }), /receipt_identity_conflict/)
  await restarted.close()
  const lines = (await readFile(filePath, 'utf8')).trim().split('\n').map(JSON.parse)
  assert.equal(lines.length, 1)
  assert.deepEqual(lines[0], { version: 1, type: 'delivery_ack', ...receipt })
  console.log(JSON.stringify({ additionalReceiptFsyncs: syncs, uniqueReceipts: lines.length, bytes: Buffer.byteLength(await readFile(filePath)), maxDefaultBytes: 8388608, maxDefaultRecords: 4096, maxRecordBytes: 16384 }))
})

test('torn or oversized journal is preserved and refused; malformed metadata never appends', async t => {
  const { createDeliveryReceiptJournal } = await import(moduleUrl)
  const dir = await mkdtemp(path.join(tmpdir(), 'ack-negative-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const filePath = path.join(dir, 'receipt.jsonl')
  await writeFile(filePath, '{"version":1')
  await assert.rejects(createDeliveryReceiptJournal({ filePath }), /receipt_torn_tail/)
  assert.equal(await readFile(filePath, 'utf8'), '{"version":1')
  await assert.rejects(createDeliveryReceiptJournal({ filePath, maxBytes: 1 }), /receipt_capacity/)
  await writeFile(filePath, '')
  const journal = await createDeliveryReceiptJournal({ filePath })
  for (const invalid of [{ ...receipt, ackReceivedAtMs: undefined }, { ...receipt, receiverNormalizedPayloadHash: 'wire-hash' }, { ...receipt, receiverNormalizedPayloadHash: ['a'.repeat(64)] }, { ...receipt, sequence: '1' }]) {
    await assert.rejects(journal.append(invalid), /receipt_metadata_invalid/)
  }
  await assert.rejects(journal.append({ ...receipt, sessionId: 's'.repeat(16384) }), /receipt_record_capacity/)
  await journal.close()
  assert.equal(await readFile(filePath, 'utf8'), '')
})
