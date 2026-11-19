import { useEffect, useRef, useState } from 'react'
import type { MarketSnapshot } from '../../contracts/src/market-snapshot.ts'
import type { HanaiClient } from './api.ts'

const cached = new WeakMap<HanaiClient, MarketSnapshot>()

/** Poll publications only. Acquisition and manual cooldown belong to the Host. */
export function useMarketSnapshot(client: HanaiClient, historical: boolean) {
  const [data, setData] = useState<MarketSnapshot | null>(() => cached.get(client) ?? null)
  const [loading, setLoading] = useState(!data)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [availableAt, setAvailableAt] = useState(0)
  const [now, setNow] = useState(Date.now())
  const reader = useRef<((refresh?: boolean, sector?: string) => Promise<MarketSnapshot | null>) | null>(null)
  useEffect(() => {
    if (historical) { reader.current = null; return }
    const controller = new AbortController()
    let pending: Promise<MarketSnapshot | null> | null = null
    const fetch = async (refresh: boolean, sector?: string): Promise<MarketSnapshot | null> => {
      if (refresh) setRefreshing(true)
      try {
        const current = cached.get(client)
        const response = await client.call('market.snapshot', {
          ...(refresh ? { refresh: true } : current ? { after: current.id } : {}),
          ...(sector ? { sector } : {}),
        }, controller.signal)
        if (controller.signal.aborted) return null
        if (response.data) { cached.set(client, response.data); setData(response.data) }
        setAvailableAt(response.refreshAvailableAt)
        setNow(Date.now())
        setError(null)
        return response.data ?? current ?? null
      } catch (cause) {
        if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : String(cause))
        return null
      } finally {
        pending = null
        if (!controller.signal.aborted) { setLoading(false); setRefreshing(false) }
      }
    }
    const read = (refresh = false, sector?: string): Promise<MarketSnapshot | null> => {
      if (controller.signal.aborted) return Promise.resolve(null)
      if (pending) return refresh || sector ? pending.then(() => read(refresh, sector)) : pending
      pending = Promise.resolve().then(() => fetch(refresh, sector))
      return pending
    }
    reader.current = read
    void read()
    const timer = window.setInterval(() => { void read() }, 5000)
    return () => { controller.abort(); window.clearInterval(timer); reader.current = null }
  }, [client, historical])
  useEffect(() => {
    if (availableAt <= Date.now()) return
    const timer = window.setInterval(() => {
      setNow(Date.now())
      if (Date.now() >= availableAt) window.clearInterval(timer)
    }, 1000)
    return () => window.clearInterval(timer)
  }, [availableAt])
  const cooldown = Math.max(0, Math.ceil((availableAt - now) / 1000))
  return { data, loading: !historical && loading, refreshing, error, cooldown,
    refresh: () => reader.current?.(true) ?? Promise.resolve(null),
    selectSector: (sector: string) => reader.current?.(false, sector) ?? Promise.resolve(null) }
}
