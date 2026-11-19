import type { ProviderMeta, StockQuote } from './index.ts'
import type { MarketHistorySnapshot } from './market-history.ts'
import { beijingMarketDate, isMarketDate } from './market-history.ts'
import { DOMESTIC_INDICES } from './market-indices.ts'

export const MARKET_SNAPSHOT_PANELS = ['overview', 'industry', 'concept', 'rank.gainers', 'rank.losers', 'rank.amount', 'rank.turnover', 'breadth', 'ladder', 'distribution', 'arms', 'intraday', 'signals', 'global.indices'] as const

/** Polling's weekday policy. Source market dates still determine archive ownership. */
export function latestClosingMarketDate(now = new Date()): string {
  const bj = new Date(now.getTime() + 8 * 3_600_000)
  if (bj.getUTCHours() * 60 + bj.getUTCMinutes() <= 905) bj.setUTCDate(bj.getUTCDate() - 1)
  while (bj.getUTCDay() === 0 || bj.getUTCDay() === 6) bj.setUTCDate(bj.getUTCDate() - 1)
  return bj.toISOString().slice(0, 10)
}

export function isClosingPanelCurrent(meta: ProviderMeta, now = new Date()): boolean {
  const date = latestClosingMarketDate(now)
  const fetched = Date.parse(meta.fetchedAt)
  if (!Number.isFinite(fetched) || fetched > now.getTime() || meta.cacheState === 'unavailable') return false
  if (meta.sourceTimestamp === null) return meta.cacheState !== 'stale' && fetched >= Date.parse(date + 'T15:05:00+08:00')
  if (isMarketDate(meta.sourceTimestamp)) return meta.sourceTimestamp === date && fetched >= Date.parse(date + 'T15:05:00+08:00')
  const source = Date.parse(meta.sourceTimestamp)
  return beijingMarketDate(source) === date && source >= Date.parse(date + 'T15:00:00+08:00') && source <= fetched
}

export function closingOverviewComplete(data: import('./index.ts').MarketOverview, now = new Date()): boolean {
  return isClosingPanelCurrent(data.meta, now) && DOMESTIC_INDICES.every(item => data.indices.some(index => index.code === item.code))
    && data.indices.every(index => isClosingPanelCurrent(index.meta ?? data.meta, now))
}

/** One published Host acquisition round. Source timestamps remain attached to each panel. */
export interface MarketSnapshot {
  id: string
  startedAt: string
  publishedAt: string
  snapshot: MarketHistorySnapshot | null
  errors: Record<string, string>
  quotes: { quotes: StockQuote[]; meta: ProviderMeta } | null
  quoteCodes: string[]
}

export interface MarketSnapshotResponse {
  data: MarketSnapshot | null
  refreshAvailableAt: number
}
