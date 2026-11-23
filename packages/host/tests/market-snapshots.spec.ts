import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { HanaiDatabase } from '../../domain/src/database.ts'
import { resolveHanaiPaths, ensureHanaiLayout } from '../../domain/src/paths.ts'
import { MarketHistoryStore } from '../../domain/src/market-history.ts'
import { marketHistoryPanel } from '../../contracts/src/market-history.ts'
import type { MarketIntradayData } from '../../contracts/src/market-activity.ts'
import type { MarketArmsData } from '../../contracts/src/market-arms.ts'
import type { SourceDiagnostic } from '../../contracts/src/index.ts'
import type { MarketFacade } from '../src/service.ts'
import { MarketSnapshots } from '../src/market-snapshots.ts'

const close: Array<() => void> = []
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-10T10:00:00+08:00')) })
afterEach(() => { for (const dispose of close.splice(0).reverse()) dispose(); vi.useRealTimers() })
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'hanai-market-snapshots-'))
  const paths = resolveHanaiPaths(root)
  ensureHanaiLayout(paths)
  const database = new HanaiDatabase(paths.databasePath)
  const history = new MarketHistoryStore(database.sqlite)
  const meta = () => ({ providerId: 'fixture', sourceName: '公开测试源', sourceTimestamp: new Date().toISOString(), fetchedAt: new Date().toISOString(), cacheState: 'fresh' as const })
  const ladder = () => ({ date: '2026-11-10', stocks: [{ code: '600001', name: '样本股', boards: 2, industry: '测试', reason: '题材', boardType: '换手板', firstSeal: '09:30:00', lastSeal: '09:30:00', breaks: 0, turnover: 1 }],
    promotion: { promoted: 1, eligible: 2 }, broken: 1, issues: [], meta: meta() })
  const market = {
    getDashboard: vi.fn(async () => ({ overview: { indices: [], breadth: { up: 10, down: 5, flat: 0, limitUp: 2, limitDown: 0, totalAmount: null }, marketStatus: 'trading', meta: meta() },
      industry: { type: 'industry', sectors: [], meta: meta() }, concept: { type: 'concept', sectors: [], meta: meta() }, ranks: { gainers: [], losers: [], amount: [], turnover: [] } })),
    getMarketLadder: vi.fn(async () => ladder()),
    getMarketBreadth: vi.fn(async () => ({ qdate: '2026-11-10', up: 10, down: 5, flat: 0, limitUp: 2, limitDown: 0, meta: meta() })),
    getMarketArms: vi.fn(async (): Promise<MarketArmsData | null> => null), getMarketDistribution: vi.fn(async () => null),
    getMarketIntraday: vi.fn(async (): Promise<MarketIntradayData | null> => null), getMarketSignals: vi.fn(async () => null), getGlobalIndices: vi.fn(async () => null),
    getSourceDiagnostics: vi.fn((): SourceDiagnostic[] => []),
    getQuotes: vi.fn(async () => ({ quotes: [], meta: meta() })), getSectorStocks: vi.fn(async () => ({ stocks: [], meta: meta() })),
    clearMarketPanelsCache: vi.fn(() => 0),
  }
  const feed = new MarketSnapshots(market as unknown as MarketFacade, history, database)
  close.push(() => { feed.dispose(); database.close(); rmSync(root, { recursive: true, force: true }) })
  return { feed, market, database, history, ladder }
}
it('coalesces all readers into one complete round and persists its identity', async () => {
  const f = fixture()
  const values = await Promise.all([f.feed.ensure(['600001', '000001', '600001']), f.feed.read(), f.feed.read()])
  expect(new Set(values.map(value => value?.id)).size).toBe(1)
  for (const name of ['getDashboard', 'getMarketLadder', 'getMarketBreadth', 'getMarketArms', 'getMarketDistribution', 'getMarketIntraday', 'getMarketSignals', 'getGlobalIndices', 'getQuotes'] as const) expect(f.market[name]).toHaveBeenCalledTimes(1)
  expect(f.market.getQuotes).toHaveBeenCalledWith(['0.000001', '1.600001'])
  expect(f.feed.peek()?.snapshot?.records.ladder?.data).toEqual(marketHistoryPanel(f.history.get('2026-11-10'), 'ladder'))
  expect(JSON.parse(f.database.getSetting('market.snapshot.current')!).id).toBe(values[0]?.id)
})
it('acquires requested sector members after close and archives their source date', async () => {
  vi.setSystemTime(new Date('2026-11-10T18:00:00+08:00'))
  const f = fixture()
  const first = await f.feed.read()
  expect(first?.snapshot?.records['sector:BK0475']).toBeUndefined()
  const next = await f.feed.ensure([], ['BK0475'])
  expect(f.market.getSectorStocks).toHaveBeenCalledWith('BK0475')
  const panel = marketHistoryPanel(next!.snapshot, 'sector:BK0475')
  expect(panel).not.toBeNull()
  expect(marketHistoryPanel(f.history.get('2026-11-10'), 'sector:BK0475')).toEqual(panel)
  expect(f.market.getQuotes).not.toHaveBeenCalled()
  expect(f.market.getGlobalIndices).toHaveBeenLastCalledWith(true)
})
it('tracks confirmed topic roles in the same intraday quote batch without polling them after close', async () => {
  const f = fixture()
  f.feed.setTopicCodes(() => ['002242', '002724', '002242'])
  const current = await f.feed.ensure(['002242'])
  expect(current?.quoteCodes).toEqual(['002242', '002724'])
  expect(f.market.getQuotes).toHaveBeenCalledExactlyOnceWith(['0.002242', '0.002724'])
  vi.setSystemTime(new Date('2026-11-10T18:00:00+08:00'))
  const closed = await f.feed.update()
  expect(closed?.quoteCodes).toEqual([])
  expect(f.market.getQuotes).toHaveBeenCalledTimes(1)
})
it('keeps the prior publication immutable until every source and consumer finishes', async () => {
  const f = fixture()
  const first = await f.feed.read()
  let release!: (value: ReturnType<typeof f.ladder>) => void
  f.market.getMarketLadder.mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
  vi.advanceTimersByTime(30_000)
  const pending = f.feed.update()
  expect(f.feed.peek()).toBe(first)
  await Promise.resolve()
  expect(f.feed.peek()).toBe(first)
  release(f.ladder())
  const next = await pending
  expect(next?.id).not.toBe(first?.id)
  expect(first?.snapshot?.records.ladder?.meta.fetchedAt).not.toBe(next?.snapshot?.records.ladder?.meta.fetchedAt)
})
it('keeps manual cooldown separate from automatic updates, and stops acquisition at lunch', async () => {
  const f = fixture()
  await f.feed.manual()
  await expect(f.feed.manual()).rejects.toThrow('冷却')
  vi.advanceTimersByTime(30_000)
  await f.feed.update()
  expect(f.market.getDashboard).toHaveBeenCalledTimes(2)
  expect(f.market.clearMarketPanelsCache).toHaveBeenCalledTimes(1)
  vi.setSystemTime(new Date('2026-11-10T12:00:00+08:00'))
  await f.feed.update()
  expect(f.market.getDashboard).toHaveBeenCalledTimes(2)
  vi.setSystemTime(new Date('2026-11-10T13:00:00+08:00'))
  await f.feed.update()
  expect(f.market.getDashboard).toHaveBeenCalledTimes(3)
})
it('retains source times and archives on failure, without discarding unrelated successful panels', async () => {
  const f = fixture()
  const first = await f.feed.read()
  const saved = marketHistoryPanel(f.history.get('2026-11-10'), 'ladder')
  f.market.getMarketLadder.mockRejectedValueOnce(new Error('接口失败'))
  vi.advanceTimersByTime(30_000)
  const next = await f.feed.update()
  expect(next?.errors.ladder).toBe('接口失败')
  expect(next?.snapshot?.records.ladder?.meta).toEqual({ ...first?.snapshot?.records.ladder?.meta, cacheState: 'stale' })
  expect(marketHistoryPanel(f.history.get('2026-11-10'), 'ladder')).toEqual(saved)
  expect(next?.snapshot?.records.breadth?.meta.fetchedAt).not.toBe(first?.snapshot?.records.breadth?.meta.fetchedAt)
})
it('restores the published cache and never fetches overseas prices outside domestic hours', async () => {
  const f = fixture()
  const first = await f.feed.read()
  const restored = new MarketSnapshots(f.market as unknown as MarketFacade, f.history, f.database)
  close.push(() => restored.dispose())
  expect(restored.peek()?.id).toBe(first?.id)
  vi.setSystemTime(new Date('2026-11-10T18:00:00+08:00'))
  await restored.update()
  expect(f.market.getGlobalIndices).toHaveBeenLastCalledWith(true)
})
it('does not publish an in-flight round after disposal', async () => {
  const f = fixture()
  const first = await f.feed.read()
  let release!: (value: ReturnType<typeof f.ladder>) => void
  f.market.getMarketLadder.mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
  vi.advanceTimersByTime(30_000)
  const pending = f.feed.update()
  f.feed.dispose()
  release(f.ladder())
  await pending
  expect(f.feed.peek()?.id).toBe(first?.id)
  expect(JSON.parse(f.database.getSetting('market.snapshot.current')!).id).toBe(first?.id)
})

it.each([
  ['tencent', '10:00', true],
  ['tencent', '10:01', false],
  ['eastmoney', '10:00', false],
])('publishes only permitted minute labels for %s at %s', async (providerId, time, accepted) => {
  vi.setSystemTime(new Date('2026-11-10T09:59:51+08:00'))
  const f = fixture()
  const meta = { providerId, sourceName: '测试行情', sourceTimestamp: new Date(`2026-11-10T${time}:00+08:00`).toISOString(), fetchedAt: new Date().toISOString(), cacheState: 'fresh' as const }
  const data = { date: '2026-11-10', points: [{ time, price: 3672, avgPrice: null, volume: 100 }], prevClose: 3650, meta }
  f.market.getMarketIntraday.mockResolvedValue(data)
  const published = await f.feed.read()
  expect(marketHistoryPanel(published!.snapshot, 'intraday')).toEqual(accepted ? data : null)
  expect(marketHistoryPanel(f.history.get(data.date), 'intraday')).toEqual(accepted ? data : null)
  expect(published!.errors.intraday).toBe(accepted ? undefined : '来源时间无效或晚于当前时间')
})

it('publishes the intraday TRIN error while retaining its last successful observation', async () => {
  const f = fixture()
  const timestamp = new Date().toISOString()
  const meta = { providerId: '88ai-arms', sourceName: '88AI', sourceTimestamp: timestamp, fetchedAt: timestamp, cacheState: 'fresh' as const }
  const data = { point: { date: '2026-11-10', time: '10:00', upCount: 100, downCount: 100, flatCount: 1,
    upAmount: 100, downAmount: 100, adRatio: 1, amountRatio: 1, trin: 1, estimated: false }, meta }
  f.market.getMarketArms.mockResolvedValueOnce(data).mockResolvedValueOnce({ ...data, meta: { ...meta, cacheState: 'stale' } })
  await f.feed.read()
  vi.advanceTimersByTime(30_000)
  f.market.getSourceDiagnostics.mockReturnValue([{ source: '88ai-arms', sourceName: '88AI', scope: 'breadth',
    lastAttemptAt: new Date().toISOString(), lastSuccessAt: timestamp, lastError: '88AI 市场广度请求失败：HTTP 503', failures: 1, openUntil: null }])
  const published = await f.feed.update()
  expect(published!.errors.arms).toBe('88AI 市场广度请求失败：HTTP 503，沿用缓存')
  expect(marketHistoryPanel(published!.snapshot, 'arms')).toEqual({ ...data, meta: { ...meta, cacheState: 'stale' } })
  expect(marketHistoryPanel(f.history.get(data.point.date), 'arms')).toEqual(data)
})

it('rejects future and older observations while isolating mutable provider responses', async () => {
  const f = fixture()
  const source = f.ladder()
  f.market.getMarketLadder.mockResolvedValue(source)
  const first = await f.feed.read()
  source.stocks[0]!.reason = '后续修改'
  expect(marketHistoryPanel(first!.snapshot, 'ladder')?.stocks[0]?.reason).toBe('题材')
  vi.advanceTimersByTime(30_000)
  source.meta.fetchedAt = new Date(Date.now() + 60_000).toISOString()
  const future = await f.feed.update()
  expect(future?.errors.ladder).toContain('时间')
  expect(marketHistoryPanel(future!.snapshot, 'ladder')?.stocks[0]?.reason).toBe('题材')
  source.meta.fetchedAt = first!.startedAt
  source.meta.sourceTimestamp = new Date(Date.parse(first!.startedAt) - 60_000).toISOString()
  vi.advanceTimersByTime(30_000)
  const older = await f.feed.update()
  expect(older?.errors.ladder).toContain('早于')
  expect(marketHistoryPanel(f.history.get('2026-11-10'), 'ladder')?.stocks[0]?.reason).toBe('题材')
})
