import { randomUUID } from 'node:crypto'
import type { ProviderMeta, DashboardPanelKey } from '../../contracts/src/index.ts'
import { isTencentMinuteEnd } from '../../contracts/src/market-activity.ts'
import { beijingMarketDate, isMarketDate, isMarketPanelPayload, isMarketProviderMeta, marketDateFromMeta, marketHistoryPanel, type MarketHistorySnapshot, type MarketPanelSnapshot } from '../../contracts/src/market-history.ts'
import { MARKET_SNAPSHOT_PANELS, closingOverviewComplete, isClosingPanelCurrent, type MarketSnapshot } from '../../contracts/src/market-snapshot.ts'
import { isMarketLunchBreak, isMarketResting } from '../../contracts/src/market-hours.ts'
import type { HanaiDatabase } from '../../domain/src/database.ts'
import type { MarketHistoryStore } from '../../domain/src/market-history.ts'
import type { MarketFacade } from './service.ts'

const CURRENT = 'market.snapshot.current'
const MANUAL = 'market.snapshot.manualAt'
const observedAt = (meta: ProviderMeta) => Date.parse(meta.sourceTimestamp && !isMarketDate(meta.sourceTimestamp) ? meta.sourceTimestamp : meta.fetchedAt)
const message = (cause: unknown) => cause instanceof Error ? cause.message : String(cause)
type Panel = { data: unknown; meta: ProviderMeta; date?: string }

/** Sole owner of today's market acquisition. Readers never start individual panel requests. */
export class MarketSnapshots {
  private current: MarketSnapshot | null = null
  private pending: Promise<MarketSnapshot> | null = null
  private timer: ReturnType<typeof setInterval> | null = null
  private stopped = false
  private checked = false
  private attemptedAt = -Infinity
  private quoteDate = ''
  private readonly extraCodes = new Set<string>()
  private readonly sectors = new Set<string>()
  private candidates: () => string[] = () => []
  private listeners: Array<(value: MarketSnapshot) => Promise<void> | void> = []

  constructor(private readonly market: MarketFacade, private readonly history: MarketHistoryStore, private readonly database: HanaiDatabase) {
    const saved = database.getSetting(CURRENT)
    if (saved) {
      try {
        const value = JSON.parse(saved) as MarketSnapshot
        if (typeof value.id !== 'string' || !Number.isFinite(Date.parse(value.publishedAt)) || !Number.isFinite(Date.parse(value.startedAt))
          || Date.parse(value.publishedAt) > Date.now() || !Array.isArray(value.quoteCodes) || !value.quoteCodes.every(code => /^\d{6}$/.test(code))
          || !value.errors || Object.values(value.errors).some(error => typeof error !== 'string')
          || (value.snapshot && (!isMarketDate(value.snapshot.date) || !value.snapshot.records
            || Object.entries(value.snapshot.records).some(([key, record]) => record.version !== 1 || !isMarketProviderMeta(record.meta) || !isMarketPanelPayload(key, record.data))))
          || (value.quotes && (!isMarketProviderMeta(value.quotes.meta) || !Array.isArray(value.quotes.quotes)))) throw new Error('已保存统一快照无效')
        this.current = value
      } catch { /* The existing per-panel archives remain available if a cached publication is damaged. */ }
    }
    if (!this.current) {
      const latest = history.list('market').find(row => row.date <= beijingMarketDate() && row.panels.includes('overview'))
      const snapshot = latest ? history.get(latest.date) : null
      if (snapshot) {
        const records = Object.fromEntries(Object.entries(snapshot.records).filter(([key]) => MARKET_SNAPSHOT_PANELS.includes(key as typeof MARKET_SNAPSHOT_PANELS[number]) || key.startsWith('sector:')))
        const global = history.list('market').find(row => row.date <= beijingMarketDate() && row.panels.includes('global.indices'))
        const indices = global ? history.get(global.date, 'global.indices')?.records['global.indices'] : null
        if (indices) records['global.indices'] = indices
        this.current = { id: randomUUID(), startedAt: snapshot.capturedAt, publishedAt: snapshot.capturedAt,
          snapshot: { ...snapshot, records, panels: Object.keys(records) }, quotes: null, quoteCodes: [], errors: {} }
      }
    }
  }
  setCandidates(read: () => string[]): void { this.candidates = read }
  onPublish(listener: (value: MarketSnapshot) => Promise<void> | void): void { this.listeners.push(listener) }
  peek(): MarketSnapshot | null { return this.current }
  get refreshAvailableAt(): number {
    const last = this.database.getSetting(MANUAL)
    return last && Number.isFinite(Number(last)) ? Number(last) + 60_000 : 0
  }
  async settled(): Promise<MarketSnapshot | null> { return this.pending ? this.pending : this.current }
  start(): void {
    if (this.timer || this.stopped) return
    this.timer = setInterval(() => { void this.update().catch(() => {}) }, 30_000)
    this.timer.unref()
    void this.update().catch(() => {})
  }
  dispose(): void {
    this.stopped = true
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }
  async read(): Promise<MarketSnapshot | null> {
    if (this.pending) return this.pending
    if (!this.checked) return this.update()
    return this.current
  }
  async manual(): Promise<MarketSnapshot> {
    if (Date.now() < this.refreshAvailableAt) throw new Error('手动刷新冷却 60 秒')
    this.database.setSetting(MANUAL, String(Date.now()))
    const value = await this.update(true, true)
    if (!value) throw new Error('统一市场快照暂不可用')
    return value
  }
  async ensure(codes: string[] = [], sectors: string[] = [], refresh = false): Promise<MarketSnapshot | null> {
    if (this.quoteDate !== beijingMarketDate()) {
      this.quoteDate = beijingMarketDate()
      this.extraCodes.clear()
      this.sectors.clear()
    }
    for (const code of codes) if (/^\d{6}$/.test(code)) this.extraCodes.add(code)
    for (const sector of sectors) this.sectors.add(sector)
    let value = await this.update(refresh)
    if (isMarketLunchBreak()) return value
    if (codes.some(code => !value?.quoteCodes.includes(code)) || sectors.some(code => !value?.snapshot?.records['sector:' + code])) value = await this.update(true)
    return value
  }
  async update(force = false, invalidate = false): Promise<MarketSnapshot | null> {
    if (this.stopped) return this.current
    if (this.pending) return this.pending
    this.checked = true
    const resting = isMarketResting()
    if (isMarketLunchBreak()) return this.current
    const records = this.current?.snapshot?.records ?? {}
    const needs = (key: string) => force || !records[key] || !isClosingPanelCurrent(records[key]!.meta)
      || (key === 'overview' && !closingOverviewComplete((records[key]!.data as import('../../contracts/src/index.ts').MarketOverview)))
    const required = MARKET_SNAPSHOT_PANELS.filter(key => key !== 'global.indices')
    if (!force && resting && this.current && required.every(key => !needs(key))) return this.current
    if (!force && Date.now() - this.attemptedAt < (resting ? 60_000 : 25_000)) return this.current
    this.attemptedAt = Date.now()
    const promise = this.acquire(invalidate, resting, key => !resting || needs(key))
    this.pending = promise
    try { return await promise } finally { if (this.pending === promise) this.pending = null }
  }

  private async acquire(force: boolean, resting: boolean, needed: (key: string) => boolean): Promise<MarketSnapshot> {
    const startedAt = new Date().toISOString()
    const today = beijingMarketDate()
    if (this.quoteDate !== today) { this.quoteDate = today; this.extraCodes.clear(); this.sectors.clear() }
    if (force) this.market.clearMarketPanelsCache?.()
    const codes = [...new Set([...this.candidates(), ...this.extraCodes])].sort()
    const panels: Record<string, Panel> = {}
    const errors: Record<string, string> = {}
    const previous = this.current
    const records: Record<string, MarketPanelSnapshot> = { ...previous?.snapshot?.records }
    const fail = (key: string, cause: unknown) => {
      errors[key] = message(cause)
      const old = records[key]
      if (!old) return
      const meta: ProviderMeta = { ...old.meta, cacheState: 'stale' }
      const data = old.data as { meta: ProviderMeta; indices?: Array<{ meta: ProviderMeta }> }
      records[key] = { ...old, meta, data: { ...data, meta,
        ...(key === 'global.indices' ? { indices: data.indices?.map(index => ({ ...index, meta: { ...index.meta, cacheState: index.meta.cacheState === 'unavailable' ? 'unavailable' : 'stale' } })) } : {}) } }
    }
    const collect = async (key: string, read: () => Promise<unknown>) => {
      if (!needed(key)) return
      const armsError = () => key === 'arms' ? this.market.getSourceDiagnostics().find(source => source.source === '88ai-arms')?.lastError : null
      try {
        const data = structuredClone(await read()) as { meta: ProviderMeta; date?: string; qdate?: string; point?: { date: string } } | null
        if (!data || !isMarketProviderMeta(data.meta) || !isMarketPanelPayload(key, data) || data.meta.cacheState === 'unavailable') throw new Error(armsError() ?? '来源未返回可用数据')
        const fetchedAt = Date.parse(data.meta.fetchedAt)
        const sourceTime = data.meta.sourceTimestamp && !isMarketDate(data.meta.sourceTimestamp) ? Date.parse(data.meta.sourceTimestamp) : fetchedAt
        const minuteEnd = key === 'intraday' && isTencentMinuteEnd(data.meta.providerId, sourceTime, fetchedAt)
        if (fetchedAt > Date.now() || (sourceTime > fetchedAt && !minuteEnd)) throw new Error('来源时间无效或晚于当前时间')
        const date = key === 'breadth' ? data.qdate : key === 'arms' ? data.point?.date : data.date
        if (date && date > today) throw new Error('来源交易日期晚于当前日期')
        panels[key] = { data, meta: data.meta, ...(date ? { date } : {}) }
        if (data.meta.cacheState === 'stale') {
          const reason = armsError()
          errors[key] = reason ? `${reason}，沿用缓存` : '来源获取失败，沿用旧快照'
        }
      } catch (cause) { fail(key, cause) }
    }
    const dashboardKeys = ['overview', 'industry', 'concept', 'rank.gainers', 'rank.losers', 'rank.amount', 'rank.turnover'] as DashboardPanelKey[]
    let quotes: MarketSnapshot['quotes'] = null
    const tasks: Promise<unknown>[] = [
      (async () => {
        const selected = dashboardKeys.filter(needed)
        if (!selected.length) return
        try {
          const data = await this.market.getDashboard(false, selected)
          for (const key of selected) {
            const panel = key === 'overview' || key === 'industry' || key === 'concept' ? data[key]
              : { entries: data.ranks[key.slice(5) as keyof typeof data.ranks], meta: data.rankSources?.[key.slice(5) as keyof typeof data.ranks] ?? data.overview.meta }
            await collect(key, async () => panel)
          }
        } catch (cause) { for (const key of selected) fail(key, cause) }
      })(),
      collect('breadth', () => this.market.getMarketBreadth()),
      collect('ladder', () => this.market.getMarketLadder?.(undefined, date => marketHistoryPanel(this.history.get(date), 'ladder'), force) ?? Promise.resolve(null)),
      collect('distribution', () => this.market.getMarketDistribution?.() ?? Promise.resolve(null)),
      collect('arms', () => this.market.getMarketArms?.() ?? Promise.resolve(null)),
      collect('intraday', () => this.market.getMarketIntraday?.() ?? Promise.resolve(null)),
      collect('signals', () => this.market.getMarketSignals?.() ?? Promise.resolve(null)),
      (async () => {
        if (resting) {
          if (!records['global.indices']) await collect('global.indices', () => this.market.getGlobalIndices?.(true) ?? Promise.resolve(null))
        } else await collect('global.indices', () => this.market.getGlobalIndices?.(false) ?? Promise.resolve(null))
      })(),
      (async () => {
        if (resting || !codes.length) return
        try {
          const result = await this.market.getQuotes(codes.map(code => (code.startsWith('6') ? '1.' : '0.') + code))
          if (!isMarketProviderMeta(result.meta) || !Array.isArray(result.quotes)) throw new Error('批量报价数据无效')
          quotes = result
        } catch (cause) { errors.quotes = message(cause) }
      })(),
    ]
    await Promise.all(tasks)
    const overview = (panels.overview?.data ?? records.overview?.data) as import('../../contracts/src/index.ts').MarketOverview | undefined
    const marketDate = overview?.indices.length && overview.meta.sourceTimestamp ? marketDateFromMeta(overview.meta) : null
    const selectedSectors = new Set(this.sectors)
    if (resting) {
      const boards = ['industry', 'concept'].flatMap(key => ((panels[key]?.data ?? records[key]?.data) as import('../../contracts/src/index.ts').SectorBoard | undefined)?.sectors ?? [])
      for (const board of boards.filter(row => row.changePct !== null).sort((a, b) => b.changePct! - a.changePct!).slice(0, 3)) selectedSectors.add(board.code)
    }
    await Promise.all([...selectedSectors].map(code => collect('sector:' + code, () => this.market.getSectorStocks(code))))
    if (this.stopped) return previous ?? { id: randomUUID(), startedAt, publishedAt: startedAt, snapshot: null, errors, quotes: null, quoteCodes: [] }
    const publishedAt = new Date().toISOString()
    this.database.sqlite.exec('BEGIN IMMEDIATE')
    let next: MarketSnapshot
    try {
      for (const [key, panel] of Object.entries(panels)) {
        const old = records[key]
        if (old && key !== 'global.indices' && observedAt(panel.meta) < observedAt(old.meta)) { fail(key, '来源快照早于已发布数据，沿用原值'); continue }
        let date = key === 'global.indices' ? beijingMarketDate(Date.parse(panel.meta.fetchedAt)) : panel.date ?? marketDateFromMeta(panel.meta)
        if (panel.meta.sourceTimestamp === null && key !== 'global.indices') {
          date = panel.meta.cacheState === 'fresh' && overview?.meta.cacheState !== 'unavailable' && overview?.meta.cacheState !== 'stale' && marketDate === today && beijingMarketDate(Date.parse(panel.meta.fetchedAt)) === today ? marketDate : null
        }
        if (date && isMarketDate(date) && date <= today) {
          const saved = this.history.save(key, panel.data, panel.meta, date, publishedAt)
          if (saved) panel.data = saved
        }
        let meta = (panel.data as { meta: ProviderMeta }).meta
        if (errors[key]) {
          meta = { ...meta, cacheState: 'stale' }
          panel.data = { ...(panel.data as object), meta }
        }
        records[key] = { key, version: 1, capturedAt: publishedAt, meta, data: panel.data }
      }
      const date = marketDate ?? previous?.snapshot?.date ?? marketDateFromMeta(records.ladder?.meta ?? records.breadth?.meta ?? records.overview?.meta ?? { sourceTimestamp: today, fetchedAt: publishedAt } as ProviderMeta)!
      const snapshot = Object.keys(records).length ? { date, capturedAt: publishedAt, records, panels: Object.keys(records) } : null
      next = { id: randomUUID(), startedAt, publishedAt, snapshot, errors, quotes, quoteCodes: resting ? [] : codes }
      this.database.setSetting(CURRENT, JSON.stringify(next))
      this.database.sqlite.exec('COMMIT')
    } catch (cause) { this.database.sqlite.exec('ROLLBACK'); throw cause }
    for (const listener of this.listeners) await listener(next)
    this.current = next
    return next
  }
}
