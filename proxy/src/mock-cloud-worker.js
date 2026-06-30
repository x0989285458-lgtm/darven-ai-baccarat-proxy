export function buildMockCloudWorkerSnapshot({ sessionId = 'v042-mock-worker', tableCount = 9, round = 1 } = {}) {
  const tables = Array.from({ length: tableCount }, (_, index) => {
    const id = String(index + 1).padStart(2, '0')
    return {
      tableId: `BAG${id}`,
      displayName: `MT百家樂第${index + 1}桌`,
      tableType: 'BAC',
      shoe: 1,
      round,
      bankerCount: Math.ceil(round / 2),
      playerCount: Math.floor(round / 2),
      tieCount: 0,
      beadPlateRaw: 'BPBP',
      bigRoadRaw: 'BPBP',
    }
  })
  const rounds = tables.map((table, index) => ({
    tableId: table.tableId,
    shoe: table.shoe,
    round: table.round,
    winner: index % 2 === 0 ? 'banker' : 'player',
    rawResult: { mock: true },
  }))
  return {
    connected: true,
    authenticated: true,
    sessionId,
    snapshotAt: new Date().toISOString(),
    tables,
    rounds,
  }
}
