// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MacroPage } from '../src/market-macro.tsx'
import type { HanaiClient } from '../src/api.ts'
import { MACRO_ETFS, MACRO_GENERATION_PANELS, type MacroGenerationStatus } from '../../contracts/src/market-macro.ts'
import { isMarketPanelPayload } from '../../contracts/src/market-history.ts'
vi.mock('../src/echarts.tsx', () => ({ EChart: ({ ariaLabel }: { ariaLabel: string }) => <div role="img" aria-label={ariaLabel} /> }))
const meta = { providerId: 'test', sourceName: '公开数据', sourceTimestamp: '2026-09-30', fetchedAt: '2026-10-27T02:00:00Z', cacheState: 'fresh' }
const etfs = { funds: MACRO_ETFS.map(fund => ({ code: fund.code, points: [{ date: '2026-09-30', assets: 100 }] })), meta }
const daily = { points: [{ date: '2026-09-30', assets: 400 }], expectedDays: 1, complete: true, meta }
const status = (state: MacroGenerationStatus['state']): MacroGenerationStatus => ({ state, startedAt: meta.fetchedAt, finishedAt: state === 'running' ? null : meta.fetchedAt, availableAt: 0,
 panels: state === 'idle' ? [] : MACRO_GENERATION_PANELS.map(panel => ({ ...panel, state: state === 'running' ? 'running' : 'completed', checked: 1, total: 1, missing: 0, error: null })) })
beforeEach(() => { vi.useFakeTimers({ shouldAdvanceTime: true }); vi.setSystemTime(new Date('2026-10-27T10:00:00+08:00')) })
afterEach(() => { cleanup(); vi.useRealTimers() })
function clientFor() {
 let job = status('idle')
 let savedDaily = false
 const call = vi.fn(async (endpoint: string, _request?: unknown): Promise<unknown> => {
  if (endpoint === 'market.macro.generation') return job
  if (endpoint === 'market.macro.generate') return job = status('running')
  const records = Object.fromEntries([['macro.etf', etfs], ...(savedDaily ? [['macro.etf.daily', daily]] : [])].map(([key, data]) => [key as string, { key, version: 1, data, meta, capturedAt: meta.fetchedAt }]))
  const snapshot = { date: '2026-09-30', panels: Object.keys(records), capturedAt: meta.fetchedAt, records }
  if (endpoint === 'market.history.list') return { snapshots: [snapshot] }
  if (endpoint === 'market.history.get') return snapshot
  throw new Error(endpoint)
 })
 return { call, client: { call } as unknown as HanaiClient, setJob: (value: MacroGenerationStatus) => { job = value }, finish: () => { savedDaily = true; job = status('completed') } }
}
const starts = (call: ReturnType<typeof clientFor>['call']) => call.mock.calls.filter(([name]) => name === 'market.macro.generate')
const providers = (call: ReturnType<typeof clientFor>['call']) => call.mock.calls.filter(([name]) => name.startsWith('market.macro.') && !['market.macro.generate', 'market.macro.generation'].includes(name))
describe('macro background task observation', () => {
 it('reads persisted reference provenance without fetching data or presenting it as SSE observations', async () => {
  const { call, client } = clientFor()
  const base = call.getMockImplementation()!
  const fetchedAt = '2026-10-27T02:00:00Z'
  const reference = { points: [{ date: '2026-10-26', floatCap: 490000, membershipDate: '2026-10-26' }], checkedDates: ['2026-10-26'], missingDates: [], expectedDays: 1, complete: true,
    meta: { ...meta, providerId: 'baostock-eastmoney', sourceName: 'BaoStock历史成分周快照 × 东方财富同日个股流通市值之和（重建参考，亿元）', sourceTimestamp: '2026-10-26', fetchedAt } }
  const capital = { points: [{ date: '2026-09-30', floatCap: 500000 }], checkedMonths: ['202609'], complete: true, reference, meta }
  const savedDaily = { ...daily, points: [{ date: '2026-10-26', assets: 3400 }] }
  const snapshot = { date: '2026-09-30', panels: ['macro.capital', 'macro.etf.daily'], capturedAt: fetchedAt,
   records: { 'macro.capital': { key: 'macro.capital', version: 1, data: capital, meta, capturedAt: fetchedAt }, 'macro.etf.daily': { key: 'macro.etf.daily', version: 1, data: savedDaily, meta, capturedAt: fetchedAt } } }
  call.mockImplementation(endpoint => endpoint === 'market.history.list' ? Promise.resolve({ snapshots: [snapshot] }) : endpoint === 'market.history.get' ? Promise.resolve(snapshot) : base(endpoint))
  render(<MacroPage client={client} theme="light" />)
  await screen.findByText(/分母重建参考：已取得 1 \/ 1 个交易日/)
  expect(screen.getByText(/周快照不保证精确调样日/)).toBeTruthy()
  const header = within(screen.getByRole('heading', { name: '沪深300 ETF规模与流通市值占比' }).closest('header')!)
  expect(header.getByText(/BaoStock历史成分周快照/)).toBeTruthy()
  expect(screen.queryByText(/近期占比缺口/)).toBeNull()
  expect(providers(call)).toHaveLength(0)
 })
 it('replays a generation-day chart using its frozen mixed-date inputs without requesting other dates', async () => {
  const { call, client } = clientFor()
  const base = call.getMockImplementation()!
  const generatedAt = '2026-10-26T10:00:00Z'
  const sourceMeta = { ...meta, fetchedAt: '2026-10-26T02:00:00Z' }
  const chart = { date: '2026-10-26', generatedAt, etfs: null, index: null, allEtfs: null, allDaily: null,
    daily: { ...daily, meta: sourceMeta }, capital: { points: [{ date: '2026-09-30', floatCap: 500000 }], checkedMonths: ['202609'], complete: true, meta: sourceMeta },
    task: { ...status('completed'), startedAt: '2026-10-26T09:00:00Z', finishedAt: generatedAt },
    meta: { ...sourceMeta, providerId: 'macro-generation', sourceName: '整图生成快照', sourceTimestamp: generatedAt, fetchedAt: generatedAt } }
  expect(isMarketPanelPayload('macro.chart', chart)).toBe(true)
  expect(isMarketPanelPayload('macro.chart', { ...chart, daily: { ...chart.daily, meta: { ...sourceMeta, fetchedAt: '2026-10-27T02:00:00Z' } } })).toBe(false)
  const snapshot = { date: chart.date, panels: ['macro.chart'], capturedAt: generatedAt,
    records: { 'macro.chart': { key: 'macro.chart', version: 1, data: chart, meta: chart.meta, capturedAt: generatedAt } } }
  call.mockImplementation(endpoint => endpoint === 'market.history.list' ? Promise.resolve({ snapshots: [snapshot] }) : endpoint === 'market.history.get' ? Promise.resolve(snapshot) : base(endpoint))
  render(<MacroPage client={client} theme="light" />)
  await waitFor(() => expect(screen.getByRole('button', { name: '生成宏观记录' }).hasAttribute('disabled')).toBe(false))
  fireEvent.change(screen.getByLabelText('市场数据日期'), { target: { value: chart.date } })
  await screen.findByText(/已匹配 1 个交易日/)
  expect(screen.getByText(/整图保存于/)).toBeTruthy()
  expect(screen.queryByText(/仅有旧版分项归档/)).toBeNull()
  expect(providers(call)).toHaveLength(0)
  expect(starts(call)).toHaveLength(0)
 })
 it('explains the recent ratio gap when ETF assets extend past the available denominator', async () => {
  const { call, client } = clientFor()
  const base = call.getMockImplementation()!
  const recent = { ...daily, points: [{ date: '2026-10-26', assets: 680 }], meta: { ...meta, sourceTimestamp: '2026-10-26' } }
  const capital = { points: [{ date: '2026-09-30', floatCap: 500000 }], checkedMonths: ['202609'], complete: true, meta }
  const snapshots = [['2026-09-30', 'macro.capital', capital], ['2026-10-26', 'macro.etf.daily', recent]].map(([date, key, value]) => {
   const data = value as typeof capital | typeof recent
   return { date, panels: [key], capturedAt: data.meta.fetchedAt, records: { [key as string]: { key, version: 1, data, meta: data.meta, capturedAt: data.meta.fetchedAt } } }
  })
  call.mockImplementation((endpoint, request) => endpoint === 'market.history.list' ? Promise.resolve({ snapshots }) : endpoint === 'market.history.get' ? Promise.resolve(snapshots.find(snapshot => snapshot.date === (request as { date: string }).date) ?? null) : base(endpoint))
  render(<MacroPage client={client} theme="light" />)
  await screen.findByText(/近期占比缺口：流通市值（含重建参考）仅覆盖至 2026-09-30，ETF规模已至 2026-10-26/)
  expect(starts(call)).toHaveLength(0)
 })
 it('keeps source dates and one shared history badge when restoring independent archived panels', async () => {
  const { call, client } = clientFor()
  const base = call.getMockImplementation()!
  const all = { funds: etfs.funds.map(fund => ({ ...fund, name: fund.code, inceptionDate: '2012-01-01' })), universeAsOf: '2026-10-27', meta }
  const capital = { points: [{ date: '2026-09-30', floatCap: 500000 }], checkedMonths: ['202609'], complete: true, meta }
  const records = Object.fromEntries([['macro.etf.daily', daily], ['macro.etf.all.quarter', all], ['macro.capital', capital]].map(([key, data]) => [key as string, { key, data, meta, version: 1, capturedAt: meta.fetchedAt }]))
  const snapshot = { date: '2026-09-30', panels: Object.keys(records), records, capturedAt: meta.fetchedAt }
  call.mockImplementation(endpoint => endpoint === 'market.history.list' ? Promise.resolve({ snapshots: [snapshot] }) : endpoint === 'market.history.get' ? Promise.resolve(snapshot) : base(endpoint))
  render(<MacroPage client={client} theme="light" />)
  await screen.findByText(/已匹配 1 个交易日/)
  const header = within(screen.getByRole('heading', { name: '沪深300 ETF规模与流通市值占比' }).closest('header')!)
  expect(header.getAllByText('休市快照')).toHaveLength(1)
  expect(header.getAllByText(/公开数据 · .*2026-09-30 · 获取于/)).toHaveLength(3)
  expect(starts(call)).toHaveLength(0)
 })
 it('only reads history and task status on entry, never starts generation automatically', async () => {
  const { call, client } = clientFor()
  render(<MacroPage client={client} theme="light" />)
  await screen.findByText(/四只合计 400/)
  await act(async () => { await vi.advanceTimersByTimeAsync(6 * 3_600_000) })
  expect(starts(call)).toHaveLength(0)
  expect(providers(call)).toHaveLength(0)
  expect(call.mock.calls.filter(([name]) => name === 'market.macro.generation')).toHaveLength(1)
 })
 it('starts one host task, can leave the page and restores completion and saved chart data on return', async () => {
  const { call, client, finish } = clientFor()
  render(<MacroPage client={client} theme="light" />)
  await screen.findByText(/四只合计 400/)
  fireEvent.click(screen.getByRole('button', { name: '生成宏观记录' }))
  await screen.findByText(/后台生成中，可离开页面/)
  expect(starts(call)).toHaveLength(1)
  expect(screen.getByRole('button', { name: '后台生成中…' }).hasAttribute('disabled')).toBe(true)
  cleanup()
  const count = call.mock.calls.length
  await act(async () => { await vi.advanceTimersByTimeAsync(10_000) })
  expect(call).toHaveBeenCalledTimes(count)
  finish()
  render(<MacroPage client={client} theme="dark" />)
  await screen.findByText('后台生成完成，图表记录已保存')
  await screen.findByText(/日频覆盖 1 \/ 1/)
  expect(starts(call)).toHaveLength(1)
  expect(providers(call)).toHaveLength(0)
 })
 it('observes an existing task and reloads saved progress until completion without starting another task', async () => {
  const { call, client, setJob, finish } = clientFor()
  setJob(status('running'))
  render(<MacroPage client={client} theme="light" />)
  await screen.findByText(/后台生成中，可离开页面/)
  finish()
  await act(async () => { await vi.advanceTimersByTimeAsync(2100) })
  await screen.findByText('后台生成完成，图表记录已保存')
  await screen.findByText(/日频覆盖 1 \/ 1/)
  const count = call.mock.calls.length
  await act(async () => { await vi.advanceTimersByTimeAsync(10_000) })
  expect(call).toHaveBeenCalledTimes(count)
  expect(starts(call)).toHaveLength(0)
 })
 it('keeps explicit historical dates read-only while the host task continues', async () => {
  const { call, client, setJob, finish } = clientFor()
  setJob(status('running'))
  render(<MacroPage client={client} theme="light" />)
  await screen.findByText(/后台生成中，可离开页面/)
  fireEvent.change(screen.getByLabelText('市场数据日期'), { target: { value: '2026-09-30' } })
  await screen.findByText('所选日期未保存沪深300点位')
  expect(screen.getByText(/该日期仅有旧版分项归档/)).toBeTruthy()
  const count = call.mock.calls.filter(([name]) => name.startsWith('market.macro.')).length
  finish()
  await act(async () => { await vi.advanceTimersByTimeAsync(10_000) })
  expect(call.mock.calls.filter(([name]) => name.startsWith('market.macro.'))).toHaveLength(count)
  fireEvent.click(screen.getByRole('button', { name: '返回今日' }))
  await screen.findByText('后台生成完成，图表记录已保存')
  expect(starts(call)).toHaveLength(0)
 })
 it('reports partial failure without discarding saved data or automatically restarting', async () => {
  const { call, client, setJob } = clientFor()
  const failed = status('partial')
  failed.panels[0] = { ...failed.panels[0]!, state: 'failed', error: '来源暂不可用' }
  setJob(failed)
  render(<MacroPage client={client} theme="light" />)
  await screen.findByText(/后台任务已结束，部分数据未补齐/)
  await screen.findByText(/四只合计 400/)
  const header = within(screen.getByRole('heading', { name: '沪深300 ETF规模与流通市值占比' }).closest('header')!)
  expect(header.getAllByText('休市快照')).toHaveLength(1)
  await act(async () => { await vi.advanceTimersByTimeAsync(60_000) })
  expect(starts(call)).toHaveLength(0)
 })
 it('shows local read failures without starting or fetching any market data', async () => {
  const { call, client } = clientFor()
  const base = call.getMockImplementation()!
  call.mockImplementation(endpoint => endpoint === 'market.history.list' ? Promise.reject(new Error('read failure')) : base(endpoint))
  render(<MacroPage client={client} theme="light" />)
  await screen.findByText('宏观历史归档读取失败，请重新打开页面重试')
  expect(starts(call)).toHaveLength(0)
  expect(providers(call)).toHaveLength(0)
 })
})
