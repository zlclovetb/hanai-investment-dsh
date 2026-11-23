// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { useState, type ComponentProps } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { StockQuote } from '../../contracts/src/index.ts'
import type { CycleDraft, CycleReview } from '../../contracts/src/topic-cycle.ts'
import type { LeaderDecision } from '../../contracts/src/leader-decision.ts'
import type { MarketLadderData } from '../../contracts/src/market-ladder.ts'
import type { HanaiClient } from '../src/api.ts'
import { TopicCyclePanel } from '../src/topic-cycle.tsx'

afterEach(cleanup)

function TestPanel(props: Omit<ComponentProps<typeof TopicCyclePanel>, 'date' | 'onDate'>) {
  const [date, setDate] = useState('')
  return <TopicCyclePanel {...props} date={date} onDate={setDate} />
}

const date = '2026-11-18'
const previous = '2026-11-17'
const stock = { code: '002242', name: '九阳股份' }
const breakout = { code: '600825', name: '新华传媒' }
const draft: CycleDraft = {
  date, marketLeader: stock,
  cycles: [{
    id: 'sheep', name: '羊字辈样例', stage: '退潮', leader: stock,
    branches: [{
      name: '正宗谐音', leader: { code: '002724', name: '海洋王' },
      followers: [{ code: '002696', name: '百洋股份' }], change: '分支负反馈扩大',
    }],
    events: [
      { date, kind: '补涨负反馈', detail: '跟随股先转弱', stocks: [], evidence: ['ladder'] },
      { date: previous, kind: '分支接力', detail: '分支接力候选', stocks: [], evidence: ['older-ladder'] },
    ],
    takeaway: '先核实补涨负反馈，再跟踪总龙分歧。', uncertainty: ['异动公告未核实'],
  }],
}
const ready: CycleReview = {
  date, status: 'draft', result: draft, error: null, updatedAt: date + 'T16:30:00+08:00',
  evidence: [{
    id: 'ladder', date, label: '收盘梯队', sourceName: '样例快照',
    observedAt: date + 'T15:10:00+08:00', url: 'https://example.com/archive',
  }],
}
const confirmed: CycleReview = {
  ...ready, date: previous, status: 'confirmed',
  result: { date: previous, marketLeader: stock, cycles: [{ ...draft.cycles[0]!, stage: '主升', events: [] }] },
}

it('shows an attributed manual cycle while leaving the model draft available for review', async () => {
  const manualReview: CycleReview = {
    ...ready, origin: 'user', status: 'confirmed',
    result: { ...draft, breakoutLeader: breakout },
  }
  const call = vi.fn(async () => ({
    selected: ready, latestConfirmed: confirmed, manualReview, dates: [date, previous],
    latestClosingDate: date, canGenerate: false,
  }))
  render(<TestPanel client={{ call } as unknown as HanaiClient} onStock={vi.fn()} />)
  expect(await screen.findByRole('heading', { name: /羊字辈样例.*退潮/ })).toBeVisible()
  const role = within(screen.getByRole('region', { name: '市场情绪总龙' }))
  expect(role.getByText(/人工补录/)).toBeVisible()
  fireEvent.click(screen.getByRole('button', { name: '周期回看' }))
  const archive = within(screen.getByRole('region', { name: '已确认的周期' }))
  expect(archive.getByText('跟随股先转弱')).toBeVisible()
  expect(archive.getAllByText('复盘来源').length).toBeGreaterThan(0)
  fireEvent.click(screen.getByRole('button', { name: /模型复盘/ }))
  expect(within(screen.getByRole('region', { name: '模型复盘' })).getByRole('button', { name: '确认复盘' })).toBeVisible()
})

it('keeps the confirmed stage visible until a deliberately edited draft is confirmed', async () => {
  let selected = ready
  const call = vi.fn(async (endpoint: string, request: { draft?: CycleDraft }) => {
    if (endpoint === 'topic-cycle.confirm') {
      selected = { ...selected, status: 'confirmed', result: request.draft! }
      return selected
    }
    return { selected, latestConfirmed: confirmed, dates: [date, previous], latestClosingDate: date, canGenerate: false }
  })
  const onStock = vi.fn()
  render(<TestPanel client={{ call } as unknown as HanaiClient} onStock={onStock} />)
  const anchor = within(await screen.findByRole('region', { name: '市场情绪总龙' }))
  expect(anchor.getByText('· 已人工确认', { exact: false })).toBeVisible()
  fireEvent.click(anchor.getByRole('button', { name: /九阳股份/ }))
  expect(onStock).toHaveBeenCalledWith(expect.objectContaining({ secId: '0.002242' }))
  expect(screen.getByRole('heading', { name: /羊字辈样例.*主升/ })).toBeVisible()
  expect(screen.queryByRole('button', { name: '确认复盘' })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: /模型复盘/ }))
  const preview = within(await screen.findByRole('region', { name: '模型复盘' }))
  const timeline = within(preview.getByRole('article'))
  const events = timeline.getAllByRole('listitem').filter(node => node.querySelector('time'))
  expect(events.map(node => node.querySelector('time')?.textContent)).toEqual([previous, date])
  fireEvent.click(timeline.getAllByText('行情证据')[1]!)
  expect(timeline.getByRole('link', { name: '收盘梯队' })).toHaveAttribute('href', 'https://example.com/archive')
  fireEvent.click(preview.getByRole('button', { name: '修订草稿' }))
  const editor = preview.getByLabelText('修订草稿 JSON')
  fireEvent.change(editor, { target: { value: '{' } })
  fireEvent.click(preview.getByRole('button', { name: '确认复盘' }))
  expect(await screen.findByRole('alert')).toBeVisible()
  expect(call.mock.calls.some(([endpoint]) => endpoint === 'topic-cycle.confirm')).toBe(false)

  const edited = { ...draft, cycles: [{ ...draft.cycles[0]!, takeaway: '先确认后排退潮。' }] }
  fireEvent.change(editor, { target: { value: JSON.stringify(edited) } })
  fireEvent.click(preview.getByRole('button', { name: '确认复盘' }))
  await waitFor(() => expect(call).toHaveBeenCalledWith('topic-cycle.confirm', { draft: edited }))
  const archive = within(await screen.findByRole('region', { name: '已确认的周期' }))
  fireEvent.click(archive.getByText('完整周期与分支接力'))
  expect(archive.getByText('先确认后排退潮。')).toBeVisible()
})

it('uses the selected historical date for retry without loading the newer confirmed stage into history', async () => {
  const older = '2026-11-16'
  const failed: CycleReview = { ...ready, date: older, status: 'failed', result: null, error: '草稿未生成' }
  const call = vi.fn(async (endpoint: string, request: { date?: string }) => {
    if (endpoint === 'topic-cycle.generate') return { ...failed, status: 'running', error: null }
    return { selected: request.date === older ? failed : confirmed, latestConfirmed: confirmed,
      dates: [previous, older], latestClosingDate: previous, canGenerate: request.date === older }
  })
  render(<TestPanel client={{ call } as unknown as HanaiClient} onStock={vi.fn()} />)
  const dates = await screen.findByRole('combobox', { name: '复盘日期' })
  await screen.findByRole('heading', { name: /羊字辈样例.*主升/ })
  fireEvent.change(dates, { target: { value: older } })
  await screen.findByText('等待题材确认')
  fireEvent.click(screen.getByRole('button', { name: /模型复盘/ }))
  const retry = await screen.findByRole('button', { name: '重试起草' })
  expect(screen.queryByText('主升')).toBeNull()
  expect(screen.queryByText('市场角色')).toBeNull()
  fireEvent.click(retry)
  await waitFor(() => expect(call).toHaveBeenCalledWith('topic-cycle.generate', { date: older }))
})

it('shows both market roles on the overview and labels draft candidates as unconfirmed', async () => {
  const noMarketLeader: CycleReview = { ...confirmed, result: { ...confirmed.result!, marketLeader: null } }
  const withBreakout: CycleReview = { ...ready, result: { ...draft, breakoutLeader: breakout } }
  const call = vi.fn(async (_endpoint: string, request: { date?: string }) => ({
    selected: request.date === previous ? noMarketLeader : withBreakout,
    latestConfirmed: noMarketLeader, dates: [date, previous], latestClosingDate: date, canGenerate: false,
  }))
  render(<TestPanel client={{ call } as unknown as HanaiClient} onStock={vi.fn()} />)
  const anchor = within(await screen.findByRole('region', { name: '市场情绪总龙' }))
  expect(anchor.getByRole('button', { name: /九阳股份/ })).toBeVisible()
  expect(anchor.getByText('· 草稿候选', { exact: false })).toBeVisible()
  const breakoutAnchor = within(screen.getByRole('region', { name: '高度破局龙' }))
  expect(breakoutAnchor.getByRole('button', { name: /新华传媒/ })).toBeVisible()
  expect(breakoutAnchor.getByText('· 草稿候选', { exact: false })).toBeVisible()
  expect(screen.queryByRole('button', { name: '确认复盘' })).toBeNull()

  fireEvent.change(screen.getByRole('combobox', { name: '复盘日期' }), { target: { value: previous } })
  const historicalRole = within(await screen.findByRole('region', { name: '市场情绪总龙' }))
  expect(historicalRole.getByText('待确认')).toBeVisible()
  expect(historicalRole.queryByRole('button')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: '周期回看' }))
  const archive = within(await screen.findByRole('region', { name: '已确认的周期' }))
  fireEvent.click(archive.getByText('完整周期与分支接力'))
  expect(archive.getByRole('button', { name: /九阳股份/ })).toBeVisible()
})

it('highlights the latest verified turn and retains earlier nodes across the cycle', async () => {
  const olderEvidence = { ...ready.evidence[0]!, id: 'older-ladder', date: previous }
  const cycle = draft.cycles[0]!
  const review: CycleReview = {
    ...ready, status: 'confirmed', evidence: [...ready.evidence, olderEvidence],
    result: { ...draft, cycles: [{ ...cycle, events: [
      { ...cycle.events[0]!, kind: '退潮', node: null },
      { ...cycle.events[0]!, kind: '高度破局', node: '突破四板压制，打开接力空间', stocks: [breakout] },
      { ...cycle.events[0]!, kind: '总龙分歧', node: '缺失证据的判断', evidence: ['missing'] },
      { ...cycle.events[1]!, kind: '总龙确立', detail: '总龙确认带动题材' },
      cycle.events[1]!,
    ] }] },
  }
  const call = vi.fn(async () => ({ selected: review, latestConfirmed: review, dates: [date], latestClosingDate: date, canGenerate: false }))
  const onStock = vi.fn()
  render(<TestPanel client={{ call } as unknown as HanaiClient} onStock={onStock} />)
  expect(await screen.findByText(/最近已确认节点/)).toBeVisible()
  fireEvent.click(screen.getByRole('button', { name: '周期回看' }))
  const nodes = within(await screen.findByRole('region', { name: '关键节点' }))
  expect(nodes.getByText('突破四板压制，打开接力空间')).toBeVisible()
  expect(nodes.queryByText('退潮')).toBeNull()
  expect(nodes.queryByText('分支接力候选')).toBeNull()
  expect(nodes.queryByText('缺失证据的判断')).toBeNull()
  fireEvent.click(nodes.getByRole('button', { name: /新华传媒/ }))
  expect(onStock).toHaveBeenCalledWith(expect.objectContaining({ secId: '1.600825' }))
  fireEvent.click(nodes.getByText('查看其余 1 个节点'))
  expect(nodes.getByText('总龙确认带动题材')).toBeVisible()
  expect(nodes.getByText('历史事件归纳')).toBeVisible()
})

it('shows only observed intraday statuses from the same day while retaining the last confirmed stage', async () => {
  const call = vi.fn(async () => ({ selected: null, latestConfirmed: confirmed, dates: [previous], latestClosingDate: previous, canGenerate: false }))
  const ladder: MarketLadderData = {
    date, stocks: [{ ...stock, boards: 4, industry: '家电', reason: null, boardType: '换手板', firstSeal: '09:40:00',
      lastSeal: '10:20:00', breaks: 1, turnover: null }],
    brokenStocks: [{ code: '002724', name: '海洋王' }],
    promotion: null, broken: 1, issues: [],
    meta: { providerId: 'sample', sourceName: '样例快照', sourceTimestamp: date, fetchedAt: date + 'T10:30:00+08:00', cacheState: 'fresh' },
  }
  render(<TestPanel client={{ call } as unknown as HanaiClient} onStock={vi.fn()} intraday={{ date, ladder }} />)
  fireEvent.click(await screen.findByText('跟踪个股行情'))
  const observed = within(await screen.findByRole('region', { name: '盘中观察' }))
  expect(observed.getByText('当前 4 板 · 开板后回封')).toBeVisible()
  expect(observed.getByText('当前炸板未封')).toBeVisible()
  expect(observed.queryByRole('button', { name: /百洋股份/ })).toBeNull()
  expect(screen.getByText('主升', { selector: 'summary span' })).toBeVisible()
})

it('reports an anchor’s quote alone when the stock is outside the ladder', async () => {
  const call = vi.fn(async () => ({ selected: null, latestConfirmed: confirmed, dates: [previous], latestClosingDate: previous, canGenerate: false }))
  const quote: StockQuote = {
    ...stock, secId: '0.002242', price: 10, change: -0.2, changePct: -2, amount: null, volume: null,
    turnoverRate: null, marketCap: null, floatCap: null, pe: null, pb: null, high: null, low: null, open: null, prevClose: null,
    meta: { providerId: 'sample', sourceName: '样例报价', sourceTimestamp: date, fetchedAt: date + 'T10:30:00+08:00', cacheState: 'stale' },
  }
  render(<TestPanel client={{ call } as unknown as HanaiClient} onStock={vi.fn()} intraday={{ date, ladder: null, quotes: [quote] }} />)
  fireEvent.click(await screen.findByText('跟踪个股行情'))
  const observed = within(await screen.findByRole('region', { name: '盘中观察' }))
  expect(observed.getByText('缓存涨跌幅 -2.00%')).toBeVisible()
  expect(observed.queryByText('当前尚未晋级')).toBeNull()
})

it('keeps the decision, evidence and falsification visible while intraday facts leave confidence unchanged', async () => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-11-19T10:00:00+08:00'))
  try {
    const theme = '样本题材'
    const rule = { label: '题材两家跌停即退出', action: '撤销' as const, all: [{ metric: 'theme_limit_down', op: '>=' as const, value: 2 }] }
    const asOf = date + 'T15:25:00+08:00'
    const main = { ...stock, theme, role: '总龙候选' as const, confidence: '高' as const, weight: 4, falsifiers: [rule] }
    const day: LeaderDecision = {
      date, previousDate: previous, asOf, mode: 'close', candidates: [main],
      observations: [{ ...breakout, theme, role: '次龙/卡位候选', confidence: '低', weight: 1, falsifiers: [rule],
        reason: '逆势封板待验证', admitWhen: rule.all, verification: '次日验证' }],
      journal: [{ key: theme + '/' + stock.code, action: '上调', reason: '晋级且带动未减弱',
        previousConfidence: '中', confidence: '高', metrics: { boards: { value: 5, observedAt: asOf, evidence: ['ladder'] } } }],
      alerts: [{ level: 'L3', theme, code: stock.code, reason: '补涨先退潮', action: '停止在该题材内新开仓', evidence: ['ladder'] }],
      themes: { [theme]: { state: 'DIVERGENCE', conclusion: '补涨先转弱', rule: '补涨存活率破阈值', evidence: ['ladder'] } },
    }
    const older: LeaderDecision = {
      ...day, date: previous, asOf: previous + 'T16:00:00+08:00', candidates: [{ ...main, confidence: '中' }],
      journal: [], observations: [], alerts: [], themes: { [theme]: { state: 'MAIN_RALLY', conclusion: '主升延续', evidence: ['ladder'] } },
    }
    let broken: string[] = []
    const call = vi.fn(async (_endpoint: string, request: { date?: string }) => ({
      selected: null, latestConfirmed: null, dates: [date, previous], latestClosingDate: date, canGenerate: false,
      decisions: request.date === previous ? [older] : [day, older],
      decisionFacts: [{ reviewDate: date, id: 'ladder', data: { sample: 5 } }],
      checkpoint: { slot: '10:00', observedAt: '2026-11-19T10:00:00+08:00', sealed: [], resealed: [], broken, pending: [] },
    }))
    const ladder: MarketLadderData = { date: '2026-11-19', stocks: [], brokenStocks: [stock], promotion: null, broken: 1, issues: [],
      meta: { providerId: 'sample', sourceName: '样例快照', sourceTimestamp: '2026-11-19',
        fetchedAt: '2026-11-19T09:58:00+08:00', cacheState: 'fresh' } }
    render(<TestPanel client={{ call } as unknown as HanaiClient} onStock={vi.fn()} intraday={{ date: ladder.date, ladder }} />)
    await act(async () => {})
    expect(screen.getByText('盘中观察', { selector: 'header p' })).toBeVisible()
    expect(within(screen.getByRole('note', { name: '最高级提示' })).getByText('停止在该题材内新开仓')).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: '周期回看' }))
    expect(screen.getByRole('note', { name: '最高级提示' })).toBeVisible()
    expect(screen.queryByRole('region', { name: '跟踪题材' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '判断' }))
    const feed = within(screen.getByRole('region', { name: '今日改判' }))
    expect(feed.getByText('本检查点暂未覆盖已跟踪候选。')).toBeVisible()
    broken = [stock.code]
    await act(async () => { await vi.advanceTimersByTimeAsync(15_000) })
    expect(feed.getByText('九阳股份 · 炸板未回封')).toBeVisible()
    expect(feed.queryByText('主升 → 分歧')).toBeNull()
    const topicList = within(screen.getByRole('region', { name: '跟踪题材' }))
    fireEvent.click(topicList.getByText(theme))
    const cards = within(screen.getByRole('region', { name: '候选判断' }))
    expect(cards.getByText('↑ 高确信度')).toBeVisible()
    expect(cards.getByText(/盘中偏离 · 炸板未回封/)).toBeVisible()
    expect(cards.getByRole('region', { name: '证伪条件' })).toBeVisible()
    expect(topicList.getByText('框架外观察')).toBeVisible()
    expect(cards.queryByText('纠错记录')).toBeNull()
    expect(screen.queryByRole('table')).toBeNull()
    fireEvent.click(topicList.getByText(date + ' · 纠错与提示'))
    expect(topicList.getByText('晋级且带动未减弱', { exact: false })).toBeVisible()
    const fact = cards.getByText('连板 · 5')
    fireEvent.click(fact)
    const raw = within(fact.closest('details')!)
    fireEvent.click(raw.getByText('查看冻结原始数据'))
    expect(raw.getByText(/"sample": 5/)).toBeVisible()
    fireEvent.change(screen.getByRole('combobox', { name: '复盘日期' }), { target: { value: date } })
    await act(async () => {})
    const historical = within(screen.getByRole('region', { name: '当日改判' }))
    expect(historical.getByText('主升 → 分歧')).toBeVisible()
    expect(historical.getByText('补涨存活率破阈值')).toBeVisible()
    const link = historical.getByRole('link', { name: /查看题材详情/ })
    fireEvent.click(link)
    const phases = within(screen.getByRole('region', { name: '周期状态时间轴' }))
    expect(phases.getByText('补涨存活率破阈值')).toBeVisible()
    fireEvent.click(phases.getByRole('button', { name: '查看 2026-11-17 周期状态' }))
    await act(async () => {})
    expect(call).toHaveBeenLastCalledWith('topic-cycle.view', { date: previous }, expect.any(AbortSignal))
    expect(screen.getByText('当日无改判。')).toBeVisible()
    fireEvent.click(within(screen.getByRole('region', { name: '跟踪题材' })).getByText(theme))
    expect(screen.getByText('→ 中确信度')).toBeVisible()
    expect(screen.queryByText(/盘中偏离 · 炸板未回封/)).toBeNull()
    expect(screen.queryByRole('note', { name: '最高级提示' })).toBeNull()
  } finally {
    vi.useRealTimers()
  }
})
