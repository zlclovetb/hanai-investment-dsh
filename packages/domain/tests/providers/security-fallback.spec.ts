import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MarketDataService } from '../../src/providers/index.ts'
import { SinaProvider } from '../../src/providers/sina.ts'
import { FakeClock, HandlerHttpClient, jsonResponse } from '../helpers.ts'

const NOW = Date.parse('2026-10-26T10:00:00+08:00')
const rows = Array.from({ length: 1001 }, (_, index) => {
  const symbol = index === 0 ? 'bj920000' : index === 1 ? 'sz000001' : `sh${600000 + index}`
  return { symbol, code: symbol.slice(2), name: index === 2 ? '*ST测试' : `证券${index}`, trade: '0.000' }
})
const securities = rows.map(row => ({ code: row.code, name: row.name, market: row.symbol.startsWith('sh') ? 1 : 0 }))

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
})
afterEach(() => vi.useRealTimers())

function sinaHttp(mode: 'complete' | 'truncated' | 'duplicate' | 'invalid' | 'no-count') {
  return new HandlerHttpClient(url => {
    if (url.includes('getHQNodeStockCount')) return jsonResponse(mode === 'no-count' ? [] : String(rows.length))
    const page = Number(new URL(url).searchParams.get('page'))
    if (mode === 'truncated' && page === 2) return jsonResponse([])
    const offset = mode === 'duplicate' ? 0 : (page - 1) * 100
    return jsonResponse(rows.slice(offset, offset + 100).map(row => mode === 'invalid' ? { ...row, code: 'bad' } : row))
  })
}

describe('security master fallback', () => {
  it('paginates the full Sina list including Beijing, ST and suspended securities without requiring prices', async () => {
    const http = sinaHttp('complete')
    const clock = new FakeClock(NOW)
    const result = await new SinaProvider(http, clock).getAllSecurities()
    expect(result).toEqual(securities)
    expect(result[0]).toEqual({ market: 0, code: '920000', name: '证券0' })
    expect(http.requests).toHaveLength(12)
    expect(clock.sleeps).toEqual(Array(10).fill(120))
    expect(http.requests.slice(1).every(({ url }) => new URL(url).searchParams.get('sort') === 'symbol')).toBe(true)
  })

  it.each(['truncated', 'duplicate', 'invalid', 'no-count'] as const)('rejects a %s snapshot', async mode => {
    await expect(new SinaProvider(sinaHttp(mode), new FakeClock(NOW)).getAllSecurities()).rejects.toThrow('主数据')
  })

  it('uses Sina first and falls back to Eastmoney when Sina fails', async () => {
    const service = new MarketDataService({ http: sinaHttp('complete'), clock: new FakeClock(NOW) })
    const primary = vi.spyOn(service.sina, 'getAllSecurities').mockResolvedValue(securities)
    const fallback = vi.spyOn(service.eastmoney, 'getAllSecurities').mockResolvedValue(securities)
    expect(await service.getAllSecurities()).toEqual(securities)
    expect(fallback).not.toHaveBeenCalled()
    primary.mockRejectedValue(new Error('offline'))
    expect(await service.getAllSecurities()).toEqual(securities)
    expect(fallback).toHaveBeenCalledTimes(1)
  })

  it('counts empty, partial and duplicate lists as failures, skips a source after three failures and recovers after five minutes', async () => {
    const clock = new FakeClock(NOW)
    const service = new MarketDataService({ clock })
    const primary = vi.spyOn(service.sina, 'getAllSecurities')
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce(securities.slice(0, 999))
      .mockResolvedValueOnce(Array(1001).fill(securities[0]))
      .mockResolvedValue(securities)
    const fallback = vi.spyOn(service.eastmoney, 'getAllSecurities').mockResolvedValue(securities)
    vi.spyOn(service.sina, 'getSectorStocks').mockResolvedValue(null)
    for (let attempt = 0; attempt < 4; attempt += 1) {
      expect(await service.getAllSecurities()).toEqual(securities)
      await service.getSectorStocks('SINA:new_x')
    }
    expect(primary).toHaveBeenCalledTimes(3)
    expect(fallback).toHaveBeenCalledTimes(4)
    clock.advance(5 * 60_000)
    expect(await service.getAllSecurities()).toEqual(securities)
    expect(primary).toHaveBeenCalledTimes(4)
    expect(fallback).toHaveBeenCalledTimes(4)
  })

  it('resets consecutive failures after a complete snapshot succeeds', async () => {
    const service = new MarketDataService({ clock: new FakeClock(NOW) })
    const primary = vi.spyOn(service.sina, 'getAllSecurities')
      .mockResolvedValueOnce([]).mockResolvedValueOnce([])
      .mockResolvedValueOnce(securities)
      .mockResolvedValueOnce([]).mockResolvedValueOnce([])
      .mockResolvedValue(securities)
    vi.spyOn(service.eastmoney, 'getAllSecurities').mockResolvedValue(securities)
    for (let attempt = 0; attempt < 6; attempt += 1) expect(await service.getAllSecurities()).toEqual(securities)
    expect(primary).toHaveBeenCalledTimes(6)
  })

  it('also opens the Eastmoney circuit when both sources fail and returns no replacement snapshot', async () => {
    const service = new MarketDataService({ clock: new FakeClock(NOW) })
    const primary = vi.spyOn(service.sina, 'getAllSecurities').mockRejectedValue(new Error('offline'))
    const fallback = vi.spyOn(service.eastmoney, 'getAllSecurities').mockResolvedValue([])
    for (let attempt = 0; attempt < 4; attempt += 1) expect(await service.getAllSecurities()).toEqual([])
    expect(primary).toHaveBeenCalledTimes(3)
    expect(fallback).toHaveBeenCalledTimes(3)
  })
})
