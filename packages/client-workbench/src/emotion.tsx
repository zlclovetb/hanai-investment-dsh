import { useEffect } from 'react'
import type { MarketBreadthData, SearchResult } from '../../contracts/src/index.ts'
import { beijingMarketDate, isMarketDate, marketDateFromMeta, marketHistoryPanel } from '../../contracts/src/market-history.ts'
import { isMarketLunchBreak, isMarketOpen } from '../../contracts/src/market-hours.ts'
import type { MarketLadderData } from '../../contracts/src/market-ladder.ts'
import { closingSentimentPanels, isSentimentClose, sentimentMetrics, type SentimentDay } from '../../contracts/src/market-sentiment.ts'
import type { HanaiClient } from './api.ts'
import { dateTime } from './format.ts'
import { useMarketHistory } from './market-history.tsx'
import { useMarketSnapshot } from './market-snapshot.tsx'
import { TopicCyclePanel } from './topic-cycle.tsx'
import ui from './styles.module.css'
import styles from './emotion.module.css'

const value = (n: number | null) => n ?? '—'
const rate = (n: number | null) => n === null ? '—' : n.toFixed(1) + '%'
const board = (n: number | null) => n === null ? '—' : n === 0 ? '无封板' : n + ' 板'

function livePanels(date: string, ladder: MarketLadderData | null, breadth: MarketBreadthData | null) {
  const sameDate = (meta: MarketLadderData['meta']) => meta.cacheState !== 'unavailable' && marketDateFromMeta(meta) === date
  let activeLadder = ladder?.date === date && sameDate(ladder.meta) ? ladder : null
  if (activeLadder?.yesterdayPerformance && !sameDate(activeLadder.yesterdayPerformance.meta)) activeLadder = { ...activeLadder, yesterdayPerformance: null }
  return { ladder: activeLadder, breadth: breadth?.qdate === date && sameDate(breadth.meta) ? breadth : null }
}

function feedback(day: SentimentDay) {
  const { yesterdaySample, yesterdayAverage, yesterdayMedian } = day
  if (!yesterdaySample || yesterdayAverage === null || yesterdayMedian === null) return '接力反馈待核实'
  if (yesterdayAverage > 0 && yesterdayMedian > 0) return '接力反馈偏强'
  if (yesterdayAverage < 0 && yesterdayMedian < 0) return '接力反馈偏弱'
  if (yesterdayAverage === 0 && yesterdayMedian === 0) return '接力反馈持平'
  return '接力反馈分化'
}

export function EmotionPage({ client, onStock }: { client: HanaiClient; onStock: (row: SearchResult) => void }) {
  const history = useMarketHistory(client)
  const historical = history.selectedDate !== null
  const live = useMarketSnapshot(client, historical)
  const marketOpen = isMarketOpen()
  const intraday = !historical && marketOpen
  const snapshot = historical ? history.snapshot : live.data?.snapshot ?? null
  const rawLadder = marketHistoryPanel(snapshot, 'ladder')
  const rawBreadth = marketHistoryPanel(snapshot, 'breadth')
  const closeDates = !historical && !intraday ? [
    rawLadder && isSentimentClose(rawLadder.meta, rawLadder.date) ? rawLadder.date : '',
    rawBreadth && isSentimentClose(rawBreadth.meta, rawBreadth.qdate) ? rawBreadth.qdate : '',
  ] : []
  const date = history.selectedDate ?? (intraday ? beijingMarketDate() : closeDates.sort().at(-1) || snapshot?.date || beijingMarketDate())
  const { ladder, breadth } = intraday ? livePanels(date, rawLadder, rawBreadth) : closingSentimentPanels(date, rawLadder, rawBreadth)
  const day = sentimentMetrics(ladder, breadth)
  const feedbackMeta = ladder?.yesterdayPerformance?.meta
  const sourceTime = feedbackMeta?.sourceTimestamp
  const feedbackTime = sourceTime && !isMarketDate(sourceTime) ? sourceTime : feedbackMeta?.fetchedAt
  const closingPublication = marketOpen ? undefined : live.data?.id
  const reloadIndex = history.reloadIndex

  useEffect(() => { if (closingPublication) void reloadIndex() }, [closingPublication, reloadIndex])

  const sourceErrors = historical ? [] : [live.error, live.data?.errors.ladder, live.data?.errors.breadth].filter(Boolean)
  const mode = historical ? '历史收盘' : intraday ? (isMarketLunchBreak() ? '午休缓存' : '盘中快照') : '收盘数据'
  const now = Date.now()
  const topicQuotes = intraday ? live.data?.quotes?.quotes.filter(quote =>
    quote.meta?.sourceTimestamp != null && quote.meta.cacheState !== 'unavailable'
    && marketDateFromMeta(quote.meta) === date
    && Date.parse(quote.meta.sourceTimestamp) <= Date.parse(quote.meta.fetchedAt)
    && Date.parse(quote.meta.fetchedAt) <= now) : undefined
  const loading = historical ? history.loading : live.loading
  const marketEvidence = <aside className={styles.evidence} aria-label="行情依据">
    <header>
      <div><h2>行情依据</h2><p>{date} · {mode}</p></div>
      {!historical && <button className={ui.button} type="button" disabled={live.refreshing || live.cooldown > 0}
        onClick={() => void live.refresh()}>{live.refreshing ? '刷新中' : live.cooldown > 0 ? `刷新 ${live.cooldown}s` : '刷新'}</button>}
    </header>
    {history.error && <p role="alert" className={styles.warning}>历史快照读取失败 · {history.error}</p>}
    {sourceErrors.length > 0 && <p role="status" className={styles.warning}>{[...new Set(sourceErrors)].join(' · ')}</p>}
    {ladder || breadth ? <>
      <p className={styles.feedback}>{feedback(day)}</p>
      <dl className={styles.metrics}>
        <div><dt>涨停 / 跌停</dt><dd>{value(day.limitUp)} / {value(day.limitDown)}</dd></div>
        <div><dt>最高连板</dt><dd>{board(day.highest)}</dd></div>
        <div><dt>炸板率</dt><dd>{rate(day.brokenRate)}</dd></div>
        <div><dt>晋级率</dt><dd>{rate(day.promotionRate)}</dd></div>
      </dl>
      <details><summary>来源与时间</summary>
        {[ladder?.meta, breadth?.meta, feedbackMeta].map((meta, i) => meta && <p key={i}>{meta.sourceName} · {dateTime(meta.fetchedAt)}</p>)}
        {ladder?.issues.map(issue => <p key={issue}>{issue}</p>)}
      </details>
    </> : <p>{loading ? '正在读取行情…' : intraday ? '暂无同日可用行情。' : '该日暂无可核实的收盘行情。'}</p>}
  </aside>

  return <div className={`${ui.page} ${styles.page}`} role="region" aria-label="短线情绪看板" tabIndex={0}>
    <TopicCyclePanel client={client} onStock={onStock} date={history.selectedDate ?? ''}
      onDate={day => history.selectDate(day || null)}
      archiveDates={history.snapshots.filter(row => row.panels.some(panel => panel === 'ladder' || panel === 'breadth')).map(row => row.date)}
      marketEvidence={marketEvidence}
      market={feedbackMeta && feedbackTime && Date.parse(feedbackTime) <= Date.parse(feedbackMeta.fetchedAt) && Date.parse(feedbackMeta.fetchedAt) <= now
        ? { date, label: feedback(day), observedAt: feedbackTime, cached: feedbackMeta.cacheState === 'stale' || (intraday && isMarketLunchBreak()), intraday } : undefined}
      intraday={intraday ? { date: beijingMarketDate(), ladder, quotes: topicQuotes } : undefined} />
  </div>
}
