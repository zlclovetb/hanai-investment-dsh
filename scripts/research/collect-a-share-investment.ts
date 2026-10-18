import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { MarketDataService } from '../../packages/domain/src/providers/index.ts'
import type { KLineBar } from '../../packages/contracts/src/index.ts'

// Public market information only: never reads the user's watchlists, accounts or chats.
// Usage: pnpm exec tsx scripts/research/collect-a-share-investment.ts [YYYY-MM-DD]
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date())
const asOf = process.argv[2] ?? today
if (!/^\d{4}-\d{2}-\d{2}$/.test(asOf)) throw new Error('Expected YYYY-MM-DD')
if (asOf !== today) throw new Error('This collector reads live providers; it cannot reconstruct an earlier as-of snapshot')
const output = `docs/research-data/a-share-investment-${asOf}.json`
const candidates = [
  ['cash', '1.600941', '中国移动'], ['cash', '1.600900', '长江电力'],
  ['cash', '1.601088', '中国神华'], ['cash', '1.600036', '招商银行'],
  ['grid', '1.600406', '国电南瑞'], ['grid', '0.000400', '许继电气'],
  ['grid', '1.600312', '平高电气'], ['grid', '0.002028', '思源电气'],
  ['tech', '1.688012', '中微公司'], ['tech', '0.002371', '北方华创'],
  ['tech', '1.688008', '澜起科技'], ['tech', '0.300308', '中际旭创'],
  ['global', '0.000333', '美的集团'], ['global', '1.600690', '海尔智家'],
  ['global', '0.300750', '宁德时代'], ['global', '0.002594', '比亚迪'],
  ['domestic', '1.600519', '贵州茅台'], ['domestic', '1.600276', '恒瑞医药'],
  ['domestic', '0.300760', '迈瑞医疗'], ['domestic', '1.600085', '同仁堂'],
] as const
const service = new MarketDataService({ timeoutMs: 10_000 })
const selectedSkills = ['dong-taishan', 'sanhu-yi', 'duan-yongping', 'warren-buffett', 'munger']
const skills = await Promise.all(selectedSkills.map(async id => {
  const path = `packages/masters/assets/${id}-perspective/SKILL.md`
  return { path, sha256: createHash('sha256').update(await readFile(path)).digest('hex') }
}))
function technical(bars: KLineBar[]) {
  const valid = bars.filter(bar => bar.date.slice(0, 10) <= asOf).sort((a, b) => a.date.localeCompare(b.date))
  const last = valid.at(-1)
  const ma = (n: number) => valid.length < n ? null : valid.slice(-n).reduce((sum, bar) => sum + bar.close, 0) / n
  const ret = (n: number) => valid.length <= n || !last ? null : (last.close / valid[valid.length - n - 1]!.close - 1) * 100
  return { date: last?.date ?? null, barCount: valid.length, lastAdjustedClose: last?.close ?? null,
    ma20: ma(20), ma60: ma(60), return20: ret(20), return60: ret(60),
    // Sparse data for the report's small multiples; no future bars or invented history.
    recentCloses: valid.slice(-60).map(bar => [bar.date, bar.close]) }
}
const snapshot = {
  schema: 'hanai.public-investment-snapshot.v1', asOf, collectedAt: new Date().toISOString(),
  completedAt: null as string | null,
  notes: [
    '行情与财报通过 Hanai MarketDataService 原有数据链取得；来源、缓存与数据日期逐项保留。',
    '财务收入、归母净利润和 ROE 为报告期累计口径；PE TTM 使用软件财务口径。',
    '股息率为软件计算的近十二个月已实施税前分红／当前股价，不是未来分红预测。',
    '价值大师仅保留分析需要的数值摘要，不转存价格曲线、模型曲线或完整原始数据集；不代表再分发授权。',
    '技术指标用软件前复权日线计算；用于描述近期位置，不提供未来收益概率。',
  ],
  skills,
  indices: null as unknown,
  overview: null as unknown,
  securities: [] as unknown[],
}
await mkdir('docs/research-data', { recursive: true })
const [overview, indices] = await Promise.allSettled([
  service.eastmoney.getMarketOverview(), service.getQuotes(['1.000001', '0.399001', '0.399006', '1.000300']),
])
snapshot.overview = overview.status === 'fulfilled' ? overview.value : { error: String(overview.reason) }
snapshot.indices = indices.status === 'fulfilled' ? indices.value : { error: String(indices.reason) }
let next = 0
await Promise.all(Array.from({ length: 3 }, async () => {
  while (next < candidates.length) {
    const [direction, secId, expectedName] = candidates[next++]!
    const [financial, kline, valuation] = await Promise.allSettled([
      service.getStockQuoteMetrics(secId), service.getKline(secId, 'daily'), service.getValuation(secId),
    ])
    const qm = financial.status === 'fulfilled' ? financial.value : null
    if (qm?.quote && (qm.quote.code !== secId.split('.')[1] || qm.quote.name !== expectedName)) {
      throw new Error(`Identity mismatch: ${secId} ${qm.quote.name}`)
    }
    const val = valuation.status === 'fulfilled' ? valuation.value : null
    const { series: _series, ...valuationSummary } = val?.valuation ?? { series: null }
    const entry = {
      direction, secId, code: secId.split('.')[1], name: expectedName,
      quote: qm?.quote ?? null, metrics: qm?.metrics ?? null, sources: qm?.sources ?? null,
      technical: kline.status === 'fulfilled' ? { ...technical(kline.value.bars), meta: kline.value.meta } : null,
      valuation: val?.valuation ? valuationSummary : null, valuationMeta: val?.meta ?? null,
      sourceLinks: {
        quote: `https://quote.eastmoney.com/${secId.startsWith('1.') ? 'sh' : 'sz'}${secId.split('.')[1]}.html`,
        gurufocus: `https://www.gurufocus.cn/stock/${secId.startsWith('1.') ? 'SHSE' : 'SZSE'}:${secId.split('.')[1]}/summary`,
      },
      errors: [financial, kline, valuation].flatMap((result, i) => result.status === 'rejected' ? [{ stage: i, message: String(result.reason) }] : []),
    }
    snapshot.securities.push(entry)
    console.log(`${expectedName} ${qm?.quote?.price ?? 'N/A'} PE=${qm?.metrics?.peTtm ?? 'N/A'} report=${qm?.metrics?.reportDate ?? 'N/A'} GF=${val?.valuation?.gfScore ?? 'N/A'} (${snapshot.securities.length}/20)`)
  }
}))
snapshot.securities.sort((a, b) => candidates.findIndex(c => c[1] === (a as { secId: string }).secId) - candidates.findIndex(c => c[1] === (b as { secId: string }).secId))
snapshot.completedAt = new Date().toISOString()
// Publish once, after all workers finish. Never overwrite an already frozen report.
await writeFile(output, `${JSON.stringify(snapshot, null, 2)}\n`, { flag: 'wx' })
console.log(`Saved ${output}`)
