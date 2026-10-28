import type { MacroCapitalData } from '../../../contracts/src/market-macro.ts'
import { beijingMarketDate, isMarketDate } from '../../../contracts/src/market-history.ts'
import { isoNow, type Clock, type HttpClient } from '../http.ts'
import { ProviderCache } from './cache.ts'
import type { SourceCircuit } from './source-circuit.ts'

const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)

export function parseMacroCapital(raw: unknown, month: string): MacroCapitalData['points'] {
  if (!object(raw) || raw.error != null || raw.success === false || !Array.isArray(raw.result)) throw new Error('上交所沪深300月报格式错误')
  const points = new Map<string, number>()
  for (const row of raw.result) {
    if (!object(row) || typeof row.MDATE !== 'string' || !/^\d{8}$/.test(row.MDATE) || !row.MDATE.startsWith(month)) throw new Error('沪深300月报日期不匹配')
    const date = `${row.MDATE.slice(0, 4)}-${row.MDATE.slice(4, 6)}-${row.MDATE.slice(6)}`
    const value = row.CPT_NGT
    const floatCap = typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value) ? Number(value) : value
    if (!isMarketDate(date) || points.has(date) || typeof floatCap !== 'number' || !Number.isFinite(floatCap) || floatCap <= 0) throw new Error('沪深300流通市值无效')
    points.set(date, floatCap)
  }
  return [...points].sort(([a], [b]) => a.localeCompare(b)).map(([date, floatCap]) => ({ date, floatCap }))
}

export class MarketMacroCapitalProvider {
  private readonly cache: ProviderCache<MacroCapitalData>
  constructor(private readonly http: HttpClient, private readonly clock: Clock, private readonly circuit: SourceCircuit) {
    this.cache = new ProviderCache(clock, 60_000)
  }

  async get(previous: MacroCapitalData | null): Promise<MacroCapitalData | null> {
    const to = beijingMarketDate(this.clock.now())
    const from = `${Number(to.slice(0, 4)) - 5}${to.slice(4)}`
    const months: string[] = []
    for (let year = Number(from.slice(0, 4)); year <= Number(to.slice(0, 4)); year += 1) {
      for (let month = 1; month <= 12; month += 1) {
        const key = `${year}${String(month).padStart(2, '0')}`
        if (key >= from.slice(0, 7).replace('-', '') && key <= to.slice(0, 7).replace('-', '')) months.push(key)
      }
    }
    const checked = new Set((previous?.checkedMonths ?? []).filter(month => months.includes(month)))
    const points = new Map((previous?.points ?? []).filter(point => point.date >= from && point.date <= to).map(point => [point.date, point.floatCap]))
    // Recheck unpublished/revised recent months on a later manual generation, never on a timer.
    if (previous !== null && this.clock.now() - Date.parse(previous.meta.fetchedAt) >= 6 * 3_600_000) {
      for (const month of months.slice(-2)) checked.delete(month)
    }
    const pending = months.filter(month => !checked.has(month)).reverse().slice(0, 6)
    if (pending.length === 0) return previous
    const result = await this.cache.get(`${to}:${[...checked].sort().join(',')}`, () => this.circuit.run('sse-statistics', async () => {
      for (const month of pending) {
        const params = new URLSearchParams({ sqlId: 'COMMON_SSE_ZQZS_M_CSI300_INDEX_C', isPagination: 'false', MDATE: month })
        const response = await this.http.request(`https://query.sse.com.cn/commonQuery.do?${params}`, {
          timeoutMs: 5000, headers: { Referer: 'https://www.sse.com.cn/aboutus/publication/monthly/index/' },
        })
        if (response.status !== 200) throw new Error(`沪深300月报 HTTP ${response.status}`)
        for (const point of parseMacroCapital(JSON.parse(response.body), month)) if (point.date >= from && point.date <= to) points.set(point.date, point.floatCap)
        checked.add(month)
        await this.clock.sleep(300)
      }
      const rows = [...points].sort(([a], [b]) => a.localeCompare(b)).map(([date, floatCap]) => ({ date, floatCap }))
      if (rows.length === 0) throw new Error('沪深300月报尚无可用流通市值')
      return { points: rows, checkedMonths: [...checked].sort(), complete: months.every(month => checked.has(month)),
        meta: { providerId: 'sse-statistics', sourceName: '上交所统计月报·沪深300流通市值（亿元）', sourceTimestamp: rows.at(-1)!.date, fetchedAt: isoNow(this.clock), cacheState: 'fresh' } }
    }))
    return result ?? (previous === null ? null : { ...previous, meta: { ...previous.meta, cacheState: 'stale' } })
  }

  clear(): number { return this.cache.clear() }
}
