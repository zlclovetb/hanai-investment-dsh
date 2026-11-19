// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MarketActivityPanel, buildMarketActivityOption } from '../src/market-activity.tsx'
import { LIGHT_CHART_PALETTE } from '../src/chart-options.ts'
import type { MarketHistorySnapshot } from '../../contracts/src/market-history.ts'
import type { MarketIntradayData, MarketSignalsData } from '../../contracts/src/market-activity.ts'

vi.mock('../src/echarts.tsx', () => ({ EChart: ({ ariaLabel, option }: { ariaLabel: string; option: { series: Array<{ name?: string; data?: Array<{ name: string }> }> } }) => <div aria-label={ariaLabel}>{option.series.find(series => series.name === '板块异动')?.data?.map((point, index) => <span key={index}>{point.name}</span>)}</div> }))
const meta = { providerId: 'tencent', sourceName: '腾讯行情', sourceTimestamp: '2026-10-27T07:00:00Z', fetchedAt: '2026-10-27T07:06:00Z', cacheState: 'fresh' as const }
const trend: MarketIntradayData = { date: '2026-10-27', prevClose: 3600, points: [{ time: '09:30', price: 3601, avgPrice: 3600, volume: 0 }, { time: '15:00', price: 3610, avgPrice: 3605, volume: 10 }], meta }
const signals: MarketSignalsData = { date: trend.date, method: 'ths-sector-events-v2', signals: [{ time: '09:30', name: '机器人', code: '886069', title: '机器人板块上涨', direction: 'up' }], meta }
const archived = (): MarketHistorySnapshot => ({ date: trend.date, panels: ['intraday', 'signals'], capturedAt: meta.fetchedAt, records: {
  intraday: { key: 'intraday', version: 1, capturedAt: meta.fetchedAt, data: trend, meta },
  signals: { key: 'signals', version: 1, capturedAt: meta.fetchedAt, data: signals, meta },
} })
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-27T10:00:00+08:00')) })
afterEach(() => { cleanup(); vi.useRealTimers() })
function setup(snapshot: MarketHistorySnapshot | null = archived(), historical = false) {
  const props = { snapshot, historical, palette: LIGHT_CHART_PALETTE }
  return { props, ...render(<MarketActivityPanel {...props} />) }
}
describe('market activity panel', () => {
  it('shows lunch cache status and preserves failure precedence from the published snapshot', () => {
    vi.setSystemTime(new Date('2026-10-27T12:12:00+08:00'))
    const { props, rerender } = setup()
    expect(screen.getByText('休市缓存')).toBeTruthy()
    rerender(<MarketActivityPanel {...props} errors={{ signals: 'offline' }} />)
    expect(screen.getByText('刷新失败')).toBeTruthy()
    expect(screen.queryByText('休市缓存')).toBeNull()
  })
  it('opens a page dialog, restores on button or Escape, and never refetches for resizing', async () => {
    const saved = {
      show: Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, 'showModal'),
      close: Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, 'close'),
    }
    const show = vi.fn(function (this: HTMLDialogElement) { this.open = true })
    const close = vi.fn(function (this: HTMLDialogElement) { this.open = false; this.dispatchEvent(new Event('close')) })
    Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value: show })
    Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true, value: close })
    try {
      setup()
      await act(async () => {})
      const card = screen.getByLabelText('大盘异动')
      card.style.padding = '0 24px'
      Object.defineProperty(card, 'clientWidth', { configurable: true, value: 800 })
      vi.spyOn(card, 'getBoundingClientRect').mockReturnValue({ x: 176, left: 176, top: 46, bottom: 446, width: 800, height: 400, right: 976, y: 46, toJSON: () => ({}) })
      fireEvent.click(screen.getByRole('button', { name: '放大大盘异动' }))
      await act(async () => {})
      const dialog = screen.getByRole('dialog', { name: '放大的大盘异动' }) as HTMLDialogElement
      expect(show).toHaveBeenCalledTimes(1)
      expect(dialog.style.left).toBe('200px')
      expect(dialog.style.width).toBe('752px')
      Object.defineProperty(card, 'clientWidth', { configurable: true, value: 600 })
      fireEvent(window, new Event('resize'))
      expect(dialog.style.width).toBe('552px')
      expect(within(dialog).getByText('机器人')).toBeTruthy()
      expect(document.fullscreenElement ?? null).toBeNull()
      fireEvent.click(within(dialog).getByRole('button', { name: '缩小大盘异动' }))
      await act(async () => {})
      expect(close).toHaveBeenCalledTimes(1)
      expect(screen.queryByRole('dialog')).toBeNull()
      fireEvent.click(screen.getByRole('button', { name: '放大大盘异动' }))
      await act(async () => {})
      fireEvent(dialog, new Event('cancel'))
      await act(async () => {})
      expect(screen.queryByRole('dialog')).toBeNull()
      expect(screen.getByRole('button', { name: '放大大盘异动' }).getAttribute('aria-pressed')).toBe('false')
      expect(screen.getByText('机器人')).toBeTruthy()
    } finally {
      cleanup()
      for (const [key, descriptor] of [['showModal', saved.show], ['close', saved.close]] as const) {
        if (descriptor !== undefined) Object.defineProperty(HTMLDialogElement.prototype, key, descriptor)
        else Reflect.deleteProperty(HTMLDialogElement.prototype, key)
      }
    }
  })
  it('renders one published trend/signals pair without owning a polling loop', async () => {
    setup()
    expect(screen.getByLabelText('大盘异动分时走势图')).toBeTruthy()
    expect(screen.getByText('机器人').closest('[aria-label="大盘异动分时走势图"]')).toBeTruthy()
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000) })
    expect(screen.getByRole('heading', { name: '大盘异动' }).closest('header')?.textContent).not.toMatch(/腾讯行情|同花顺|数据时间|获取于/)
    const option = buildMarketActivityOption(trend, signals, LIGHT_CHART_PALETTE)!
    const scatter = (option.series as Array<{ name?: string; data?: Array<{ value: number[]; label: { show: boolean; formatter: () => string } }> }>).find(series => series.name === '板块异动')!
    expect(scatter.data?.[0]).toMatchObject({ value: [0, 3601], label: { show: true } })
    expect(scatter.data?.[0]?.label.formatter()).toBe('机器人')
    const layout = (scatter as unknown as { labelLayout: (params: { labelRect: { x: number; y: number; width: number } }) => unknown }).labelLayout
    expect(layout({ labelRect: { x: 40, y: 10, width: 30 } })).toMatchObject({ x: 55, y: 10, moveOverlap: 'shiftY', hideOverlap: false })
    const tooltip = option.tooltip as { formatter: (value: unknown) => string }
    expect(tooltip.formatter([{ dataIndex: 0 }])).toContain(' 点')
    expect(tooltip.formatter([{ dataIndex: 0 }])).not.toContain(' 元')
    expect((buildMarketActivityOption(trend, { ...signals, date: '2026-10-26' }, LIGHT_CHART_PALETTE)!.series as Array<{ data: unknown[] }>).at(-1)?.data).toEqual([])
  })

  it('renders explicit historical gaps locally and keeps old signal coverage visible', () => {
    const { props, rerender } = setup(archived(), true)
    expect(screen.getByText('历史快照')).toBeTruthy()
    rerender(<MarketActivityPanel {...props} snapshot={null} />)
    expect(screen.getByText('该日期未保存大盘分时')).toBeTruthy()
    expect(screen.getByText('该日期未保存板块异动')).toBeTruthy()
    const legacy = archived()
    legacy.records.signals!.data = { ...signals, method: undefined }
    rerender(<MarketActivityPanel {...props} snapshot={legacy} />)
    expect(screen.getByText('旧版异动快照，仅保存了部分事件')).toBeTruthy()
  })
})
