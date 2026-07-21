import { useEffect, useState } from 'react'
import {
  getShadowIterationReportSvg,
  getShadowIterationStatus,
  reviewShadowIterationSuggestion,
  type ShadowIterationStatus,
} from './lib/onlineCoreClient'

const EMPTY_STATUS: ShadowIterationStatus = {
  state: 'connecting', enabled: false, settledRounds: 0, currentCycleProgress: 0,
  heads: [], reports: [], suggestions: [],
}

export function ShadowIterationPanel({ adminSessionToken }: { adminSessionToken: string }) {
  const [status, setStatus] = useState<ShadowIterationStatus>(EMPTY_STATUS)
  const [reportImage, setReportImage] = useState('')
  const [refreshKey, setRefreshKey] = useState(0)
  const [reviewingId, setReviewingId] = useState('')

  useEffect(() => {
    let active = true
    const load = async () => {
      const next = await getShadowIterationStatus(adminSessionToken)
      if (!active) return
      setStatus(next)
      const latest = [...next.reports].sort((a, b) => Number(b.cycleNumber) - Number(a.cycleNumber))[0]
      if (!latest) { setReportImage(''); return }
      try {
        const svg = await getShadowIterationReportSvg(latest.cycleNumber, adminSessionToken)
        if (active) setReportImage(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`)
      } catch {
        if (active) setReportImage('')
      }
    }
    void load()
    const timer = window.setInterval(load, 60_000)
    return () => { active = false; window.clearInterval(timer) }
  }, [adminSessionToken, refreshKey])

  const review = async (suggestionId: string, decision: 'approved' | 'rejected') => {
    if (reviewingId) return
    setReviewingId(suggestionId)
    try {
      await reviewShadowIterationSuggestion(suggestionId, decision, adminSessionToken)
      setRefreshKey((value) => value + 1)
    } finally {
      setReviewingId('')
    }
  }

  return <section className="admin-panel shadow-iteration-panel" aria-label="影子預測迭代">
    <div className="shadow-iteration-heading">
      <div>
        <p className="panel-label">只讀Shadow｜正式v104不受影響</p>
        <h2>影子預測迭代</h2>
      </div>
      <strong className={status.enabled ? 'shadow-state enabled' : 'shadow-state'}>{status.enabled ? '執行中' : status.state === 'connecting' ? '讀取中' : '未啟用'}</strong>
    </div>

    <div className="shadow-cycle-summary">
      <span>影子版本<b>{status.shadowVersion ?? '-'}</b></span>
      <span>正式策略<b>{status.formalStrategyVersion ?? 'v104'}</b></span>
      <span>已結算局數<b>{formatInteger(status.settledRounds)}</b></span>
      <span>本輪千局進度<b>{formatInteger(status.currentCycleProgress)}／1,000</b></span>
    </div>

    {status.heads.length ? <div className="shadow-head-table" role="table" aria-label="七項影子預測結果">
      <div className="shadow-head-row shadow-head-header" role="row">
        <span>預測項目</span><span>出手率</span><span>命中率</span><span>固定1單位</span><span>信心加權</span><span>迭代進度</span>
      </div>
      {status.heads.map((head) => <div className="shadow-head-row" role="row" key={head.key}>
        <strong>{head.label}</strong>
        <span>{formatPercent(head.actionRate)}</span>
        <span>{formatPercent(head.hitRate)}</span>
        <span>{formatUnits(head.fixedNetUnits)}</span>
        <span>{formatUnits(head.weightedNetUnits)}</span>
        <span>{formatInteger(head.iterationProgress)}／1,000</span>
      </div>)}
    </div> : <p className="shadow-empty">{status.message ?? '尚無影子預測資料'}</p>}

    {reportImage ? <figure className="shadow-report-figure">
      <img src={reportImage} alt="影子預測完整千局圖表" />
      <figcaption>每完成1,000局產生一張完整繁中圖表；單位顯示實際正負數。</figcaption>
    </figure> : <p className="shadow-report-waiting">完成第一個1,000局後顯示完整圖表。</p>}

    <div className="shadow-suggestion-summary" aria-label="權重建議">
      <strong>待審核權重建議：{status.suggestions.filter((item) => item.status === 'pending').length}</strong>
      <span>只重配現有權重比例；不新增權重內容、不改門檻、不自動套用。</span>
      {status.suggestions.filter((item) => item.status === 'pending').map((item) => <div className="shadow-suggestion-review" key={item.id}>
        <span>{headLabel(item.headKey)}｜第{formatInteger(item.actionCycle)}輪｜5%格點完整搜尋</span>
        <div>
          <button type="button" disabled={Boolean(reviewingId)} onClick={() => void review(item.id, 'approved')}>批准</button>
          <button type="button" disabled={Boolean(reviewingId)} onClick={() => void review(item.id, 'rejected')}>拒絕</button>
        </div>
      </div>)}
    </div>
  </section>
}

function headLabel(key: string) {
  return ({ main: '莊／閒', tie: '和', superSix: '超六', bankerDragon: '莊龍寶', playerDragon: '閒龍寶', bankerPair: '莊對', playerPair: '閒對' } as Record<string, string>)[key] ?? key
}

function formatPercent(value: number | null) {
  return value == null || !Number.isFinite(Number(value)) ? '-' : `${Number(value).toFixed(1)}%`
}

function formatUnits(value: number) {
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) return '-'
  return `${numeric >= 0 ? '+' : ''}${numeric.toFixed(2)} 單位`
}

function formatInteger(value: number) {
  const numeric = Number(value)
  return Number.isFinite(numeric) ? Math.max(0, Math.floor(numeric)).toLocaleString('zh-TW') : '0'
}
