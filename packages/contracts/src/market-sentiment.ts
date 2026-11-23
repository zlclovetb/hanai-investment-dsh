import type { MarketBreadthData, ProviderMeta } from './index.ts'
import { isMarketDate, marketDateFromMeta } from './market-history.ts'
import type { MarketLadderData } from './market-ladder.ts'

export interface SentimentDay {
  limitUp: number | null
  limitDown: number | null
  highest: number | null
  brokenRate: number | null
  promotionRate: number | null
  yesterdayAverage: number | null
  yesterdayMedian: number | null
  yesterdaySample: number | null
}

export function isSentimentClose(meta: ProviderMeta, date: string, now = new Date()): boolean {
  const fetched = Date.parse(meta.fetchedAt)
  if (meta.cacheState === 'unavailable' || marketDateFromMeta(meta) !== date || !(fetched <= now.getTime())) return false
  const source = meta.sourceTimestamp
  if (source === null || isMarketDate(source)) {
    return meta.cacheState !== 'stale' && fetched >= Date.parse(date + 'T15:05:00+08:00')
  }
  const observed = Date.parse(source)
  return observed >= Date.parse(date + 'T15:00:00+08:00') && observed <= fetched
}

const percent = (n: number, total: number) => total > 0 ? n / total * 100 : null

export function sentimentMetrics(ladder: MarketLadderData | null, breadth: MarketBreadthData | null): SentimentDay {
  const performance = ladder?.yesterdayPerformance
  const promotion = ladder?.promotion
  return {
    limitUp: breadth?.limitUp ?? null,
    limitDown: breadth?.limitDown ?? null,
    highest: ladder ? Math.max(0, ...ladder.stocks.map(stock => stock.boards)) : null,
    brokenRate: ladder?.broken == null ? null : percent(ladder.broken, ladder.broken + ladder.stocks.length),
    promotionRate: promotion ? percent(promotion.promoted, promotion.eligible) : null,
    yesterdayAverage: performance?.average ?? null,
    yesterdayMedian: performance?.median ?? null,
    yesterdaySample: performance?.sample ?? null,
  }
}

export function closingSentimentPanels(date: string, ladder: MarketLadderData | null, breadth: MarketBreadthData | null, now = new Date()) {
  let closedLadder = ladder?.date === date && isSentimentClose(ladder.meta, date, now) ? ladder : null
  const performance = closedLadder?.yesterdayPerformance
  if (closedLadder && performance && !isSentimentClose(performance.meta, date, now)) closedLadder = { ...closedLadder, yesterdayPerformance: null }
  return {
    ladder: closedLadder,
    breadth: breadth?.qdate === date && isSentimentClose(breadth.meta, date, now) ? breadth : null,
  }
}
