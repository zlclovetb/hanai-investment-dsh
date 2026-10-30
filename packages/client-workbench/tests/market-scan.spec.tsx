// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { DashboardData, ProviderMeta, RankEntry } from '../../contracts/src/index.ts'
import { DOMESTIC_INDICES } from '../../contracts/src/market-indices.ts'
import type { MarketHistorySnapshot } from '../../contracts/src/market-history.ts'
import type { HanaiClient } from '../src/api.ts'
import { MarketScanPage } from '../src/market-scan.tsx'
import { EMPTY_SCAN_FILTERS, filterScanRows, mergeScanDashboard, scanArchiveCurrent } from '../src/market-scan-data.ts'

const meta: ProviderMeta = { providerId: 'test', sourceName: '测试公开行情', sourceTimestamp: '2026-10-30T15:00:00+08:00', fetchedAt: '2026-10-30T15:10:00+08:00', cacheState: 'fresh' }
const row: RankEntry = { secId: '1.600000', code: '600000', name: '浦发银行', price: 10, changePct: 2, amount: 2e8, turnoverRate: 1 }
const down: RankEntry = { ...row, secId: '0.000001', code: '000001', name: '平安银行', changePct: -2 }
const dashboard: DashboardData = { overview: { indices: DOMESTIC_INDICES.map(item => ({ code: item.code, name: item.name, price: 3000, change: 1, changePct: 1, amount: 1e9, upCount: null, downCount: null, flatCount: null })), breadth: { up: 1, down: 1, flat: 0, limitUp: 0, limitDown: 0, totalAmount: 2e9 }, marketStatus: 'closed', meta }, industry: { type: 'industry', sectors: [{ code: 'BK0475', name: '银行板块', changePct: 2, amount: 2e9, upCount: 1, downCount: 0, leaderName: row.name, leaderCode: row.code, leaderChangePct: 2 }], meta }, concept: { type: 'concept', sectors: [], meta }, ranks: { gainers: [row], losers: [down], amount: [row], turnover: [row] }, rankSources: { gainers: meta, losers: meta, amount: meta, turnover: meta } }
function snapshot(date = '2026-10-30'): MarketHistorySnapshot {
  const records: MarketHistorySnapshot['records'] = {}
  const add = (key: string, data: unknown) => { records[key] = { key, version: 1, capturedAt: meta.fetchedAt, meta, data } }
  add('overview', dashboard.overview); add('industry', dashboard.industry); add('concept', dashboard.concept)
  for (const key of ['gainers', 'losers', 'amount', 'turnover'] as const) add(`rank.${key}`, { entries: dashboard.ranks[key], meta })
  return { date, capturedAt: meta.fetchedAt, panels: Object.keys(records), records }
}
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-30T10:00:00+08:00')) })
afterEach(() => { cleanup(); vi.useRealTimers() })
function setup(saved: MarketHistorySnapshot | null = null, overrides: Record<string, (...args: any[]) => unknown> = {}) {
  const call = vi.fn(async (endpoint: string, payload: any, signal?: AbortSignal) => {
    if (overrides[endpoint]) return overrides[endpoint]!(payload, signal)
    if (endpoint === 'market.history.list') return { snapshots: saved ? [saved] : [] }
    if (endpoint === 'market.history.get') return saved
    if (endpoint === 'dashboard.get') return dashboard
    if (endpoint === 'sector.stocks') return { stocks: [down], meta }
    throw new Error(endpoint)
  })
  const onStock = vi.fn()
  render(<MarketScanPage client={{ call } as unknown as HanaiClient} onStock={onStock} />)
  return { call, onStock }
}
it('filters only the given sample and does not treat missing metrics as zero', () => {
  const rows = [row, { ...row, name: '*ST示例', secId: '1.600001' }, { ...row, price: null, changePct: null, amount: null, turnoverRate: null, secId: '1.600002' }]
  expect(filterScanRows(rows, { ...EMPTY_SCAN_FILTERS, minAmount: '2', excludeST: true }).rows).toEqual([row])
  expect(filterScanRows(rows, { ...EMPTY_SCAN_FILTERS, minPrice: '0' }).rows).toHaveLength(2)
  expect(filterScanRows([down], { ...EMPTY_SCAN_FILTERS, minChange: '-3' }).rows).toEqual([down])
  expect(filterScanRows(rows, { ...EMPTY_SCAN_FILTERS, minPrice: '20', maxPrice: '10' }).error).toContain('最低价')
  expect(filterScanRows(rows, { ...EMPTY_SCAN_FILTERS, minAmount: 'Infinity' }).error).toContain('数字')
})
it('preserves failed surfaces independently with original timestamps and a stale state', () => {
  const unavailable = { ...meta, cacheState: 'unavailable' as const }
  const next = { ...dashboard, ranks: { ...dashboard.ranks, gainers: [], losers: [row] }, rankSources: { ...dashboard.rankSources!, gainers: unavailable } }
  const merged = mergeScanDashboard(dashboard, next)
  expect(merged.ranks.gainers).toEqual([row]); expect(merged.ranks.losers).toEqual([row])
  expect(merged.rankSources?.gainers).toEqual({ ...meta, cacheState: 'stale' })
})
it('switches ranks, filters without network scans, and opens the selected stock', async () => {
  const view = setup(); await act(async () => {})
  fireEvent.click(screen.getByRole('button', { name: '跌幅榜' }))
  fireEvent.click(screen.getByRole('button', { name: /平安银行/ })); expect(view.onStock).toHaveBeenCalledWith(down)
  fireEvent.change(screen.getByLabelText('成交额至少（亿）'), { target: { value: '3' } })
  expect(screen.getByText('当前样本没有符合条件的股票')).not.toBeNull()
  expect(view.call.mock.calls.filter(([key]) => key === 'dashboard.get')).toHaveLength(1)
})
it('keeps automatic open-market polling independent of the manual cooldown', async () => {
  const view = setup(); await act(async () => {})
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '刷新样本' })) })
  expect(view.call.mock.calls.filter(([key]) => key === 'dashboard.get')).toHaveLength(2)
  await act(async () => { await vi.advanceTimersByTimeAsync(30_000) })
  expect(view.call.mock.calls.filter(([key]) => key === 'dashboard.get')).toHaveLength(3)
  expect((screen.getByRole('button', { name: '30秒后刷新' }) as HTMLButtonElement).disabled).toBe(true)
})
it('uses complete closing archives without fetching live data or unsaved constituents', async () => {
  vi.setSystemTime(new Date('2026-10-30T18:00:00+08:00'))
  const saved = snapshot(); expect(scanArchiveCurrent(saved)).toBe(true)
  const view = setup(saved); await act(async () => {})
  fireEvent.click(screen.getByRole('button', { name: /银行板块/ })); await act(async () => {})
  expect(screen.getByText('本快照未保存该板块成分，不补入实时数据')).not.toBeNull()
  await act(async () => { await vi.advanceTimersByTimeAsync(90_000) })
  expect(view.call.mock.calls.some(([key]) => key === 'dashboard.get' || key === 'sector.stocks')).toBe(false)
})
it('does not freeze a closing archive missing an expected index or rank', () => {
  vi.setSystemTime(new Date('2026-10-30T18:00:00+08:00'))
  const saved = snapshot(); delete saved.records['rank.amount']; expect(scanArchiveCurrent(saved)).toBe(false)
  const incomplete = snapshot(); incomplete.records.overview!.data = { ...dashboard.overview, indices: [] }; expect(scanArchiveCurrent(incomplete)).toBe(false)
})
it('keeps explicit history read-only and aborts pending live work on date changes', async () => {
  let liveSignal: AbortSignal | undefined
  const view = setup(snapshot(), { 'dashboard.get': (_payload, signal) => { liveSignal = signal; return new Promise(() => {}) } })
  await act(async () => {})
  await act(async () => { fireEvent.change(screen.getByLabelText('已保存历史日期'), { target: { value: '2026-10-30' } }) })
  expect(liveSignal?.aborted).toBe(true)
  expect((screen.getByRole('button', { name: /浦发银行600000/ }) as HTMLButtonElement).disabled).toBe(true)
  await act(async () => { await vi.advanceTimersByTimeAsync(90_000) })
  expect(view.call.mock.calls.filter(([key]) => key === 'dashboard.get')).toHaveLength(1)
  expect(view.call.mock.calls.some(([key]) => key === 'sector.stocks')).toBe(false)
})
it('reports refresh failure while leaving the displayed rows in place', async () => {
  let calls = 0
  setup(null, { 'dashboard.get': () => { if (calls++ > 0) throw new Error('source offline'); return dashboard } })
  await act(async () => {})
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '刷新样本' })) })
  expect(screen.getByRole('alert').textContent).toContain('source offline')
  expect(screen.getByRole('button', { name: /浦发银行600000/ })).not.toBeNull()
})
it('retains board constituents when a later board request fails', async () => {
  let attempts = 0
  setup(null, { 'sector.stocks': () => { if (attempts++ > 0) throw new Error('board offline'); return { stocks: [down], meta } } })
  await act(async () => {})
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: /银行板块/ })) })
  expect(screen.getByRole('button', { name: /平安银行000001/ })).not.toBeNull()
  await act(async () => { await vi.advanceTimersByTimeAsync(30_000) })
  expect(screen.getByRole('alert').textContent).toContain('board offline')
  expect(screen.getByRole('button', { name: /平安银行000001/ })).not.toBeNull()
})
it('rejects late board responses after selecting a historical date', async () => {
  let resolveBoard: (value: unknown) => void = () => {}
  let boardSignal: AbortSignal | undefined
  const view = setup(snapshot(), { 'sector.stocks': (_payload, signal) => { boardSignal = signal; return new Promise(resolve => { resolveBoard = resolve }) } })
  await act(async () => {})
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: /银行板块/ })) })
  await act(async () => { fireEvent.change(screen.getByLabelText('已保存历史日期'), { target: { value: '2026-10-30' } }) })
  expect(boardSignal?.aborted).toBe(true)
  await act(async () => { resolveBoard({ stocks: [down], meta }) })
  expect(screen.queryByRole('button', { name: /平安银行000001/ })).toBeNull()
  expect(view.call.mock.calls.filter(([key]) => key === 'sector.stocks')).toHaveLength(1)
})
