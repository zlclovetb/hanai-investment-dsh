import type { StockQuote, ProviderMeta } from '../../../contracts/src/index.ts'
import type { MarketLadderData, LimitUpStock, YesterdayLimitPerformance, LadderPromotionCandidate, LadderMissedPromotions, PreviousLadder } from '../../../contracts/src/market-ladder.ts'
import { LADDER_BOARD_TYPE_METHOD, limitBoardType } from '../../../contracts/src/market-ladder.ts'
import { beijingMarketDate, isMarketDate, marketDateFromMeta } from '../../../contracts/src/market-history.ts'
import { isMarketOpen } from '../../../contracts/src/market-hours.ts'
import { fetchJson, isoNow, type HttpClient, type Clock } from '../http.ts'
import { ProviderCache } from './cache.ts'
import { SourceCircuit } from './source-circuit.ts'
import type { HistoricalLimitPool } from '../../../contracts/src/technical-screen.ts'
import { defaultMacroRange } from '../../../contracts/src/macro-range.ts'

const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v)
const count = (v: unknown) => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0
type PreviousSample = Pick<LadderPromotionCandidate, 'code' | 'name' | 'boards' | 'industry'>
type PreviousResult = { performance: YesterdayLimitPerformance | null; candidates: LadderPromotionCandidate[] | null }

const thsBoards = (value: unknown): number => {
  if (value === '首板') return 1
  const match = typeof value === 'string' ? value.match(/^(\d+)天(\d+)板$/) : null
  return match && match[1] === match[2] ? Number(match[1]) : NaN
}

const beijingTime = (seconds: number) => new Date(seconds * 1000 + 8 * 3_600_000).toISOString().slice(11, 19)
const sealTime = (v: unknown): string => {
  const raw = String(v).padStart(6, '0')
  if (!/^([01]\d|2[0-3])[0-5]\d[0-5]\d$/.test(raw)) throw new Error('封板时间无效')
  return `${raw.slice(0, 2)}:${raw.slice(2, 4)}:${raw.slice(4)}`
}

/** Public pool batches, not a scan of every stock. Each pool has its own failure circuit. */
export class MarketLadderProvider {
  readonly circuit: SourceCircuit
  private readonly cache: ProviderCache<MarketLadderData>
  constructor(private readonly http: HttpClient, private readonly clock: Clock, private readonly timeoutMs = 5000, private readonly quotes?: (secIds: string[]) => Promise<{ quotes: StockQuote[]; meta: ProviderMeta }>) {
    this.circuit = new SourceCircuit({ clock })
    this.cache = new ProviderCache(clock, () => isMarketOpen(new Date(clock.now())) ? 25_000 : 6 * 3_600_000)
  }
  clear() { return this.cache.clear() }
  /** Historical membership needs neither continuous-board interpretation nor today's quotes. */
  async historicalPool(date: string): Promise<HistoricalLimitPool> {
    if (!isMarketDate(date) || date > defaultMacroRange(this.clock.now()).to) throw new Error('历史涨停池必须属于已收盘日期')
    let codes: string[], source: string
    try {
      const { rows } = await this.circuit.run('ths-limit-reason', () => this.thsRows(date))
      codes = rows.map(row => String(row.code)); source = 'ths-limit-reason'
    } catch {
      const rows = await this.circuit.run('eastmoney-limit-up', () => this.pool('getTopicZTPool', date))
      codes = rows.map(row => String(row.c)); source = 'eastmoney-limit-up'
    }
    return { date, codes, source, fetchedAt: isoNow(this.clock), scope: 'source-pool-positive-only' }
  }
  get(date?: string, previousLadder?: PreviousLadder, refresh = false): Promise<MarketLadderData | null> {
    if (date === undefined) {
      const now = new Date(this.clock.now() + 8 * 3_600_000)
      if (now.getUTCHours() * 60 + now.getUTCMinutes() < 565) now.setUTCDate(now.getUTCDate() - 1)
      while ([0, 6].includes(now.getUTCDay())) now.setUTCDate(now.getUTCDate() - 1)
      date = now.toISOString().slice(0, 10)
    }
    if (!isMarketDate(date) || date > beijingMarketDate(this.clock.now())) throw new Error('涨停梯队日期无效')
    const target = date
    const confirmed = this.clock.now() >= Date.parse(`${target}T15:05:00+08:00`)
    const key = previousLadder ? `archive:${target}:${confirmed ? 'close' : 'live'}` : target
    return this.cache.get(key, async () => {
      const day = new Date(`${target}T00:00:00Z`)
      do { day.setUTCDate(day.getUTCDate() - 1) } while ([0, 6].includes(day.getUTCDay()))
      const previousDate = day.toISOString().slice(0, 10)
      let saved: MarketLadderData | null = null
      try {
        const archive = previousLadder?.(previousDate)
        if (archive?.date === previousDate && archive.method === LADDER_BOARD_TYPE_METHOD
          && archive.meta.cacheState !== 'unavailable' && archive.meta.cacheState !== 'stale'
          && Date.parse(archive.meta.fetchedAt) <= this.clock.now()
          && Date.parse(archive.meta.fetchedAt) >= Date.parse(`${previousDate}T15:05:00+08:00`)) saved = archive
      } catch { /* A local archive read failure can use the public pools. */ }
      const details = new Map<string, Pick<LimitUpStock, 'reason' | 'boardType'>>()
      try {
        const primary = await this.circuit.run('ths-limit-reason', () => this.ths(target, details, previousDate, saved, confirmed))
        if (primary !== undefined) return primary
      } catch { /* Transport or validation failures are counted by the source circuit. */ }
      return this.circuit.run('eastmoney-limit-up', () => this.eastmoney(target, details, saved, confirmed))
    }, refresh)
  }
  private meta(date: string, providerId: string, sourceName: string): MarketLadderData['meta'] {
    return { providerId, sourceName, sourceTimestamp: date, fetchedAt: isoNow(this.clock), cacheState: 'fresh' }
  }
  /** Parameters and fields follow dsh-plugin; all summaries come from the same pool scope. */
  private async ths(date: string, details: Map<string, Pick<LimitUpStock, 'reason' | 'boardType'>>, previousDate: string, saved: MarketLadderData | null, confirmed: boolean): Promise<MarketLadderData | undefined> {
    const { rows, summary } = await this.thsRows(date)
    let ambiguousBoards = false
    const stocks: LimitUpStock[] = rows.map(row => {
      const consecutive = typeof row.high_days === 'string' ? row.high_days.match(/^(\d+)天(\d+)板$/) : null
      const boards = thsBoards(row.high_days)
      if (!count(boards) || boards < 1 || boards > 100) {
        if (row.high_days == null || (consecutive && count(Number(consecutive[1])) && count(Number(consecutive[2]))
          && Number(consecutive[1]) > Number(consecutive[2]) && Number(consecutive[2]) >= 1)) ambiguousBoards = true
        else throw new Error('同花顺连续涨停字段无效')
      }
      return { code: String(row.code), name: String(row.name), boards, industry: '未分类', firstSeal: beijingTime(Number(row.first_limit_up_time)), lastSeal: beijingTime(Number(row.last_limit_up_time)),
        reason: typeof row.reason_type === 'string' && row.reason_type.trim() ? row.reason_type.trim() : null,
        boardType: limitBoardType(row.limit_up_type), breaks: count(row.open_num) ? Number(row.open_num) : null,
        turnover: typeof row.turnover_rate === 'number' && Number.isFinite(row.turnover_rate) && row.turnover_rate >= 0 ? row.turnover_rate : null }
    })
    const issues: string[] = []
    const today = object(summary?.today) ? summary.today : null
    const yesterday = object(summary?.yesterday) ? summary.yesterday : null
    if (today?.num !== stocks.length) throw new Error('同花顺涨停池汇总数量不一致')
    // A complete same-day batch can supply board types even when its N-day/M-board counts cannot build the ladder.
    for (const stock of stocks) details.set(stock.code, { reason: stock.reason, boardType: stock.boardType })
    // Missing or non-consecutive board counts still allow the same-day board labels to be reused.
    if (ambiguousBoards) return undefined
    const promotion = count(yesterday?.num) ? { eligible: Number(yesterday!.num), promoted: stocks.filter(row => row.boards > 1).length } : null
    if (promotion !== null && promotion.promoted > promotion.eligible) throw new Error('同花顺晋级样本不一致')
    const broken = count(today?.open_num) ? Number(today!.open_num) : null
    if (promotion === null) issues.push('昨日涨停样本缺失，晋级率不可用')
    if (broken === null) issues.push('炸板统计缺失，炸板率不可用')
    if (stocks.some(row => row.reason === null)) issues.push('部分涨停股缺少题材归因')
    const previous = await this.previousPerformance(date, previousDate, promotion?.eligible ?? null, saved)
    if (this.quotes && previous.performance === null) issues.push('昨日涨停今日表现获取失败')
    const missedPromotions = this.missed(previous.candidates, stocks, confirmed)
    let brokenStocks: MarketLadderData['brokenStocks'] = null
    try {
      const pool = broken === 0 ? new Map() : await this.brokenPool(date, new Set(details.keys()), broken)
      this.markBroken(missedPromotions, pool)
      brokenStocks = [...pool].map(([code, row]) => ({ code, name: row.name }))
    } catch { issues.push('炸板明细暂不可用') }
    return { method: LADDER_BOARD_TYPE_METHOD, yesterdayPerformance: previous.performance, missedPromotions, brokenStocks, date, stocks: this.sorted(stocks), promotion, broken, issues, meta: this.meta(date, 'ths-limit-reason', '同花顺涨停池') }
  }
  private async thsRows(date: string, endpoint: 'limit_up_pool' | 'open_limit_pool' = 'limit_up_pool') {
    const rows: Record<string, unknown>[] = []
    const codes = new Set<string>()
    let summary: Record<string, unknown> | null = null
    for (let page = 1; page <= 3; page++) {
      const params = new URLSearchParams({ page: String(page), limit: '200', field: '199112,10,9001,330323,330324,330325,9002,330329,133971,133970,1968584,3475914,9003,9004', filter: 'HS,GEM2STAR', order_field: '330324', order_type: '0', date: date.replaceAll('-', '') })
      const response = await fetchJson<unknown>(this.http, `https://data.10jqka.com.cn/dataapi/limit_up/${endpoint}?${params}`, { timeoutMs: this.timeoutMs, headers: { Referer: 'https://data.10jqka.com.cn/' } })
      const root = response.data
      if (!response.ok || !object(root) || root.status_code !== 0 || !object(root.data)) throw new Error('同花顺涨停池响应无效')
      const data = root.data
      if (String(data.date).replaceAll('-', '') !== date.replaceAll('-', '') || !Array.isArray(data.info) || !object(data.page) || !count(data.page.total)) throw new Error('同花顺涨停池日期或分页无效')
      if (page === 1 && object(data.limit_up_count)) summary = data.limit_up_count
      for (const row of data.info as unknown[]) {
        if (!object(row) || typeof row.code !== 'string' || !/^\d{6}$/.test(row.code) || codes.has(row.code) || typeof row.name !== 'string' || !row.name.trim()) throw new Error('同花顺涨停池股票无效')
        const first = Number(row.first_limit_up_time), last = Number(row.last_limit_up_time)
        if (endpoint === 'limit_up_pool' && ![first, last].every(time => Number.isFinite(time) && beijingMarketDate(time * 1000) === date)) throw new Error('同花顺封板日期不匹配')
        rows.push(row)
        codes.add(row.code)
      }
      if (rows.length === data.page.total) break
      if (data.info.length < 200 || page === 3) throw new Error('同花顺涨停池数量不完整')
    }
    if (endpoint === 'limit_up_pool' && (!object(summary?.today) || summary.today.num !== rows.length)) throw new Error('同花顺涨停池汇总数量不一致')
    return { rows, summary }
  }
  private async previousPerformance(date: string, previousDate: string, expectedSample: number | null, saved: MarketLadderData | null): Promise<PreviousResult> {
    if (this.quotes) {
      let result: PreviousResult | null = null
      try {
        result = await this.circuit.run('ths-limit-previous', async () => {
          const samples = saved?.meta.providerId === 'ths-limit-reason' && saved.stocks.length === expectedSample
            ? saved.stocks
            : (await this.thsRows(previousDate)).rows.map(row => ({
                code: String(row.code), name: String(row.name), boards: thsBoards(row.high_days), industry: '未分类',
              }))
          if (expectedSample !== null && samples.length !== expectedSample) throw new Error('昨日涨停样本数量不一致')
          return this.quotePrevious(date, samples, 'ths-limit-previous', '同花顺昨日涨停池').catch(() => ({
            performance: null, candidates: this.candidates(samples, []),
          }))
        })
      } catch { /* Try the date-scoped yesterday pool. */ }
      if (result?.performance && result.candidates) return result
      try {
        const fallback = await this.circuit.run('eastmoney-limit-previous', async () => {
          const rows = await this.pool('getYesterdayZTPool', date)
          if (expectedSample !== null && rows.length !== expectedSample) throw new Error('昨日涨停样本数量不一致')
          return this.eastmoneyPrevious(date, rows)
        })
        return { performance: result?.performance ?? fallback.performance, candidates: result?.candidates ?? fallback.candidates }
      } catch {
        if (result) return result
      }
    }
    return { performance: null, candidates: null }
  }
  private async quotePrevious(date: string, samples: PreviousSample[], providerId: string, sourceName: string): Promise<PreviousResult> {
    if (samples.length === 0) return { performance: summarizeYesterday([], this.meta(date, providerId, sourceName)), candidates: [] }
    const quote = await this.quotes!(samples.map(row => `${row.code.startsWith('6') ? '1' : '0'}.${row.code}`))
    const byCode = new Map(quote.quotes.map(row => [row.code, row]))
    const changes = samples.map(row => {
      const value = byCode.get(row.code)
      if (!value?.meta?.sourceTimestamp || marketDateFromMeta(value.meta) !== date || value.price === null || value.meta.cacheState === 'unavailable') return null
      if (this.clock.now() >= Date.parse(`${date}T15:05:00+08:00`) && Date.parse(value.meta.sourceTimestamp) < Date.parse(`${date}T15:00:00+08:00`)) return null
      return value.changePct
    })
    const meta = { ...quote.meta, providerId, sourceName: `${sourceName} / ${quote.meta.sourceName}` }
    return { performance: marketDateFromMeta(meta) === date ? summarizeYesterday(changes, meta) : null, candidates: this.candidates(samples, changes) }
  }
  private eastmoneyPrevious(date: string, rows: Record<string, unknown>[]): PreviousResult {
    const changes = rows.map(row => row.zdp)
    const samples = rows.map(row => ({
      code: String(row.c), name: typeof row.n === 'string' ? row.n : '', boards: typeof row.lbc === 'number' ? row.lbc : NaN,
      industry: typeof row.hybk === 'string' && row.hybk.trim() ? row.hybk : '未分类',
    }))
    return {
      performance: summarizeYesterday(changes, this.meta(date, 'eastmoney-limit-previous', '东方财富昨日涨停池（兜底）')),
      candidates: this.candidates(samples, changes),
    }
  }
  private candidates(samples: PreviousSample[], changes: unknown[]): LadderPromotionCandidate[] | null {
    if (samples.some(row => !row.name.trim() || !Number.isSafeInteger(row.boards) || row.boards < 1 || row.boards > 100)) return null
    return samples.map(({ code, name, boards, industry }, i) => {
      const change = changes[i]
      return { code, name, boards, industry, changePct: typeof change === 'number' && Number.isFinite(change) ? change : null }
    })
  }
  private missed(candidates: LadderPromotionCandidate[] | null, stocks: LimitUpStock[], confirmed: boolean): LadderMissedPromotions | null {
    if (candidates === null) return null
    const sealed = new Set(stocks.map(stock => stock.code))
    return { confirmed, stocks: candidates.filter(stock => !sealed.has(stock.code)).map(stock => ({ ...stock, broken: null })) }
  }
  private async brokenPool(date: string, sealed: ReadonlySet<string>, expected?: number | null) {
    type Timing = LadderPromotionCandidate['brokenTiming']
    try {
      return await this.circuit.run('ths-limit-broken', async () => {
        const { rows } = await this.thsRows(date, 'open_limit_pool')
        if ((expected != null && rows.length !== expected) || rows.some(row => sealed.has(String(row.code)))) {
          throw new Error('同花顺涨停与炸板池状态不一致')
        }
        return new Map<string, { name: string | null; timing: Timing }>(rows.map(row => {
          const first = Number(row.first_limit_up_time)
          const last = Number(row.last_limit_up_time)
          const valid = [first, last].every(time => Number.isSafeInteger(time) && time > 0 && time < 10_000_000_000 && beijingMarketDate(time * 1000) === date)
          return [String(row.code), { name: String(row.name), timing: valid && first <= last ? { firstTouch: beijingTime(first), lastTouch: beijingTime(last) } : undefined }]
        }))
      })
    } catch {
      return this.circuit.run('eastmoney-limit-broken', async () => {
        const rows = await this.pool('getTopicZBPool', date)
        if (rows.some(row => sealed.has(String(row.c)))) throw new Error('涨停与炸板池状态不一致')
        return new Map<string, { name: string | null; timing: Timing }>(rows.map(row => {
          let timing: Timing
          if (row.fbt != null && Number(row.fbt) > 0) {
            try { timing = { firstSeal: sealTime(row.fbt) } } catch { /* The pool still confirms membership. */ }
          }
          return [String(row.c), { name: typeof row.n === 'string' && row.n.trim() ? row.n : null, timing }]
        }))
      })
    }
  }
  private markBroken(missed: LadderMissedPromotions | null, rows: ReadonlyMap<string, { timing: LadderPromotionCandidate['brokenTiming'] }>): void {
    for (const stock of missed?.stocks ?? []) {
      stock.broken = rows.has(stock.code)
      const timing = rows.get(stock.code)?.timing
      if (timing) stock.brokenTiming = timing
    }
  }
  private sorted(stocks: LimitUpStock[]) {
    return stocks.sort((a, b) => b.boards - a.boards || a.firstSeal.localeCompare(b.firstSeal) || a.code.localeCompare(b.code))
  }
  private async eastmoney(date: string, details: Map<string, Pick<LimitUpStock, 'reason' | 'boardType'>>, saved: MarketLadderData | null, confirmed: boolean): Promise<MarketLadderData> {
    const archived = this.quotes && saved?.meta.providerId === 'eastmoney-limit-up' ? saved.stocks : null
    const currentPool = this.pool('getTopicZTPool', date)
    const [current, previous, broken, reasons] = await Promise.allSettled([
      currentPool,
      archived ? Promise.resolve(null) : this.circuit.run('eastmoney-limit-previous', () => this.pool('getYesterdayZTPool', date)),
      currentPool.then(rows => this.brokenPool(date, new Set(rows.map(row => String(row.c))))),
      currentPool.then(async rows => {
        const known = new Map([...details].flatMap(([code, row]) => row.reason === null ? [] : [[code, row.reason] as const]))
        if (rows.every(row => known.has(String(row.c)))) return known
        try {
          const extra = await this.hotReasons(date)
          for (const [code, reason] of extra) if (reason !== null && !known.has(code)) known.set(code, reason)
        } catch (error) {
          if (known.size === 0) throw error
        }
        return known
      }),
    ])
    if (current.status !== 'fulfilled') throw current.reason
    const stocks: LimitUpStock[] = current.value.map(row => {
      if (typeof row.n !== 'string' || !row.n.trim() || !count(row.lbc) || Number(row.lbc) < 1 || Number(row.lbc) > 100 || !count(row.zbc)) throw new Error('涨停梯队字段无效')
      return { code: String(row.c), name: row.n, boards: Number(row.lbc), industry: typeof row.hybk === 'string' && row.hybk.trim() ? row.hybk : '未分类',
        reason: reasons.status === 'fulfilled' ? reasons.value.get(String(row.c)) ?? null : null, boardType: details.get(String(row.c))?.boardType ?? null,
        firstSeal: sealTime(row.fbt), lastSeal: sealTime(row.lbt), breaks: Number(row.zbc),
        turnover: typeof row.hs === 'number' && Number.isFinite(row.hs) && row.hs >= 0 ? row.hs : null }
    })
    const issues: string[] = []
    if (stocks.some(stock => stock.reason === null)) issues.push('部分涨停股缺少题材归因')
    let promotion: MarketLadderData['promotion'] = null
    const previousRows = previous.status === 'fulfilled' ? previous.value : null
    const previousCodes = archived?.map(row => row.code) ?? previousRows?.map(row => String(row.c))
    if (previousCodes) {
      const codes = new Set(previousCodes)
      promotion = { eligible: codes.size, promoted: stocks.filter(row => codes.has(row.code)).length }
    } else issues.push('昨日涨停池获取失败，晋级率不可用')
    const brokenCount = broken.status === 'fulfilled' ? broken.value.size : null
    if (brokenCount === null) issues.push('炸板池获取失败或状态不一致，炸板率不可用')
    const sample = archived ? await this.quotePrevious(date, archived, 'eastmoney-limit-previous', '东方财富昨日涨停归档').catch(() => ({
      performance: null, candidates: this.candidates(archived, []),
    })) : previousRows ? this.eastmoneyPrevious(date, previousRows) : { performance: null, candidates: null }
    const yesterdayPerformance = sample.performance
    if (yesterdayPerformance === null) issues.push('昨日涨停今日表现获取失败')
    const missedPromotions = this.missed(sample.candidates, stocks, confirmed)
    if (broken.status === 'fulfilled' && brokenCount !== null) this.markBroken(missedPromotions, broken.value)
    const brokenStocks = broken.status === 'fulfilled' ? [...broken.value].map(([code, row]) => ({ code, name: row.name })) : null
    return { method: LADDER_BOARD_TYPE_METHOD, yesterdayPerformance, missedPromotions, brokenStocks, date, stocks: this.sorted(stocks), promotion, broken: brokenCount, issues, meta: this.meta(date, 'eastmoney-limit-up', '东方财富涨停池（兜底）') }
  }
  private hotReasons(date: string): Promise<Map<string, string | null>> {
    return this.circuit.run('ths-hot-reason', async () => {
      const response = await fetchJson<unknown>(this.http, `http://zx.10jqka.com.cn/event/api/getharden/date/${date}/orderby/date/orderway/desc/charset/GBK/`, { timeoutMs: this.timeoutMs, responseEncoding: 'gb18030', headers: { Referer: 'https://data.10jqka.com.cn/' } })
      const root = response.data
      if (!response.ok || !object(root) || root.errocode !== 0 || !Array.isArray(root.data)) throw new Error('热点归因响应无效')
      const found = new Map<string, string | null>()
      for (const row of root.data as unknown[]) {
        if (!object(row) || typeof row.code !== 'string' || !/^\d{6}$/.test(row.code) || row.date !== date) throw new Error('热点归因日期或股票无效')
        found.set(row.code, typeof row.reason === 'string' && row.reason.trim() ? row.reason.trim() : null)
      }
      return found
    })
  }
  private async pool(endpoint: string, date: string): Promise<Record<string, unknown>[]> {
    const params = new URLSearchParams({ ut: '7eea3edcaed734bea9cbfc24409ed989', dpt: 'wz.ztzt', Pageindex: '0', pagesize: '10000', sort: endpoint === 'getYesterdayZTPool' ? 'zs:desc' : 'fbt:asc', date: date.replaceAll('-', '') })
    const result = await fetchJson<unknown>(this.http, `https://push2ex.eastmoney.com/${endpoint}?${params}`, { timeoutMs: this.timeoutMs, headers: { Referer: 'https://quote.eastmoney.com/' } })
    const root = result.data
    if (!result.ok || !object(root) || root.rc !== 0 || !object(root.data)) throw new Error('涨停池请求失败')
    const data = root.data
    if (String(data.qdate) !== date.replaceAll('-', '') || !Array.isArray(data.pool) || data.pool.length !== data.tc) throw new Error('涨停池日期或数量不完整')
    const codes = new Set<string>()
    for (const row of data.pool) {
      if (!object(row) || typeof row.c !== 'string' || !/^\d{6}$/.test(row.c) || codes.has(row.c)) throw new Error('涨停池股票代码无效或重复')
      codes.add(row.c)
    }
    return data.pool as Record<string, unknown>[]
  }
}

export function summarizeYesterday(values: unknown[], meta: ProviderMeta): YesterdayLimitPerformance | null {
  if (!values.every((value): value is number => typeof value === 'number' && Number.isFinite(value))) return null
  const sorted = (values as number[]).slice().sort((a, b) => a - b)
  const n = sorted.length
  return { sample: n, average: n === 0 ? null : sorted.reduce((a, b) => a + b, 0) / n,
    median: n === 0 ? null : (sorted[Math.floor((n - 1) / 2)]! + sorted[Math.floor(n / 2)]!) / 2,
    up: sorted.filter(value => value > 0).length, down: sorted.filter(value => value < 0).length, flat: sorted.filter(value => value === 0).length, meta }
}
