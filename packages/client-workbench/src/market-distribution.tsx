import { DISTRIBUTION_BINS, type MarketDistributionData } from '../../contracts/src/market-distribution.ts'
import { EChart } from './echarts.tsx'
import { getChartPalette } from './chart-options.ts'
import type { ThemeId } from '../../contracts/src/index.ts'

export function DistributionChart({ data, theme }: { data: MarketDistributionData; theme: ThemeId }) {
  const palette = getChartPalette(theme)
  const bins = [...DISTRIBUTION_BINS].reverse()
  return <EChart ariaLabel="A 股涨跌幅九档分布（含 ST，按涨幅区间而非涨跌停）" style={{ height: 170 }} option={{
    animation: false,
    title: { text: '涨跌分布', left: 16, top: 4, textStyle: { color: palette.legendText, fontSize: 12, fontWeight: 'normal' } },
    grid: { left: 45, right: 16, top: 26, bottom: 34 },
    tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' }, renderMode: 'richText' },
    xAxis: { type: 'category', data: bins.map(([, label]) => label), axisLabel: { color: palette.axisLabel, fontSize: 10, interval: 0, rotate: 25 }, axisTick: { show: false } },
    yAxis: { type: 'value', minInterval: 1, splitNumber: 3, axisLabel: { color: palette.axisLabel, fontSize: 10 }, splitLine: { lineStyle: { color: palette.splitLine, type: 'dashed' } } },
    series: [{ type: 'bar', name: '家数', barMaxWidth: 32, label: { show: true, position: 'top', color: palette.axisLabel, fontSize: 10 },
      data: bins.map(([key]) => ({ value: data.counts[key], itemStyle: { color: key.startsWith('up') ? palette.up : key.startsWith('down') ? palette.down : palette.axisLabel, borderRadius: [3, 3, 0, 0] } })) }],
  }} />
}
