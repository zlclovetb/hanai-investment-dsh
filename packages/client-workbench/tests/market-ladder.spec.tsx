// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { MarketLadderPanels } from '../src/market-ladder.tsx'
import { ladderThemes } from '../../contracts/src/market-ladder.ts'
import type { MarketLadderData } from '../../contracts/src/market-ladder.ts'

const meta = { providerId: 'ths-limit-reason', sourceName: '同花顺涨停池', sourceTimestamp: '2026-10-30', fetchedAt: '2026-10-30T15:10:00+08:00', cacheState: 'fresh' as const }
const stock = (code: string, boards = 1) => ({ code, name: `梯队股${code}`, boards, industry: '食品', reason: '食品+业绩增长+食品', boardType: '换手板', firstSeal: '09:30:00', lastSeal: '10:00:00', breaks: 1, turnover: 12 })
const data: MarketLadderData = { yesterdayPerformance: null, missedPromotions: { confirmed: true, stocks: [] }, method: 'source-board-types-v1', date: '2026-10-30', stocks: [stock('001219', 3), ...Array.from({ length: 9 }, (_, i) => stock(`60000${i}`))], promotion: { eligible: 20, promoted: 1 }, broken: 5, issues: [], meta }
let gridColumns: string
beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-10-30T16:00:00+08:00'))
  gridColumns = '106px 106px 106px'
  const getComputedStyle = window.getComputedStyle.bind(window)
  vi.spyOn(window, 'getComputedStyle').mockImplementation((element, pseudo) => {
    const style = getComputedStyle(element, pseudo)
    if (element.className.toString().includes('ladderStocks')) style.gridTemplateColumns = gridColumns
    return style
  })
})
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.useRealTimers() })

it('shows missing ladder levels, caps first boards, retains metrics and opens a stock', () => {
  const onStock = vi.fn()
  render(<MarketLadderPanels data={data} historical={false} failed={false} pending={false} onStock={onStock} />)
  const card = screen.getByRole('article', { name: '涨停梯队' })
  expect(within(card).getByLabelText('2板梯队').textContent).toContain('0只')
  const first = within(card).getByLabelText('首板梯队')
  expect(within(first).getAllByRole('button')).toHaveLength(7)
  fireEvent.click(within(first).getByRole('button', { name: '展开其余 3 只' }))
  expect(within(first).getAllByRole('button')).toHaveLength(10)
  expect(within(card).getByLabelText('今日梯队摘要').textContent).toContain('5.0%')
  expect(within(card).getByText('33.3%')).toBeTruthy()
  const cardButton = within(card).getByRole('button', { name: /梯队股001219/ })
  fireEvent.focus(cardButton)
  expect(screen.getByRole('tooltip').textContent).toContain('首次封板 09:30:00')
  fireEvent.keyDown(cardButton, { key: 'Escape' })
  expect(screen.queryByRole('tooltip')).toBeNull()
  fireEvent.click(cardButton)
  expect(onStock).toHaveBeenCalledWith(expect.objectContaining({ secId: '0.001219' }))
  expect(ladderThemes(data).map(row => row.count)).toEqual([10, 10])
})

it('limits each level to two rows across sealed and missed stocks, including after resize', () => {
  gridColumns = '106px 106px'
  const missedStocks = Array.from({ length: 4 }, (_, i) => ({ ...stock(`00000${i}`, 2), changePct: -1 }))
  render(<MarketLadderPanels data={{ ...data, missedPromotions: { confirmed: true, stocks: missedStocks } }} historical={false} failed={false} pending={false} onStock={() => {}} />)
  const third = within(screen.getByLabelText('3板梯队'))
  const first = within(screen.getByLabelText('首板梯队'))
  expect(third.queryByText(missedStocks[3]!.name)).toBeNull()
  fireEvent.click(third.getByRole('button', { name: '展开其余 1 只' }))
  expect(third.getByText(missedStocks[3]!.name)).toBeTruthy()
  expect(first.getByRole('button', { name: '展开其余 5 只' })).toBeTruthy()
  fireEvent.click(third.getByRole('button', { name: '收起 3 板' }))
  expect(third.queryByText(missedStocks[3]!.name)).toBeNull()
  gridColumns = '106px 106px 106px'
  fireEvent.resize(window)
  expect(third.getByText(missedStocks[3]!.name)).toBeTruthy()
  expect(third.queryByRole('button', { name: /展开/ })).toBeNull()
  expect(first.getByRole('button', { name: '展开其余 3 只' })).toBeTruthy()
})

it('puts archived missed promotions at the attempted level with deletion styling and only sealed-stock counts', () => {
  const missed = { ...stock('000001', 3), changePct: -4.13, broken: true, brokenTiming: { firstTouch: '09:25:00', lastTouch: '09:40:51' } }
  const onStock = vi.fn()
  const view = render(<MarketLadderPanels data={{ ...data, missedPromotions: { confirmed: true, stocks: [missed] } }} historical failed={false} pending={false} onStock={onStock} />)
  const row = screen.getByLabelText('4板梯队')
  expect(within(row).getByText(missed.name).tagName).toBe('DEL')
  expect(within(row).getByText('-4.13%')).toBeTruthy()
  expect(within(row).getByRole('img', { name: '炸板' })).toBeTruthy()
  expect(within(row).queryByText('炸板')).toBeNull()
  expect(row.textContent).not.toMatch(/0只|晋级失败/)
  const card = within(row).getByRole('button', { name: new RegExp(missed.name) })
  fireEvent.mouseEnter(card)
  expect(screen.getByRole('tooltip').textContent).toContain('首封 09:25:00 · 炸板 09:40:51')
  fireEvent.mouseLeave(card)
  fireEvent.click(card)
  expect(onStock).toHaveBeenCalledWith(expect.objectContaining({ secId: '0.000001' }))
  expect(within(row).getByText('食品')).toBeTruthy()
  expect(screen.getByLabelText('今日梯队摘要').textContent).toContain('最高板3 板')
  view.rerender(<MarketLadderPanels data={{ ...data, missedPromotions: { confirmed: false, stocks: [{ ...stock('000001', 3), changePct: -4.13, broken: null }] } }} historical={false} failed={false} pending={false} onStock={() => {}} />)
  expect(row.textContent).not.toMatch(/暂未晋级|晋级失败|炸板/)
  expect(within(row).queryByRole('img', { name: '炸板' })).toBeNull()
  expect(within(row).getByText(missed.name).tagName).toBe('DEL')
})

it('shows zero-denominator and absent values as unavailable, not zero rates', () => {
  render(<MarketLadderPanels data={{ ...data, promotion: { eligible: 0, promoted: 0 }, broken: null }} historical={false} failed={false} pending={false} onStock={() => {}} />)
  expect(within(screen.getByLabelText('今日梯队摘要')).getAllByText('—')).toHaveLength(2)
})
it('shows yesterday performance in its own compact row with red/green counts in the tooltip', () => {
  render(<MarketLadderPanels data={{ ...data, yesterdayPerformance: { sample: 39, average: -0.68, median: -0.28, up: 19, down: 20, flat: 0, meta } }} historical={false} failed={false} pending={false} onStock={() => {}} />)
  const summary = screen.getByLabelText('昨日涨停今日表现')
  expect(within(summary).getByText('-0.68%')).toBeTruthy()
  expect(within(summary).getByText('-0.28%')).toBeTruthy()
  expect(summary.textContent).toContain('48.7%')
  fireEvent.mouseEnter(within(summary).getByText('翻红率').parentElement!)
  expect(screen.getByRole('tooltip').textContent).toBe('翻红 19只 · 翻绿 20只 · 平盘 0只')
})
it('shows explicit board types and does not infer a T board just from break counts', () => {
  const stocks = ['一字板', 'T字板', '换手板', null].map((boardType, i) => ({ ...stock(`60000${i}`), boardType, breaks: 3 }))
  render(<MarketLadderPanels data={{ ...data, stocks }} historical={false} failed={false} pending={false} onStock={() => {}} />)
  for (const label of ['一字板', 'T字板', '换手板', '板型待确认']) expect(screen.getByText(label)).toBeTruthy()
  expect(screen.queryByText('已封板')).toBeNull()
  expect(screen.queryByText('开板回封')).toBeNull()
})
