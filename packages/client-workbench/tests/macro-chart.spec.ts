import { describe, expect, it } from 'vitest'
import { MACRO_ETFS, type MacroEtfData } from '../../contracts/src/market-macro.ts'
import { isMarketPanelPayload } from '../../contracts/src/market-history.ts'
import { macroTotals, macroRatios, buildMacroOption } from '../src/macro-chart.ts'
import { getChartPalette } from '../src/chart-options.ts'

const data: MacroEtfData = { funds: MACRO_ETFS.map(fund => ({ code: fund.code, points: [{ date: '2026-06-30', assets: 100 }] })),
  meta: { providerId: 'eastmoney-fund', sourceName: '公开季报', sourceTimestamp: '2026-06-30', fetchedAt: '2026-10-27T08:00:00Z', cacheState: 'fresh' } }

describe('macro chart', () => {
  it('draws the accepted blue dashed quarter reference only at complete quarter observations with matching caps', () => {
    const all = { ...data, universeAsOf: '2026-10-28', funds: data.funds.map(fund => ({ ...fund, name: fund.code, inceptionDate: '2013-01-01' })) }
    const capital = { points: [{ date: '2026-06-30', floatCap: 500000 }], checkedMonths: ['202606'], complete: false, meta: data.meta }
    const option = buildMacroOption(data, null, getChartPalette('dark'), '2026-10-28', null, capital, all)
    const series = option.series as Array<{ name: string; yAxisIndex: number; showSymbol: boolean; lineStyle: { type: string }; data: unknown[][] }>
    expect(series[2]).toMatchObject({ yAxisIndex: 0, showSymbol: true, lineStyle: { type: 'dashed' } })
    expect(series[2]?.name).toContain('季末参考')
    expect(series[2]?.name).toContain('在列')
    expect(series[2]?.data.map(point => point[1])).toEqual([0.08])
    expect(buildMacroOption(data, null, getChartPalette('dark'), '2026-10-28', null, null, all).series).toHaveLength(2)
  })
  it('plots the upper red ratio using same-day tradable caps, leaving missing dates disconnected and never substituting quarter assets', () => {
    const daily = { points: [{ date: '2026-06-29', assets: 1000 }, { date: '2026-06-30', assets: 1200 }, { date: '2026-07-01', assets: 1300 }], expectedDays: 3, complete: true, meta: data.meta }
    const capital = { points: [{ date: '2026-06-29', floatCap: 500000 }, { date: '2026-07-01', floatCap: 520000 }], checkedMonths: ['202606', '202607'], complete: false, meta: data.meta }
    expect(macroRatios(daily, capital)).toEqual([{ date: '2026-06-29', ratio: 0.2 }, { date: '2026-07-01', ratio: 0.25 }])
    const option = buildMacroOption(data, null, getChartPalette('light'), '2026-10-28', daily, capital)
    const series = option.series as Array<{ name: string; yAxisIndex: number; connectNulls: boolean; data: unknown[][]; lineStyle: { color: string } }>
    expect(series[2]).toMatchObject({ yAxisIndex: 0, connectNulls: false, lineStyle: { color: getChartPalette('light').up } })
    expect(series[2]?.data.map(point => point[1])).toEqual([0.2, null, 0.25])
    expect(series[2]?.name).toContain('占比')
    expect(macroRatios(null, capital)).toEqual([])
    expect(buildMacroOption(data, null, getChartPalette('light'), '2026-10-28', null, capital).series).toHaveLength(2)
  })
  it('sums only matching four-fund periods and never invents ratios or other ETF scales', () => {
    expect(macroTotals(data)).toEqual([{ date: '2026-06-30', assets: 400 }])
    const missing = { ...data, funds: data.funds.map((fund, i) => i === 0 ? fund : { ...fund, points: [] }) }
    expect(macroTotals(missing)).toEqual([])
    const option = buildMacroOption(data, null, getChartPalette('light'), '2026-10-27')
    expect(option.series).toHaveLength(2)
    expect(JSON.stringify(option)).not.toContain('其它沪深300')
    expect(isMarketPanelPayload('macro.etf', data)).toBe(true)
    expect(isMarketPanelPayload('macro.etf', missing)).toBe(false)
    expect(isMarketPanelPayload('macro.index', { points: [{ date: '2026-02-30', close: 4000 }], meta: data.meta })).toBe(false)
  })
  it('draws the true daily size in red with an area and leaves unavailable ratios unplotted', () => {
    const daily = { points: [{ date: '2026-06-29', assets: 450 }, { date: '2026-06-30', assets: 470 }], expectedDays: 2, complete: true, meta: { ...data.meta, sourceTimestamp: '2026-06-30' } }
    const option = buildMacroOption(data, null, getChartPalette('light'), '2026-10-27', daily)
    const series = option.series as Array<{ name: string; lineStyle: { color: string; type?: string }; areaStyle?: { opacity: number }; data: number[][] }>
    expect(series[1]?.name).toBe('四只沪深300ETF每日规模合计')
    expect(series[1]?.lineStyle).toMatchObject({ color: getChartPalette('light').up, type: 'solid' })
    expect(series[1]?.areaStyle?.opacity).toBeGreaterThan(0)
    expect(series[1]?.data.map(point => point[1])).toEqual([450, 470])
    expect(series).toHaveLength(2)
    const quarter = buildMacroOption(data, null, getChartPalette('light'), '2026-10-27').series as typeof series
    expect(quarter[1]?.name).toContain('季度参考')
    expect(quarter[1]?.lineStyle).toMatchObject({ color: getChartPalette('light').up, type: 'dashed' })
    expect(quarter[1]?.data.map(point => point[1])).toEqual([400])
    const darkQuarter = buildMacroOption(data, null, getChartPalette('dark'), '2026-10-27').series as typeof series
    expect(darkQuarter[1]?.lineStyle).toMatchObject({ color: getChartPalette('dark').up, type: 'dashed' })
    expect(isMarketPanelPayload('macro.etf.daily', daily)).toBe(true)
    expect(isMarketPanelPayload('macro.etf.daily', { ...daily, complete: false })).toBe(false)
    expect(isMarketPanelPayload('macro.etf.daily', { ...daily, points: [daily.points[0], daily.points[0]] })).toBe(false)
  })

  it('draws the daily blue ratio and stacks only other ETF assets above matching red assets, leaving gaps empty', () => {
    const dates = ['2026-06-29', '2026-06-30', '2026-07-01']
    const meta = { ...data.meta, sourceTimestamp: dates[2]! }
    const all = { funds: MACRO_ETFS.map(fund => ({ code: fund.code, name: fund.code, listedOn: '2012-01-01' })), universeAsOf: '2026-10-27',
      points: [{ date: dates[0]!, assets: 500, fourAssets: 450, otherAssets: 50 }, { date: dates[2]!, assets: 530, fourAssets: 470, otherAssets: 60 }],
      missingDates: [{ date: dates[1]!, reason: '缺净值' }], expectedDays: 3, complete: false, meta }
    const index = { points: dates.map(date => ({ date, close: 4000 })), meta }
    const capital = { points: dates.map(date => ({ date, floatCap: 500000 })), checkedMonths: ['202606', '202607'], complete: false, meta }
    const series = buildMacroOption(data, index, getChartPalette('light'), '2026-10-27', null, capital, null, all).series as Array<{ name: string; stack?: string; connectNulls?: boolean; data: unknown[][]; lineStyle: { type?: string } }>
    expect(series[1]?.data.map(row => row[1])).toEqual([450, null, 470])
    const blue = series.find(row => row.name.includes('占比（日频'))!
    expect(blue.lineStyle.type).toBe('dashed')
    expect(blue.data.map(row => row[1])).toEqual([0.1, null, 0.106])
    const other = series.find(row => row.name.startsWith('其它'))!
    expect(other.stack).toBe(series[1]?.stack)
    expect(other.data.map(row => row[1])).toEqual([50, null, 60])
    expect(other.connectNulls).toBe(false)
  })

  it('breaks the red line across missing trading days instead of interpolating an uncollected interval', () => {
    const daily = { points: [{ date: '2026-06-29', assets: 450 }, { date: '2026-07-01', assets: 470 }], expectedDays: 3, complete: false, meta: { ...data.meta, sourceTimestamp: '2026-07-01' } }
    const index = { points: ['2026-06-29', '2026-06-30', '2026-07-01'].map(date => ({ date, close: 4000 })), meta: data.meta }
    const series = buildMacroOption(data, index, getChartPalette('dark'), '2026-10-27', daily).series as Array<{ data: unknown[][]; connectNulls?: boolean }>
    expect(series[1]?.data.map(point => point[1])).toEqual([450, null, 470])
    expect(series[1]?.connectNulls).toBe(false)
  })

})
