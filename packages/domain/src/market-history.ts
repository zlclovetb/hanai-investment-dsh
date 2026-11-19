import type { DatabaseSync } from 'node:sqlite'
import type { MarketOverview, ProviderMeta } from '../../contracts/src/index.ts'
import type { GlobalIndicesData } from '../../contracts/src/market-indices.ts'
import { limitBoardType, type MarketLadderData } from '../../contracts/src/market-ladder.ts'
import { isMarketDate, isMarketPanelPayload, isMarketProviderMeta, marketDateFromMeta, marketHistoryPanel, type MarketPanelPayloads, type MarketHistorySnapshot, type MarketHistorySummary, type MarketPanelSnapshot } from '../../contracts/src/market-history.ts'

const observationTime = (meta: ProviderMeta): number => Date.parse(meta.sourceTimestamp !== null && !isMarketDate(meta.sourceTimestamp) ? meta.sourceTimestamp : meta.fetchedAt)

function mergeLadderDetails(previous: MarketLadderData | null, incoming: MarketLadderData): MarketLadderData {
  if (previous && observationTime(previous.meta) > observationTime(incoming.meta)) return incoming
  const topicReasons = { ...previous?.topicReasons }
  const turnoverBoards = new Set(previous?.turnoverBoards)
  const previousStocks = new Map(previous?.stocks.map(stock => [stock.code, stock]))
  for (const stock of previous?.stocks ?? []) {
    const reason = stock.reason?.trim()
    if (reason) topicReasons[stock.code] = reason
    if (limitBoardType(stock.boardType) === '换手板') turnoverBoards.add(stock.code)
  }
  const stocks = incoming.stocks.map(stock => {
    const reason = stock.reason?.trim() || topicReasons[stock.code] || null
    const prior = previousStocks.get(stock.code)
    // A new open or seal may invalidate an earlier 一字板 or T字板 classification.
    const sameSeal = prior && prior.firstSeal === stock.firstSeal && prior.lastSeal === stock.lastSeal
      && (stock.breaks === null || (prior.breaks ?? 0) === stock.breaks)
    const boardType = limitBoardType(stock.boardType) ?? (turnoverBoards.has(stock.code) ? '换手板' : sameSeal ? limitBoardType(prior.boardType) : null)
    delete topicReasons[stock.code]
    turnoverBoards.delete(stock.code)
    return reason === stock.reason && boardType === stock.boardType ? stock : { ...stock, reason, boardType }
  })
  const issues = stocks.every(stock => stock.reason !== null)
    ? incoming.issues.filter(issue => issue !== '部分涨停股缺少题材归因') : incoming.issues
  const merged = { ...incoming, stocks, issues }
  if (Object.keys(topicReasons).length) merged.topicReasons = topicReasons
  else delete merged.topicReasons
  if (turnoverBoards.size) merged.turnoverBoards = [...turnoverBoards]
  else delete merged.turnoverBoards
  return merged
}

function mergeGlobalIndices(previous: GlobalIndicesData | null, incoming: GlobalIndicesData): GlobalIndicesData | null {
  const indices = new Map((previous?.indices ?? []).map(index => [index.code, index]))
  let changed = false
  for (const index of incoming.indices) {
    if (index.price === null || index.meta.sourceTimestamp === null || index.meta.cacheState === 'unavailable') continue
    const old = indices.get(index.code)
    if (old !== undefined && observationTime(index.meta) <= observationTime(old.meta)) continue
    indices.set(index.code, index)
    changed = true
  }
  return changed ? { ...incoming, indices: [...indices.values()] } : null
}

function mergeOverview(previous: MarketOverview | null, incoming: MarketOverview, date: string): MarketOverview | null {
  const indices = new Map((previous?.indices ?? []).map(index => [index.code, { ...index, meta: index.meta ?? previous!.meta }]))
  let changed = false
  const current = new Set<string>()
  for (const index of incoming.indices) {
    const meta = index.meta ?? incoming.meta
    if (meta.sourceTimestamp === null || marketDateFromMeta(meta) !== date || meta.cacheState === 'unavailable') continue
    const old = indices.get(index.code)
    if (old !== undefined && observationTime(meta) < observationTime(old.meta)) continue
    current.add(index.code)
    if (old !== undefined && observationTime(meta) === observationTime(old.meta)) continue
    indices.set(index.code, { ...index, meta })
    changed = true
  }
  if (!changed) return null
  const values = [...indices.values()]
  const meta = values.reduce((latest, index) => observationTime(index.meta) > observationTime(latest) ? index.meta : latest, values[0]!.meta)
  const sh = indices.get('000001')
  const sz = indices.get('399001')
  const totalAmount = current.has('000001') && current.has('399001') && sh?.amount != null && sz?.amount != null ? sh.amount + sz.amount : null
  return { ...incoming, indices: values, meta, breadth: { ...incoming.breadth, totalAmount } }
}

interface PanelRow {
  date: string
  panel_key: string
  version: number
  captured_at: string
  observed_at: string
  payload: string
  meta: string
}

/** Daily panel snapshots are business records, independent of disposable provider caches. */
export class MarketHistoryStore {
  constructor(private readonly sqlite: DatabaseSync) {}

  save<K extends keyof MarketPanelPayloads>(key: K, data: MarketPanelPayloads[K], meta: ProviderMeta, date?: string, capturedAt?: string): MarketPanelPayloads[K]
  save(key: string, data: unknown, meta: ProviderMeta, date?: string, capturedAt?: string): unknown
  save(key: string, data: unknown, meta: ProviderMeta, date = marketDateFromMeta(meta), capturedAt = new Date().toISOString()): unknown {
    if (date === null || !isMarketDate(date) || !/^[A-Za-z0-9_.:-]{1,150}$/.test(key) || !Number.isFinite(Date.parse(capturedAt))) throw new Error('市场历史日期或面板标识无效')
    if (!isMarketProviderMeta(meta) || !isMarketPanelPayload(key, data)) throw new Error('市场历史面板数据无效')
    if (meta.cacheState === 'unavailable' || (meta.cacheState === 'stale' && meta.sourceTimestamp === null)) return data
    if (key === 'ladder') {
      const ladder = data as MarketLadderData
      if (ladder.date !== date) throw new Error('涨停梯队日期与归档日期不符')
      data = mergeLadderDetails(marketHistoryPanel(this.get(date, 'ladder'), 'ladder'), ladder)
    }
    if (key === 'global.indices') {
      const merged = mergeGlobalIndices(marketHistoryPanel(this.get(date), 'global.indices'), data as GlobalIndicesData)
      if (merged === null) return marketHistoryPanel(this.get(date), 'global.indices') ?? data
      data = merged
    }
    if (key === 'overview') {
      const merged = mergeOverview(marketHistoryPanel(this.get(date), 'overview'), data as MarketOverview, date)
      if (merged === null) return marketHistoryPanel(this.get(date), 'overview') ?? data
      data = merged
      meta = merged.meta
    }
    const source = meta.sourceTimestamp
    const observedAt = source !== null && !isMarketDate(source) ? new Date(source).toISOString() : new Date(meta.fetchedAt).toISOString()
    this.sqlite.prepare(`
      INSERT INTO market_panel_snapshots(date, panel_key, version, captured_at, observed_at, payload, meta)
      VALUES(?, ?, 1, ?, ?, ?, ?)
      ON CONFLICT(date, panel_key) DO UPDATE SET version = excluded.version,
        captured_at = excluded.captured_at, observed_at = excluded.observed_at,
        payload = excluded.payload, meta = excluded.meta
      WHERE excluded.observed_at > market_panel_snapshots.observed_at
        OR (? = 'macro.series' AND excluded.observed_at = market_panel_snapshots.observed_at)
        OR ? IN ('overview', 'global.indices')
    `).run(date, key, capturedAt, observedAt, JSON.stringify(data), JSON.stringify(meta), key, key)
    return data
  }

  get(date: string, key?: string): MarketHistorySnapshot | null {
    if (!isMarketDate(date)) throw new Error('市场历史日期无效')
    const rows = this.sqlite.prepare("SELECT * FROM market_panel_snapshots WHERE date = ? AND (? IS NULL OR panel_key = ?) AND (? IS NOT NULL OR panel_key NOT LIKE 'scan:%') ORDER BY panel_key").all(date, key ?? null, key ?? null, key ?? null) as unknown as PanelRow[]
    const records: Record<string, MarketPanelSnapshot> = Object.create(null)
    for (const row of rows) {
      try {
        const data: unknown = JSON.parse(row.payload)
        const meta: unknown = JSON.parse(row.meta)
        if (row.version !== 1 || !Number.isFinite(Date.parse(row.captured_at)) || !isMarketProviderMeta(meta) || !isMarketPanelPayload(row.panel_key, data)) continue
        records[row.panel_key] = { key: row.panel_key, version: row.version, capturedAt: row.captured_at, data, meta }
      } catch { /* A damaged panel must not hide the rest of the day's records. */ }
    }
    const panels = Object.keys(records)
    if (panels.length === 0) return null
    return { date, panels, capturedAt: Object.values(records).map(panel => panel.capturedAt).sort().at(-1)!, records }
  }

  list(scope: 'all' | 'market' = 'all'): MarketHistorySummary[] {
    const rows = this.sqlite.prepare(`SELECT date, MAX(captured_at) AS captured_at, GROUP_CONCAT(panel_key) AS panels
      FROM market_panel_snapshots WHERE (? = 'all' OR (panel_key NOT LIKE 'macro.%' AND panel_key NOT LIKE 'scan:%'))
      GROUP BY date ORDER BY date DESC`).all(scope) as unknown as Array<{ date: string; captured_at: string; panels: string }>
    return rows.map(row => ({ date: row.date, capturedAt: row.captured_at, panels: row.panels.split(',') }))
  }
}
