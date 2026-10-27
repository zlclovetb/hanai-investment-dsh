import type { MarketBreadthData, MarketOverview, ProviderMeta, RankEntry, SectorBoard, StockQuote } from './index.ts'
import type { GlobalIndicesData } from './market-indices.ts'

export const MARKET_HISTORY_PANELS = ['overview', 'breadth', 'industry', 'concept', 'rank.gainers', 'rank.losers', 'rank.amount', 'rank.turnover', 'global.indices'] as const

export interface MarketPanelPayloads {
  'global.indices': GlobalIndicesData
  overview: MarketOverview
  breadth: MarketBreadthData
  industry: SectorBoard
  concept: SectorBoard
  'rank.gainers': { entries: RankEntry[]; meta: ProviderMeta }
  'rank.losers': { entries: RankEntry[]; meta: ProviderMeta }
  'rank.amount': { entries: RankEntry[]; meta: ProviderMeta }
  'rank.turnover': { entries: RankEntry[]; meta: ProviderMeta }
}

export interface MarketPanelSnapshot {
  key: string
  version: number
  capturedAt: string
  meta: ProviderMeta
  data: unknown
}

export interface MarketHistorySummary {
  date: string
  capturedAt: string
  panels: string[]
}

export interface MarketHistorySnapshot extends MarketHistorySummary {
  records: Record<string, MarketPanelSnapshot>
}

export function isMarketDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const timestamp = Date.parse(`${value}T00:00:00Z`)
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === value
}

export function beijingMarketDate(timestamp = Date.now()): string {
  return new Date(timestamp + 8 * 3_600_000).toISOString().slice(0, 10)
}

export function marketDateFromMeta(meta: ProviderMeta): string | null {
  const timestamp = meta.sourceTimestamp ?? meta.fetchedAt
  if (isMarketDate(timestamp)) return timestamp
  const parsed = Date.parse(timestamp)
  return Number.isFinite(parsed) ? beijingMarketDate(parsed) : null
}

const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
const numberOrNull = (value: unknown) => value === null || (typeof value === 'number' && Number.isFinite(value))
const namedRows = (value: unknown, fields: readonly string[]) => Array.isArray(value) && value.every(row => object(row)
  && typeof row.name === 'string' && typeof row.code === 'string' && fields.every(field => numberOrNull(row[field])))

export function isMarketProviderMeta(value: unknown): value is ProviderMeta {
  return object(value) && typeof value.providerId === 'string' && typeof value.sourceName === 'string'
    && typeof value.fetchedAt === 'string' && Number.isFinite(Date.parse(value.fetchedAt))
    && (value.sourceTimestamp === null || (typeof value.sourceTimestamp === 'string' && Number.isFinite(Date.parse(value.sourceTimestamp))))
    && ['fresh', 'cached', 'stale', 'unavailable'].includes(String(value.cacheState))
}

/** Validate stored version-1 payloads before charts consume them; unknown panel keys remain extensible. */
export function isMarketPanelPayload(key: string, value: unknown): boolean {
  if (!object(value)) return false
  if (key === 'global.indices') return namedRows(value.indices, ['price', 'change', 'changePct', 'amount']) && isMarketProviderMeta(value.meta)
    && (value.indices as Array<Record<string, unknown>>).every(row => isMarketProviderMeta(row.meta)
      && (row.marketDate === null || (typeof row.marketDate === 'string' && isMarketDate(row.marketDate))))
  if (key === 'overview') return namedRows(value.indices, ['price', 'change', 'changePct', 'amount'])
    && (value.indices as Array<Record<string, unknown>>).every(row => row.meta === undefined || isMarketProviderMeta(row.meta))
    && object(value.breadth) && numberOrNull(value.breadth.totalAmount) && isMarketProviderMeta(value.meta)
    && ['pre', 'trading', 'break', 'closed', 'unknown'].includes(String(value.marketStatus))
  if (key === 'breadth') return isMarketProviderMeta(value.meta) && typeof value.qdate === 'string' && isMarketDate(value.qdate)
    && ['up', 'down', 'flat', 'limitUp', 'limitDown'].every(field => Number.isSafeInteger(value[field]) && Number(value[field]) >= 0)
  if (key === 'industry' || key === 'concept') return value.type === key && namedRows(value.sectors, ['changePct', 'amount']) && isMarketProviderMeta(value.meta)
  if (key.startsWith('rank.')) return namedRows(value.entries, ['price', 'changePct', 'amount', 'turnoverRate'])
    && (value.entries as Array<Record<string, unknown>>).every(row => typeof row.secId === 'string') && isMarketProviderMeta(value.meta)
  if (key.startsWith('sector:')) return namedRows(value.stocks, ['price', 'changePct', 'amount', 'turnoverRate', 'marketCap'])
    && (value.stocks as Array<Record<string, unknown>>).every(row => typeof row.secId === 'string') && isMarketProviderMeta(value.meta)
  return true
}

export function marketHistoryPanel<K extends keyof MarketPanelPayloads>(snapshot: MarketHistorySnapshot | null, key: K): MarketPanelPayloads[K] | null
export function marketHistoryPanel(snapshot: MarketHistorySnapshot | null, key: `sector:${string}`): { stocks: StockQuote[]; meta: ProviderMeta } | null
export function marketHistoryPanel(snapshot: MarketHistorySnapshot | null, key: string): unknown {
  const panel = snapshot?.records[key]
  return panel?.version === 1 && isMarketPanelPayload(key, panel.data) ? panel.data : null
}
