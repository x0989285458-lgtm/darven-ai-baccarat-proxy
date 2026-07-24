const TAIPEI_TIMEZONE = 'Asia/Taipei'
const TAIPEI_DATE_FORMAT = new Intl.DateTimeFormat('en-CA', {
  timeZone: TAIPEI_TIMEZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
})

export function createFormalDailyMemoryRollover({ loadDailySummary, onlineCoreClient } = {}) {
  if (typeof loadDailySummary !== 'function') throw new Error('formal daily rollover requires a summary loader')
  if (typeof onlineCoreClient?.upsertDailySummary !== 'function') throw new Error('formal daily rollover requires an online core daily writer')

  const completedDates = new Set()
  const inflightByDate = new Map()

  async function observe(event = {}) {
    if (event.settlementFinal !== true) return { skipped: true, reason: 'not-authoritative-final' }
    const reportDate = previousTaipeiDate(event.resolvedAt)
    if (completedDates.has(reportDate)) return { skipped: true, reason: 'already-finalized', reportDate }
    if (inflightByDate.has(reportDate)) return inflightByDate.get(reportDate)

    const task = (async () => {
      const summary = await loadDailySummary(reportDate)
      if (!summary) return { skipped: true, reason: 'summary-unavailable', reportDate }
      const result = await onlineCoreClient.upsertDailySummary({
        ...summary,
        reportDate,
        timezone: TAIPEI_TIMEZONE,
        strategyVersion: 'v105',
      })
      completedDates.add(reportDate)
      return { ...result, reportDate }
    })().finally(() => inflightByDate.delete(reportDate))

    inflightByDate.set(reportDate, task)
    return task
  }

  return { observe }
}

export function previousTaipeiDate(timestamp) {
  const value = new Date(timestamp)
  if (!Number.isFinite(value.getTime())) throw new Error('formal daily rollover requires a valid Final timestamp')
  const parts = Object.fromEntries(TAIPEI_DATE_FORMAT.formatToParts(value).map(({ type, value: part }) => [type, part]))
  const date = new Date(Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day)))
  date.setUTCDate(date.getUTCDate() - 1)
  return date.toISOString().slice(0, 10)
}
