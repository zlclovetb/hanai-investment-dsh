import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MarketMacroCapitalProvider, parseMacroCapital } from '../../src/providers/market-macro-capital.ts'
import { SourceCircuit } from '../../src/providers/source-circuit.ts'
import { FakeClock, HandlerHttpClient, jsonResponse } from '../helpers.ts'
import { isMarketPanelPayload } from '../../../contracts/src/market-history.ts'

const NOW = Date.parse('2026-10-28T10:00:00+08:00')
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(NOW) })
afterEach(() => vi.useRealTimers())

describe('SSE CSI300 tradable market cap', () => {
  it('reads the explicit tradable cap field in hundred million yuan and rejects wrong dates, duplicates and substituted fields', () => {
    const row = { MDATE: '20260901', CPT_NGT: '527896.32', CLS: '4611.44' }
    expect(parseMacroCapital({ result: [row] }, '202609')).toEqual([{ date: '2026-09-01', floatCap: 527896.32 }])
    expect(parseMacroCapital({ result: [] }, '202610')).toEqual([])
    for (const rows of [[{ ...row, MDATE: '20260931' }], [row, row], [{ ...row, CPT_NGT: undefined, calMkvSum: 500000 }], [{ ...row, CPT_NGT: '0' }]]) {
      expect(() => parseMacroCapital({ result: rows }, '202609')).toThrow()
    }
    expect(() => parseMacroCapital({ result: [row] }, '202608')).toThrow('日期')
    expect(() => parseMacroCapital({ result: [], error: 'rate limited' }, '202609')).toThrow()
  })

  it('persists bounded monthly progress without filling unpublished days, resumes, and rechecks recent months on a later manual call', async () => {
    const clock = new FakeClock(NOW)
    let fail = false
    const http = new HandlerHttpClient(url => {
      const month = new URL(url).searchParams.get('MDATE')!
      return fail ? jsonResponse({}, 503) : jsonResponse({ result: month === '202610' ? [] : [{ MDATE: `${month}01`, CPT_NGT: '500000' }] })
    })
    const provider = new MarketMacroCapitalProvider(http, clock, new SourceCircuit({ clock }))
    const first = (await provider.get(null))!
    expect(first.checkedMonths).toEqual(['202605', '202606', '202607', '202608', '202609', '202610'])
    expect(first.points).toHaveLength(5)
    expect(first.meta.sourceTimestamp).toBe('2026-09-01')
    expect(first.complete).toBe(false)
    expect(http.requests).toHaveLength(6)
    expect(isMarketPanelPayload('macro.capital', first)).toBe(true)
    expect(isMarketPanelPayload('macro.capital', { ...first, points: [{ date: '2026-10-01', floatCap: 0 }] })).toBe(false)
    expect(isMarketPanelPayload('macro.capital', { ...first, meta: { ...first.meta, sourceTimestamp: '2026-10-28' } })).toBe(false)
    const next = (await provider.get(first))!
    expect(next.checkedMonths).toHaveLength(12)
    expect(next.points).toHaveLength(11)
    expect(next.meta.sourceTimestamp).toBe('2026-09-01')
    const calls = http.requests.length
    await provider.get(first)
    expect(http.requests).toHaveLength(calls)
    clock.advance(6 * 3_600_000 + 1)
    const refreshed = (await provider.get(next))!
    expect(http.requests.slice(calls, calls + 2).map(request => new URL(request.url).searchParams.get('MDATE'))).toEqual(['202610', '202609'])
    fail = true
    clock.advance(60_001)
    const fallback = await provider.get(refreshed)
    expect(fallback?.points).toEqual(refreshed.points)
    expect(fallback?.meta).toMatchObject({ cacheState: 'stale', sourceTimestamp: refreshed.meta.sourceTimestamp, fetchedAt: refreshed.meta.fetchedAt })
  })
})
