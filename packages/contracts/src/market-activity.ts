import type { ProviderMeta, TrendPoint } from './index.ts'
import { beijingMarketDate } from './market-history.ts'

// Tencent labels an in-progress minute by its end.
export function isTencentMinuteEnd(providerId: string, sourceTime: number, referenceTime: number): boolean {
  return providerId === 'tencent' && sourceTime > referenceTime && sourceTime - referenceTime <= 60_000
    && beijingMarketDate(sourceTime) === beijingMarketDate(referenceTime)
}

export interface MarketIntradayData {
  date: string
  points: TrendPoint[]
  prevClose: number | null
  meta: ProviderMeta
}

export interface MarketSectorSignal {
  time: string
  name: string
  code: string
  title: string
  direction: 'up' | 'down'
}

export interface MarketSignalsData {
  method?: 'ths-sector-events-v2'
  date: string
  signals: MarketSectorSignal[]
  meta: ProviderMeta
}
