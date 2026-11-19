// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useMarketSnapshot } from '../src/market-snapshot.tsx'
import type { HanaiClient } from '../src/api.ts'
import type { MarketSnapshot, MarketSnapshotResponse } from '../../contracts/src/market-snapshot.ts'

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-10T10:00:00+08:00')) })
afterEach(() => { cleanup(); vi.useRealTimers() })
const publication = (id: string): MarketSnapshot => {
  const meta = { providerId: 'test', sourceName: '测试源', sourceTimestamp: '2026-11-10', fetchedAt: new Date().toISOString(), cacheState: 'fresh' as const }
  return { id, startedAt: meta.fetchedAt, publishedAt: meta.fetchedAt, quotes: null, quoteCodes: [], errors: {},
    snapshot: { date: '2026-11-10', capturedAt: meta.fetchedAt, panels: ['breadth', 'ladder', 'distribution'], records: Object.fromEntries(['breadth', 'ladder', 'distribution'].map(key =>
      [key, { key, version: 1, capturedAt: meta.fetchedAt, meta, data: { id, meta } }])) } }
}
function fixture() {
  const first = publication('first')
  const call = vi.fn(async (): Promise<MarketSnapshotResponse> => ({ data: first, refreshAvailableAt: 0 }))
  const client = { call } as unknown as HanaiClient
  return { call, client, first, ...renderHook(({ historical }) => useMarketSnapshot(client, historical), { initialProps: { historical: false } }) }
}
it('reads only published envelopes and replaces every panel in a single state change', async () => {
  const f = fixture()
  await act(async () => {})
  const next = publication('next')
  f.call.mockResolvedValueOnce({ data: next, refreshAvailableAt: 0 })
  await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
  expect(f.result.current.data).toEqual(next)
  expect(f.call).toHaveBeenLastCalledWith('market.snapshot', { after: 'first' }, expect.any(AbortSignal))
  for (const panel of Object.values(f.result.current.data!.snapshot!.records)) expect(panel.data).toMatchObject({ id: 'next' })
})
it('keeps the entire previous round visible while a read is pending and ignores unchanged replies', async () => {
  const f = fixture()
  await act(async () => {})
  let resolve!: (value: MarketSnapshotResponse) => void
  f.call.mockImplementationOnce(() => new Promise(done => { resolve = done }))
  await act(async () => { await vi.advanceTimersByTimeAsync(15_000) })
  expect(f.call).toHaveBeenCalledTimes(2)
  expect(f.result.current.data).toEqual(f.first)
  await act(async () => resolve({ data: null, refreshAvailableAt: 0 }))
  expect(f.result.current.data).toEqual(f.first)
})
it('uses the Host cooldown for manual refresh without stopping publication reads', async () => {
  const f = fixture()
  await act(async () => {})
  f.call.mockResolvedValue({ data: f.first, refreshAvailableAt: Date.now() + 60_000 })
  await act(async () => { await f.result.current.refresh() })
  expect(f.result.current.cooldown).toBe(60)
  expect(f.call).toHaveBeenLastCalledWith('market.snapshot', { refresh: true }, expect.any(AbortSignal))
  await act(async () => { await vi.advanceTimersByTimeAsync(30_000) })
  expect(f.result.current.cooldown).toBe(30)
  expect(f.call).toHaveBeenCalledTimes(8)
})
it('aborts publication reads during explicit history and rejects their late results', async () => {
  const f = fixture()
  await act(async () => {})
  let resolve!: (value: MarketSnapshotResponse) => void
  f.call.mockImplementationOnce(() => new Promise(done => { resolve = done }))
  await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
  const signal = (f.call.mock.calls.at(-1) as unknown as [string, unknown, AbortSignal])[2]
  f.rerender({ historical: true })
  expect(signal.aborted).toBe(true)
  await act(async () => { resolve({ data: publication('late'), refreshAvailableAt: 0 }); await vi.advanceTimersByTimeAsync(30_000) })
  expect(f.result.current.data).toEqual(f.first)
  expect(f.call).toHaveBeenCalledTimes(2)
})
it('retains a cached envelope on page reopen and when the publication RPC fails', async () => {
  const f = fixture()
  await act(async () => {})
  f.unmount()
  f.call.mockRejectedValue(new Error('offline'))
  const again = renderHook(() => useMarketSnapshot(f.client, false))
  expect(again.result.current.data).toEqual(f.first)
  await act(async () => {})
  expect(again.result.current.error).toBe('offline')
  expect(again.result.current.data).toEqual(f.first)
})
it('applies a sector subscription as a complete returned round', async () => {
  const f = fixture()
  await act(async () => {})
  const next = publication('sector')
  await act(async () => {
    f.call.mockResolvedValueOnce({ data: next, refreshAvailableAt: 0 })
    await f.result.current.selectSector('BK0475')
  })
  expect(f.call).toHaveBeenLastCalledWith('market.snapshot', { after: 'first', sector: 'BK0475' }, expect.any(AbortSignal))
  expect(f.result.current.data).toEqual(next)
})
