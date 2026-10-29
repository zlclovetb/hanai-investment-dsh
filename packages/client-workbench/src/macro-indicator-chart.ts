import type { EChartsCoreOption } from 'echarts/core'
import type { MacroIndicatorData, MacroIndicatorDefinition } from '../../contracts/src/macro-indicators.ts'
import type { MacroRange } from '../../contracts/src/macro-range.ts'
import type { ChartPalette } from './chart-options.ts'

/** Keep real holes; cumulative Jan-Feb reports use their actual published periods. */
export function buildMacroIndicatorOption(definition: MacroIndicatorDefinition, data: MacroIndicatorData | undefined, range: MacroRange, palette: ChartPalette): EChartsCoreOption {
  let points = data?.points ?? []
  if (definition.frequency === 'monthly') {
    const actual = new Map(points.map(point => [point.date, point]))
    const months = []
    const cursor = new Date(`${range.from.slice(0, 7)}-01T00:00:00Z`)
    while (cursor.toISOString().slice(0, 7) <= range.to.slice(0, 7)) {
      const date = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, 0)).toISOString().slice(0, 10)
      if (date >= range.from && date <= range.to) months.push(actual.get(date) ?? { date, values: {} })
      cursor.setUTCMonth(cursor.getUTCMonth() + 1)
    }
    points = months
  }
  const stamp = (date: string) => Date.parse(`${date}T00:00:00+08:00`)
  const combinedReports = definition.id === 'industry' || definition.id === 'retail'
  const combined = new Map((combinedReports ? points : []).filter(point => point.date.slice(5, 7) === '02' && point.values.yoy == null && point.values.ytd != null).map(point => [point.date.slice(0, 4), point]))
  const tooltip = {
    trigger: 'axis', renderMode: 'richText', backgroundColor: palette.tooltipBackground, borderColor: palette.tooltipBorder, textStyle: { color: palette.tooltipText },
    valueFormatter: (value: unknown) => typeof value === 'number' ? value.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + (definition.unit === '%' ? '%' : '') : '—',
    ...(combinedReports ? { formatter: (params: unknown) => {
      if (!Array.isArray(params) || params.length === 0) return ''
      const point = params.find(row => Array.isArray(row?.value) && Number.isFinite(row.value[0]))
      if (!point) return ''
      const date = new Date(Number(point.value[0]) + 8 * 3_600_000).toISOString().slice(0, 10)
      const report = combined.get(date.slice(0, 4))
      const title = report?.date === date ? `${date.slice(0, 4)}年1—2月（合并公布）` : date.slice(0, 7)
      return title + '\n' + definition.columns.map(column => {
        const value = params.find(row => row?.seriesName === column.name && row.value?.[0] === point.value[0])?.value?.[1]
        return `${column.name}：${typeof value === 'number' && Number.isFinite(value) ? tooltip.valueFormatter(value) : report?.date === date && column.key === 'yoy' ? '—（未单独公布）' : '—'}`
      }).join('\n')
    } } : {}),
  }
  return {
    animation: false, color: [palette.up, palette.averageBlue, palette.gold, palette.down],
    legend: { top: 8, textStyle: { color: palette.legendText } },
    grid: { left: 65, right: 30, top: 55, bottom: 65 },
    tooltip,
    xAxis: { type: 'time', min: stamp(range.from), max: stamp(range.to), axisLabel: { color: palette.axisLabel }, axisLine: { lineStyle: { color: palette.axisLine } } },
    yAxis: { type: 'value', name: definition.unit, scale: true, axisLabel: { color: palette.axisLabel }, nameTextStyle: { color: palette.axisLabel }, splitLine: { lineStyle: { color: palette.splitLine } } },
    dataZoom: [{ type: 'inside' }, { type: 'slider', bottom: 8, height: 18, borderColor: palette.axisLine, backgroundColor: palette.sliderBackground, textStyle: { color: palette.axisLabel } }],
    series: definition.columns.map((column, index) => ({ type: definition.kind, name: column.name, showSymbol: points.filter(point => point.values[column.key] != null).length === 1, symbolSize: 5, connectNulls: false, barMaxWidth: 18,
      // Only omit an absent January slot when a verified combined report supplies the next observation.
      data: points.filter(point => !(column.key === 'ytd' && point.date.slice(5, 7) === '01' && point.values.ytd == null && point.values.yoy == null && combined.has(point.date.slice(0, 4)))).map(point => [stamp(point.date), point.values[column.key] ?? null]),
      ...(column.key === 'ytd' && combined.size > 0 ? { markPoint: { silent: true, symbol: 'circle', symbolSize: 5, label: { show: true, position: 'top', formatter: '1—2月', fontSize: 10, color: palette.axisLabel }, data: [...combined.values()].map(point => ({ name: `${point.date.slice(0, 4)}年1—2月`, coord: [stamp(point.date), point.values.ytd] })) } } : {}),
      ...(definition.id === 'pmi' && index === 0 ? { markLine: { silent: true, symbol: 'none', data: [{ yAxis: 50, name: '荣枯线' }], label: { formatter: '50 荣枯线' } } } : {}),
    })),
  }
}
