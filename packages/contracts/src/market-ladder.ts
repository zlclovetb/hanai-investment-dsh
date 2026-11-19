import type { ProviderMeta } from './index.ts'

export const LADDER_BOARD_TYPE_METHOD = 'source-board-types-v1' as const
export function limitBoardType(value: unknown): '一字板' | 'T字板' | '换手板' | null {
  const label = typeof value === 'string' ? value.trim().replace(/^t/, 'T') : ''
  return label === '一字板' || label === 'T字板' || label === '换手板' ? label : null
}

export interface LimitUpStock {
  code: string
  name: string
  boards: number
  industry: string
  reason: string | null
  boardType: string | null
  firstSeal: string
  lastSeal: string
  breaks: number | null
  turnover: number | null
}

export interface YesterdayLimitPerformance {
  sample: number
  average: number | null
  median: number | null
  up: number
  down: number
  flat: number
  meta: ProviderMeta
}

export interface LadderPromotionCandidate {
  code: string
  name: string
  boards: number
  industry: string
  changePct: number | null
  broken?: boolean | null
  brokenTiming?: { firstTouch: string; lastTouch: string } | { firstSeal: string }
}

export interface LadderMissedPromotions {
  confirmed: boolean
  stocks: LadderPromotionCandidate[]
}

export type PreviousLadder = (date: string) => MarketLadderData | null

export interface MarketLadderData {
  /** Complete same-day open-limit pool; absent/null means membership is unknown. */
  brokenStocks?: Array<{ code: string; name: string | null }> | null
  missedPromotions?: LadderMissedPromotions | null
  yesterdayPerformance?: YesterdayLimitPerformance | null
  method?: typeof LADDER_BOARD_TYPE_METHOD
  date: string
  stocks: LimitUpStock[]
  /** Last known reasons for stocks temporarily outside this trade date's limit-up pool. */
  topicReasons?: Record<string, string>
  /** Stocks last classified as 换手板 while outside this trade date's limit-up pool. */
  turnoverBoards?: string[]
  promotion: { eligible: number; promoted: number } | null
  broken: number | null
  issues: string[]
  meta: ProviderMeta
}

export function ladderThemes(data: MarketLadderData) {
  const groups = new Map<string, LimitUpStock[]>()
  for (const stock of data.stocks) {
    for (const tag of new Set((stock.reason ?? '').split(/[+＋]/).map(tag => tag.trim()).filter(Boolean))) {
      const stocks = groups.get(tag)
      if (stocks) stocks.push(stock)
      else groups.set(tag, [stock])
    }
  }
  return [...groups].map(([name, stocks]) => ({ name, count: stocks.length, height: Math.max(...stocks.map(row => row.boards)), stocks }))
    .sort((a, b) => b.count - a.count || b.height - a.height || a.name.localeCompare(b.name, 'zh-CN'))
}
