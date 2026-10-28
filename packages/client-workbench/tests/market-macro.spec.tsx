// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MacroPage } from '../src/market-macro.tsx'
import type { HanaiClient } from '../src/api.ts'
import { MACRO_ETFS, MACRO_GENERATION_PANELS, type MacroGenerationStatus } from '../../contracts/src/market-macro.ts'
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
 const call = vi.fn(async (endpoint: string): Promise<unknown> => {
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
  expect(header.getAllByText('历史快照')).toHaveLength(1)
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
  expect(header.getAllByText('历史快照')).toHaveLength(1)
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
