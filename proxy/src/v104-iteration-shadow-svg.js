const WEIGHT_LABELS = Object.freeze({
  roadmap_trend_signals: '五路趨勢訊號', ask_road_signals: '路單問路訊號',
  shoe_banker_player_bias: '當靴莊閒偏差', neutral_reserve: '中性保留',
  tie_risk: '和局風險', tie_count: '和局次數', shoe_stage: '牌靴階段', road_chaos: '路單混亂度',
  remaining_rank_total: '剩餘牌階總量', banker_point: '莊點訊號', table_side_history: '桌台副項歷史',
  remaining_rank_pressure: '剩餘牌階壓力', banker_pair_count: '莊對次數', player_pair_count: '閒對次數', pair_risk: '對子風險',
  point_diff: '點差訊號', banker_natural: '莊天然牌', player_natural: '閒天然牌',
  big_road: '大路訊號', player_point: '閒點訊號',
})

export function renderShadowReportSvg(report = {}, suggestions = []) {
  const heads = Array.isArray(report.heads) ? report.heads : []
  const pending = (Array.isArray(suggestions) ? suggestions : []).filter((item) => item && (item.status == null || item.status === 'pending'))
  const suggestionLines = pending.reduce((sum, item) => sum + 2 + Object.keys(item.suggestedWeights ?? {}).length, 0)
  const height = Math.max(900, 390 + heads.length * 92 + suggestionLines * 25)
  const lines = []
  const text = (x, y, value, size = 22, fill = '#dce8f4', weight = 500, anchor = 'start') => {
    lines.push(`<text x="${x}" y="${y}" font-family="Arial,'Microsoft JhengHei',sans-serif" font-size="${size}" fill="${fill}" font-weight="${weight}" text-anchor="${anchor}">${escapeXml(value)}</text>`)
  }
  lines.push(`<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="${height}" viewBox="0 0 1080 ${height}" role="img" aria-label="影子預測第${safeInteger(report.cycleNumber)}輪完整結果">`)
  lines.push('<defs><linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#071425"/><stop offset="1" stop-color="#101d31"/></linearGradient></defs>')
  lines.push(`<rect width="1080" height="${height}" rx="28" fill="url(#bg)"/>`)
  lines.push('<rect x="34" y="34" width="1012" height="180" rx="22" fill="#102844" stroke="#a7834c" stroke-opacity=".55"/>')
  text(64, 88, `影子預測第${safeInteger(report.cycleNumber)}輪｜1,000局結果`, 38, '#ffd166', 800)
  text(64, 132, `影子版本：${report.shadowVersion ?? '-'}`, 20, '#b8cbe0')
  text(64, 166, `正式策略：${report.formalStrategyVersion ?? 'v104'}｜只讀旁路，不影響正式預測`, 20, '#71e6b1')
  text(64, 198, `${formatDate(report.startedAt)} ～ ${formatDate(report.completedAt)}`, 18, '#8ea8c2')

  const headers = [['預測項目',60],['出手率',285],['命中率',450],['固定1單位',625],['信心加權',820]]
  lines.push('<rect x="34" y="238" width="1012" height="52" rx="12" fill="#173653"/>')
  for (const [label, x] of headers) text(x, 273, label, 19, '#a8c1d9', 700)

  let y = 316
  for (const head of heads) {
    lines.push(`<rect x="34" y="${y - 22}" width="1012" height="78" rx="12" fill="${y % 2 ? '#0d2035' : '#0b1c30'}" stroke="#294866" stroke-opacity=".35"/>`)
    text(60, y + 18, head.label ?? head.key ?? '-', 22, '#ffd166', 800)
    drawPercentBar(lines, 285, y - 2, head.actionRate)
    text(360, y + 18, formatPercent(head.actionRate), 20, '#e8f1fa', 650, 'middle')
    drawPercentBar(lines, 450, y - 2, head.hitRate)
    text(525, y + 18, formatPercent(head.hitRate), 20, '#e8f1fa', 650, 'middle')
    text(700, y + 18, formatUnits(head.fixedNetUnits), 20, unitColor(head.fixedNetUnits), 750, 'middle')
    text(900, y + 18, formatUnits(head.weightedNetUnits), 20, unitColor(head.weightedNetUnits), 750, 'middle')
    text(60, y + 47, `出手 ${safeInteger(head.actions)}｜命中 ${safeInteger(head.hits)}｜未中 ${safeInteger(head.misses)}｜PUSH ${safeInteger(head.pushes)}`, 15, '#8fa9c1')
    y += 92
  }

  y += 18
  lines.push(`<rect x="34" y="${y}" width="1012" height="${Math.max(120, suggestionLines * 25 + 42)}" rx="18" fill="#171d36" stroke="#8f72ca" stroke-opacity=".55"/>`)
  text(60, y + 42, '千次權重迭代建議', 26, '#d8c8ff', 800)
  y += 78
  if (!pending.length) {
    text(60, y, '本輪尚無達到1,000次實際出手的新增建議。', 19, '#a8b6c8')
  } else {
    for (const item of pending) {
      text(60, y, `${item.headLabel ?? item.headKey}｜只調現有比例｜不自動套用`, 21, '#ffd166', 750)
      y += 28
      const keys = Object.keys(item.suggestedWeights ?? {})
      for (const key of keys) {
        const current = Number(item.currentWeights?.[key] ?? 0) * 100
        const suggested = Number(item.suggestedWeights?.[key] ?? 0) * 100
        text(82, y, `${WEIGHT_LABELS[key] ?? '既有權重'}：${current.toFixed(1)}% → ${suggested.toFixed(1)}%`, 17, '#cbd9e7')
        y += 23
      }
      y += 12
    }
  }
  text(540, height - 30, '單位為實際淨正負數；圖表只使用MT權威Final真牌。', 16, '#7f99b1', 500, 'middle')
  lines.push('</svg>')
  return lines.join('')
}

function drawPercentBar(lines, x, y, value) {
  const percent = Math.max(0, Math.min(100, Number(value) || 0))
  lines.push(`<rect x="${x}" y="${y}" width="150" height="10" rx="5" fill="#203d58"/>`)
  lines.push(`<rect x="${x}" y="${y}" width="${(150 * percent / 100).toFixed(1)}" height="10" rx="5" fill="#4dc7de"/>`)
}

function formatPercent(value) {
  return value == null || !Number.isFinite(Number(value)) ? '-' : `${Number(value).toFixed(1)}%`
}

function formatUnits(value) {
  const number = Number(value)
  if (!Number.isFinite(number)) return '-'
  return `${number >= 0 ? '+' : ''}${number.toFixed(2)} 單位`
}

function unitColor(value) {
  const number = Number(value)
  return number > 0 ? '#71e6b1' : number < 0 ? '#ff858f' : '#dce8f4'
}

function formatDate(value) {
  const time = Date.parse(value ?? '')
  return Number.isFinite(time) ? new Date(time).toISOString().replace('T', ' ').slice(0, 19) : '-'
}

function safeInteger(value) {
  const number = Number(value)
  return Number.isSafeInteger(number) ? number : 0
}

function escapeXml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[character])
}
