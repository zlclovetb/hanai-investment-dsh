import type { MarketBreadthData, MarketOverview, ProviderMeta, RankEntry, SectorBoard, StockQuote } from './index.ts'
import { MACRO_ETFS, type MacroEtfInputs, type MacroAllDailyData, macroAllTotals, type MacroAllEtfData, type MacroCapitalData, type MacroEtfData, type MacroIndexData, type MacroDailyEtfData } from './market-macro.ts'
import type { GlobalIndicesData } from './market-indices.ts'
import type { MarketIntradayData, MarketSignalsData } from './market-activity.ts'

export const MARKET_HISTORY_PANELS = ['overview', 'breadth', 'industry', 'concept', 'rank.gainers', 'rank.losers', 'rank.amount', 'rank.turnover', 'global.indices', 'intraday', 'signals', 'macro.etf', 'macro.index', 'macro.etf.daily', 'macro.capital', 'macro.etf.all.quarter', 'macro.etf.inputs', 'macro.etf.all.daily'] as const

export interface MarketPanelPayloads {
  'macro.etf.inputs': MacroEtfInputs
  'macro.etf.all.daily': MacroAllDailyData
  'macro.etf.all.quarter': MacroAllEtfData
  'macro.capital': MacroCapitalData
  'macro.etf.daily': MacroDailyEtfData
  'macro.etf': MacroEtfData
  'macro.index': MacroIndexData
  intraday: MarketIntradayData
  signals: MarketSignalsData
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
  if (key === 'macro.etf.inputs') return isMarketProviderMeta(value.meta) && Array.isArray(value.funds) && value.funds.length > 0 && value.funds.length <= 100
    && value.funds.every((fund, i, funds) => object(fund) && typeof fund.code === 'string' && /^\d{6}$/.test(fund.code)
      && !funds.slice(0, i).some(previous => object(previous) && previous.code === fund.code)
      && typeof fund.navFetchedAt === 'string' && Number.isFinite(Date.parse(fund.navFetchedAt))
      && Array.isArray(fund.navs) && fund.navs.length > 0 && Array.isArray(fund.shares)
      && [fund.navs, fund.shares].every(rows => rows.every((row, j) => object(row) && typeof row.date === 'string' && isMarketDate(row.date)
        && (j === 0 || (object(rows[j - 1]) && String(rows[j - 1].date) < row.date))
        && typeof row.value === 'number' && Number.isFinite(row.value) && row.value > 0))
      && fund.shares.every(row => object(row) && typeof row.fetchedAt === 'string' && Number.isFinite(Date.parse(row.fetchedAt))))
    && (value.funds as MacroEtfInputs['funds']).flatMap(fund => [...fund.navs, ...fund.shares].map(row => row.date)).sort().at(-1) === value.meta.sourceTimestamp
  if (key === 'macro.etf.all.daily') return isMarketProviderMeta(value.meta) && typeof value.universeAsOf === 'string' && isMarketDate(value.universeAsOf)
    && Array.isArray(value.funds) && value.funds.length >= 4 && value.funds.length <= 100
    && MACRO_ETFS.every(etf => (value.funds as unknown[]).some(fund => object(fund) && fund.code === etf.code))
    && value.funds.every((fund, i, funds) => object(fund) && typeof fund.code === 'string' && /^(5\d{5}|159\d{3})$/.test(fund.code)
      && !funds.slice(0, i).some(previous => object(previous) && previous.code === fund.code)
      && typeof fund.name === 'string' && fund.name.trim() !== '' && typeof fund.listedOn === 'string' && isMarketDate(fund.listedOn)
      && (fund.inactiveFrom === undefined || (typeof fund.inactiveFrom === 'string' && isMarketDate(fund.inactiveFrom) && fund.inactiveFrom > fund.listedOn))
      && (fund.delistedOn === undefined || (typeof fund.delistedOn === 'string' && isMarketDate(fund.delistedOn) && fund.delistedOn >= String(fund.inactiveFrom ?? fund.listedOn))))
    && Array.isArray(value.points) && Array.isArray(value.missingDates) && value.points.length + value.missingDates.length > 0
    && Number.isSafeInteger(value.expectedDays) && Number(value.expectedDays) >= value.points.length + value.missingDates.length
    && typeof value.complete === 'boolean' && value.complete === (value.points.length === value.expectedDays)
    && value.points.every((point, i, points) => object(point) && typeof point.date === 'string' && isMarketDate(point.date) && point.date <= String(value.universeAsOf)
      && (i === 0 || (object(points[i - 1]) && String(points[i - 1].date) < point.date))
      && typeof point.assets === 'number' && Number.isFinite(point.assets) && point.assets > 0
      && typeof point.fourAssets === 'number' && Number.isFinite(point.fourAssets) && point.fourAssets > 0
      && typeof point.otherAssets === 'number' && Number.isFinite(point.otherAssets) && point.otherAssets >= 0
      && Math.abs(point.assets - point.fourAssets - point.otherAssets) <= 0.021)
    && value.missingDates.every((row, i, rows) => object(row) && typeof row.date === 'string' && isMarketDate(row.date) && row.date <= String(value.universeAsOf)
      && (i === 0 || (object(rows[i - 1]) && String(rows[i - 1].date) < row.date))
      && !(value.points as Array<{ date: string }>).some(point => point.date === row.date) && typeof row.reason === 'string' && row.reason.trim() !== '')
    && [...(value.points as Array<{ date: string }>), ...(value.missingDates as Array<{ date: string }>)].map(row => row.date).sort().at(-1) === value.meta.sourceTimestamp
  if (key === 'macro.etf.all.quarter') return isMarketProviderMeta(value.meta) && typeof value.universeAsOf === 'string' && isMarketDate(value.universeAsOf)
    && Array.isArray(value.funds) && value.funds.length >= 4 && value.funds.length <= 60
    && MACRO_ETFS.every(etf => (value.funds as unknown[]).some(fund => object(fund) && fund.code === etf.code))
    && value.funds.every((fund, i, funds) => object(fund) && typeof fund.code === 'string' && /^\d{6}$/.test(fund.code)
      && !funds.slice(0, i).some(previous => object(previous) && previous.code === fund.code)
      && typeof fund.name === 'string' && fund.name.trim() !== '' && typeof fund.inceptionDate === 'string' && isMarketDate(fund.inceptionDate)
      && Array.isArray(fund.points) && fund.points.every((point, j, points) => object(point) && typeof point.date === 'string' && isMarketDate(point.date)
        && /-(03-31|06-30|09-30|12-31)$/.test(point.date) && point.date >= String(fund.inceptionDate) && point.date <= String(value.universeAsOf)
        && (j === 0 || (object(points[j - 1]) && String(points[j - 1].date) < point.date))
        && typeof point.assets === 'number' && Number.isFinite(point.assets) && point.assets > 0))
    && macroAllTotals(value as unknown as MacroAllEtfData).at(-1)?.date === value.meta.sourceTimestamp
  if (key === 'macro.capital') return isMarketProviderMeta(value.meta) && Array.isArray(value.points) && value.points.length > 0
    && typeof value.complete === 'boolean' && Array.isArray(value.checkedMonths)
    && value.checkedMonths.every((month, i, months) => typeof month === 'string' && /^\d{4}(0[1-9]|1[0-2])$/.test(month) && (i === 0 || String(months[i - 1]) < month))
    && object(value.points.at(-1)) && value.meta.sourceTimestamp === value.points.at(-1).date
    && value.points.every((point, i, points) => object(point) && typeof point.date === 'string' && isMarketDate(point.date)
      && (value.checkedMonths as unknown[]).includes(point.date.slice(0, 7).replace('-', ''))
      && (i === 0 || (object(points[i - 1]) && String(points[i - 1].date) < point.date))
      && typeof point.floatCap === 'number' && Number.isFinite(point.floatCap) && point.floatCap > 0)
  if (key === 'macro.etf.daily') return isMarketProviderMeta(value.meta) && Array.isArray(value.points) && value.points.length > 0
    && Number.isSafeInteger(value.expectedDays) && Number(value.expectedDays) >= value.points.length && typeof value.complete === 'boolean'
    && value.complete === (value.points.length === value.expectedDays)
    && object(value.points.at(-1)) && value.meta.sourceTimestamp === value.points.at(-1).date
    && value.points.every((point, i, points) => object(point) && typeof point.date === 'string' && isMarketDate(point.date)
      && (i === 0 || (object(points[i - 1]) && String(points[i - 1].date) < point.date))
      && typeof point.assets === 'number' && Number.isFinite(point.assets) && point.assets > 0)
  if (key === 'macro.index') return isMarketProviderMeta(value.meta) && Array.isArray(value.points) && value.points.length > 0
    && value.points.every(point => object(point) && typeof point.date === 'string' && isMarketDate(point.date)
      && typeof point.close === 'number' && Number.isFinite(point.close) && point.close > 0)
  if (key === 'macro.etf') return isMarketProviderMeta(value.meta) && Array.isArray(value.funds) && value.funds.length === MACRO_ETFS.length
    && MACRO_ETFS.every(etf => (value.funds as unknown[]).filter(fund => object(fund) && fund.code === etf.code).length === 1)
    && value.funds.every(fund => object(fund) && Array.isArray(fund.points) && fund.points.length > 0
      && fund.points.every(point => object(point) && typeof point.date === 'string' && isMarketDate(point.date)
        && typeof point.assets === 'number' && Number.isFinite(point.assets) && point.assets > 0))
  if (key === 'intraday' || key === 'signals') {
    if (typeof value.date !== 'string' || !isMarketDate(value.date) || !isMarketProviderMeta(value.meta)) return false
    if (key === 'intraday') return numberOrNull(value.prevClose) && Array.isArray(value.points) && value.points.length > 0
      && value.points.every(point => object(point) && typeof point.time === 'string' && /^(09|10|11|13|14|15):[0-5]\d$/.test(point.time)
        && typeof point.price === 'number' && Number.isFinite(point.price) && point.price > 0 && numberOrNull(point.avgPrice)
        && typeof point.volume === 'number' && Number.isFinite(point.volume) && point.volume >= 0)
    return (value.method === undefined || value.method === 'ths-sector-events-v2') && Array.isArray(value.signals) && value.signals.every(signal => object(signal)
      && typeof signal.time === 'string' && /^\d{2}:\d{2}$/.test(signal.time) && typeof signal.name === 'string'
      && typeof signal.code === 'string' && typeof signal.title === 'string' && ['up', 'down'].includes(String(signal.direction)))
  }
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
