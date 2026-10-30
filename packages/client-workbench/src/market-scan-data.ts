import type { DashboardData, ProviderMeta, RankEntry } from '../../contracts/src/index.ts'
import type { MarketHistorySnapshot } from '../../contracts/src/market-history.ts'
import { marketHistoryPanel } from '../../contracts/src/market-history.ts'
import { isClosingPanelCurrent } from './market-history.tsx'
import { DOMESTIC_INDICES } from '../../contracts/src/market-indices.ts'

export const SCAN_RANKS = { gainers: '涨幅榜', losers: '跌幅榜', amount: '成交额榜', turnover: '换手率榜' } as const
export type ScanRank = keyof typeof SCAN_RANKS
export interface ScanFilters { query: string; minPrice: string; maxPrice: string; minChange: string; minAmount: string; minTurnover: string; excludeST: boolean }
export const EMPTY_SCAN_FILTERS: ScanFilters = { query: '', minPrice: '', maxPrice: '', minChange: '', minAmount: '', minTurnover: '', excludeST: false }

export function filterScanRows(rows: RankEntry[], filters: ScanFilters): { rows: RankEntry[]; error: string | null } {
  const numeric = [filters.minPrice, filters.maxPrice, filters.minChange, filters.minAmount, filters.minTurnover]
  if (numeric.some(value => value.trim() !== '' && !Number.isFinite(Number(value)))) return { rows: [], error: '筛选条件必须是有效数字' }
  const [min, max, change, amount, turnover] = numeric.map(value => value.trim() === '' ? null : Number(value)) as [number | null, number | null, number | null, number | null, number | null]
  if ([min, max, amount, turnover].some(value => value !== null && value < 0) || (min !== null && max !== null && min > max)) return { rows: [], error: '价格、成交额及换手率不能为负，最低价不能高于最高价' }
  const query = filters.query.trim().toLowerCase()
  return { error: null, rows: rows.filter(row => (!query || row.name.toLowerCase().includes(query) || row.code.includes(query))
    && (!filters.excludeST || !/^(?:S\*?ST|\*?ST)/i.test(row.name))
    && (min === null || (row.price !== null && row.price >= min))
    && (max === null || (row.price !== null && row.price <= max))
    && (change === null || (row.changePct !== null && row.changePct >= change))
    && (amount === null || (row.amount !== null && row.amount >= amount * 1e8))
    && (turnover === null || (row.turnoverRate !== null && row.turnoverRate >= turnover))) }
}

export function scanArchiveCurrent(snapshot: MarketHistorySnapshot): boolean {
  return (['overview', 'industry', 'concept', 'rank.gainers', 'rank.losers', 'rank.amount', 'rank.turnover'] as const)
    .every(key => { const record = snapshot.records[key]; return marketHistoryPanel(snapshot, key) !== null && record !== undefined && isClosingPanelCurrent(record.meta) })
    && DOMESTIC_INDICES.every(item => marketHistoryPanel(snapshot, 'overview')?.indices.some(index => index.code === item.code))
    && (marketHistoryPanel(snapshot, 'overview')?.indices ?? []).every(index => isClosingPanelCurrent(index.meta ?? snapshot.records.overview!.meta))
}

/** Preserve each failed surface independently, with its original provenance and an explicit stale state. */
export function mergeScanDashboard(previous: DashboardData | null, next: DashboardData): DashboardData {
  if (previous === null) return next
  const failed = (meta: ProviderMeta | undefined) => meta?.cacheState === 'unavailable'
  const stale = (meta: ProviderMeta): ProviderMeta => ({ ...meta, cacheState: 'stale' })
  const result: DashboardData = { ...next, ranks: { ...next.ranks }, rankSources: { ...next.rankSources } as NonNullable<DashboardData['rankSources']> }
  if (failed(next.overview.meta) && !failed(previous.overview.meta)) result.overview = { ...previous.overview, meta: stale(previous.overview.meta) }
  for (const type of ['industry', 'concept'] as const) if (failed(next[type].meta) && !failed(previous[type].meta)) result[type] = { ...previous[type], meta: stale(previous[type].meta) }
  for (const type of Object.keys(SCAN_RANKS) as ScanRank[]) {
    const meta = next.rankSources?.[type] ?? next.overview.meta
    if (failed(meta) && !failed(previous.rankSources?.[type] ?? previous.overview.meta)) { result.ranks[type] = previous.ranks[type]; result.rankSources![type] = stale(previous.rankSources?.[type] ?? previous.overview.meta) }
    else result.rankSources![type] = meta
  }
  return result
}
