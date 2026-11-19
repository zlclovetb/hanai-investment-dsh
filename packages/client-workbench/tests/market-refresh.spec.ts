import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { isClosingPanelCurrent } from '../../contracts/src/market-snapshot.ts'
import type { ProviderMeta } from '../../contracts/src/index.ts'

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-05T10:00:00+08:00')) })
afterEach(() => vi.useRealTimers())

const meta: ProviderMeta = { providerId: 'tencent', sourceName: '腾讯', fetchedAt: '2026-11-05T09:59:50+08:00', sourceTimestamp: '2026-11-05T09:59:50+08:00', cacheState: 'fresh' }

it('reuses a confirmed closing archive outside the polling window', () => {
  vi.setSystemTime(new Date('2026-11-05T18:00:00+08:00'))
  expect(isClosingPanelCurrent({ ...meta, sourceTimestamp: '2026-11-05T15:00:00+08:00', fetchedAt: '2026-11-05T15:06:00+08:00' })).toBe(true)
  expect(isClosingPanelCurrent(meta)).toBe(false)
})

it('accepts source-confirmed closing time even when the cache is marked stale', () => {
  vi.setSystemTime(new Date('2026-11-05T18:00:00+08:00'))
  expect(isClosingPanelCurrent({ ...meta, cacheState: 'stale', sourceTimestamp: '2026-11-05T15:00:00+08:00', fetchedAt: '2026-11-05T15:06:00+08:00' })).toBe(true)
})
