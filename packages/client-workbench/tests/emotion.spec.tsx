// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { MarketBreadthData } from '../../contracts/src/index.ts'
import type { MarketHistorySnapshot } from '../../contracts/src/market-history.ts'
import type { MarketLadderData } from '../../contracts/src/market-ladder.ts'
import type { CycleReview } from '../../contracts/src/topic-cycle.ts'
import { closingSentimentPanels, sentimentMetrics } from '../../contracts/src/market-sentiment.ts'
import type { HanaiClient } from '../src/api.ts'
import { EmotionPage } from '../src/emotion.tsx'

const today = '2026-11-19'
const yesterday = '2026-11-18'
const confirmed: CycleReview = {
  date: yesterday, status: 'confirmed', error: null, evidence: [], updatedAt: yesterday + 'T16:30:00+08:00',
  result: {
    date: yesterday, marketLeader: { code: '002242', name: '九阳股份' },
    breakoutLeader: { code: '002724', name: '海洋王' },
    cycles: [{
      id: 'finished', name: '已退潮题材', stage: '退潮', leader: null,
      branches: [], events: [], takeaway: '等待新节点', uncertainty: [],
    }, {
      id: 'sample', name: '样本周期', stage: '主升', leader: { code: '002696', name: '百洋股份' },
      branches: [], events: [], takeaway: '观察补涨', uncertainty: [],
    }],
  },
}
const meta = (date: string, time: string) => ({ providerId: 'fixture', sourceName: '样本', fetchedAt: date + 'T' + time + '+08:00', sourceTimestamp: date, cacheState: 'fresh' as const })
const ladder = (date: string, time: string): MarketLadderData => ({
  date, meta: meta(date, time), issues: [], broken: 1, promotion: { eligible: 4, promoted: 1 },
  brokenStocks: [{ code: '000001', name: '断板样本' }],
  stocks: [{ code: '600001', name: '高标样本', boards: 3, reason: '算力', industry: '科技', boardType: '换手板', firstSeal: '10:01:00', lastSeal: '10:05:00', breaks: 1, turnover: null }],
  missedPromotions: { confirmed: time >= '15:05:00', stocks: [{ code: '000001', name: '断板样本', boards: 2, industry: '科技', changePct: -1, broken: true }] },
  yesterdayPerformance: { sample: 4, average: 1.5, median: 1, up: 3, down: 1, flat: 0, meta: meta(date, time) },
})
const breadth = (date: string, time: string): MarketBreadthData => ({
  qdate: date, up: 100, down: 20, flat: 5, limitUp: 30, limitDown: 0, meta: meta(date, time),
})
const snapshot = (date: string, time: string): MarketHistorySnapshot => {
  const width = breadth(date, time)
  const board = ladder(date, time)
  return { date, capturedAt: width.meta.fetchedAt, panels: ['ladder', 'breadth'],
    records: {
      ladder: { key: 'ladder', version: 1, capturedAt: board.meta.fetchedAt, meta: board.meta, data: board },
      breadth: { key: 'breadth', version: 1, capturedAt: width.meta.fetchedAt, meta: width.meta, data: width },
    } }
}
const historyDays = ['2026-11-18', '2026-11-17', '2026-11-16', '2026-11-13', '2026-11-12', '2026-11-11', '2026-11-10']
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date(today + 'T10:00:00+08:00')) })
afterEach(() => { cleanup(); vi.useRealTimers() })

async function setup(live = snapshot(today, '09:50:00'), quotes: Array<{ code: string; changePct: number; meta: ReturnType<typeof meta> }> = []) {
  const call = vi.fn(async (endpoint: string, request: { date?: string }) => {
    if (endpoint === 'market.history.list') return { snapshots: historyDays.map(date => snapshot(date, '15:10:00')) }
    if (endpoint === 'market.history.get') return snapshot(request.date!, '15:10:00')
    if (endpoint === 'market.snapshot') return { data: { id: 'fixture', snapshot: live, errors: {}, quotes: { quotes, meta: meta(today, '09:50:00') } }, refreshAvailableAt: 0 }
    if (endpoint === 'topic-cycle.view') return { selected: null, latestConfirmed: request.date ? null : confirmed, dates: [], latestClosingDate: null, canGenerate: false }
    throw new Error('Unexpected ' + endpoint)
  })
  const onStock = vi.fn()
  render(<EmotionPage client={{ call } as unknown as HanaiClient} onStock={onStock} />)
  await act(async () => {})
  return { call, onStock }
}

it('opens the market leader from the overview and makes the compact market evidence available in history', async () => {
  const { call, onStock } = await setup()
  expect(screen.getByRole('heading', { name: /样本周期.*主升/ })).toBeVisible()
  expect(screen.queryByRole('complementary', { name: '行情依据' })).toBeNull()
  fireEvent.click(within(screen.getByRole('region', { name: '市场情绪总龙' })).getByRole('button', { name: /九阳股份/ }))
  expect(onStock).toHaveBeenCalledWith(expect.objectContaining({ secId: '0.002242' }))
  fireEvent.click(screen.getByRole('button', { name: '周期回看' }))
  expect(screen.queryByRole('region', { name: '跟踪题材' })).toBeNull()
  const evidence = within(screen.getByRole('complementary', { name: '行情依据' }))
  expect(screen.getByText(today + ' · 盘中快照')).toBeVisible()
  expect(evidence.getByText('接力反馈偏强')).toBeVisible()
  expect(evidence.getByText('30 / 0')).toBeVisible()
  expect(evidence.queryByRole('button', { name: '高标样本' })).toBeNull()
  expect(call.mock.calls.some(([name]) => name.startsWith('emotion.'))).toBe(false)
})

it('keeps only chronologically valid same-day quotes for topic roles', async () => {
  const collected = { ...meta(today, '09:50:00'), sourceTimestamp: today + 'T09:49:00+08:00' }
  await setup(undefined, [
    { code: '002242', changePct: 1.25, meta: collected },
    { code: '002724', changePct: -3, meta: { ...collected, sourceTimestamp: today + 'T09:51:00+08:00' } },
    { code: '002696', changePct: -5, meta: { ...collected, sourceTimestamp: yesterday + 'T15:00:00+08:00' } },
  ])
  fireEvent.click(screen.getByText('跟踪个股行情'))
  const observed = within(screen.getByRole('region', { name: '盘中观察' }))
  expect(observed.getByText('盘中涨跌幅 +1.25%')).toBeVisible()
  expect(observed.queryByRole('button', { name: /海洋王|百洋股份/ })).toBeNull()
})

it('keeps more than five archived days and turns off live polling during historical browsing', async () => {
  const { call } = await setup()
  expect(screen.queryByRole('region', { name: '周期收盘数据' })).toBeNull()
  expect(screen.queryByRole('region', { name: '题材强弱' })).toBeNull()
  const dates = screen.getByRole('combobox', { name: '复盘日期' })
  expect(screen.getAllByRole('combobox')).toHaveLength(1)
  expect(within(dates).getAllByRole('option')).toHaveLength(historyDays.length + 1)
  fireEvent.click(screen.getByRole('button', { name: '周期回看' }))
  fireEvent.change(dates, { target: { value: '2026-11-10' } })
  await act(async () => {})
  expect(screen.getByText('2026-11-10 · 历史收盘')).toBeVisible()
  const count = call.mock.calls.filter(([name]) => name === 'market.snapshot').length
  await act(async () => { vi.advanceTimersByTime(15_000) })
  expect(call.mock.calls.filter(([name]) => name === 'market.snapshot')).toHaveLength(count)
  expect(call).toHaveBeenCalledWith('market.history.get', { date: '2026-11-10' }, expect.any(AbortSignal))
  expect(call).toHaveBeenCalledWith('topic-cycle.view', { date: '2026-11-10' }, expect.any(AbortSignal))
})

it('rejects intraday and wrong-date records as closing evidence while retaining a verified zero', async () => {
  vi.setSystemTime(new Date(today + 'T16:10:00+08:00'))
  await setup(snapshot(today, '14:50:00'))
  fireEvent.click(screen.getByRole('button', { name: '周期回看' }))
  expect(screen.getByText(today + ' · 收盘数据')).toBeVisible()
  expect(screen.getByText('该日暂无可核实的收盘行情。')).toBeVisible()
  expect(screen.queryByRole('button', { name: '高标样本' })).toBeNull()
  const delayed = { ...ladder(today, '15:12:00'), yesterdayPerformance: ladder(yesterday, '15:10:00').yesterdayPerformance! }
  const close = closingSentimentPanels(today, delayed, breadth(today, '15:10:00'))
  expect(sentimentMetrics(close.ladder, close.breadth)).toMatchObject({
    limitDown: 0, highest: 3, brokenRate: 50, yesterdayAverage: null, promotionRate: 25,
  })
})

it('uses the latest verified close when the overall publication date is older', async () => {
  vi.setSystemTime(new Date(today + 'T16:10:00+08:00'))
  await setup({ ...snapshot(today, '15:10:00'), date: yesterday })
  fireEvent.click(screen.getByRole('button', { name: '周期回看' }))
  expect(screen.getByText(today + ' · 收盘数据')).toBeVisible()
  expect(screen.getByText('接力反馈偏强')).toBeVisible()
  expect(screen.getByText('25.0%')).toBeVisible()
})
