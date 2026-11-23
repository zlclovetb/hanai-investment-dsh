import { lstatSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { leaderDecisionSchema, type LeaderCheckpoint, type LeaderDecision } from '../../contracts/src/leader-decision.ts'
import { beijingMarketDate, isMarketDate, marketDateFromMeta } from '../../contracts/src/market-history.ts'
import type { MarketLadderData } from '../../contracts/src/market-ladder.ts'
import type { HanaiDatabase } from '../../domain/src/database.ts'

const slots = [
  [565, 566, '09:25'], [600, 601, '10:00'], [689, 690, '11:30'], [840, 841, '14:00'], [900, 901, '15:00'],
] as const

export function getLeaderCheckpoints(database: HanaiDatabase, date: string): LeaderCheckpoint[] {
  const saved = database.getSetting('leader-evolution.checkpoints:' + date)
  if (!saved) return []
  try { return JSON.parse(saved) as LeaderCheckpoint[] } catch { return [] }
}

export function saveLeaderCheckpoint(database: HanaiDatabase, ladder: MarketLadderData, now: Date): void {
  const source = ladder.meta.sourceTimestamp
  const observedAt = source && !isMarketDate(source) ? source : ladder.meta.fetchedAt
  const stamp = Date.parse(observedAt)
  if (ladder.meta.cacheState !== 'fresh' || ladder.date !== beijingMarketDate(now.getTime())
      || marketDateFromMeta(ladder.meta) !== ladder.date || !Number.isFinite(stamp)
      || stamp > now.getTime() || now.getTime() - stamp > 120_000) return
  const minute = (Math.floor(stamp / 60_000) + 480) % 1440
  const slot = slots.find(([from, to]) => minute >= from && minute <= to)?.[2]
  if (!slot) return
  const saved = getLeaderCheckpoints(database, ladder.date)
  if (saved.some(checkpoint => checkpoint.slot === slot) || (saved.at(-1)?.slot ?? '') > slot) return
  const sealed = ladder.stocks.map(stock => stock.code)
  const resealed = ladder.stocks.filter(stock => (stock.breaks ?? 0) > 0).map(stock => stock.code)
  const broken = [...new Set([
    ...(ladder.brokenStocks?.map(stock => stock.code) ?? []),
    ...(ladder.missedPromotions?.stocks.filter(stock => stock.broken === true).map(stock => stock.code) ?? []),
  ])]
  const pending = ladder.missedPromotions?.confirmed === false ? ladder.missedPromotions.stocks.map(stock => stock.code) : []
  database.setSetting('leader-evolution.checkpoints:' + ladder.date, JSON.stringify([...saved, { slot, observedAt, sealed, resealed, broken, pending }]))
}

export function readLeaderDecisions(exportsDir: string, through: string, now: Date): { days: LeaderDecision[]; error?: string } {
  const folder = join(exportsDir, 'leader-evolution')
  try {
    if (!lstatSync(folder).isDirectory()) return { days: [], error: '收盘清算目录不可读。' }
    const dates = readdirSync(folder, { withFileTypes: true }).flatMap(entry => {
      const date = entry.name.slice(0, -5)
      return entry.isFile() && entry.name.endsWith('.json') && isMarketDate(date) && date <= through ? [date] : []
    }).sort().reverse()
    const days: LeaderDecision[] = []
    let rejected = 0
    for (const date of dates) {
      try {
        const path = join(folder, date + '.json')
        const file = lstatSync(path)
        if (!file.isFile() || file.size > 192_000) { rejected++; continue }
        const day = leaderDecisionSchema.parse(JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, '')))
        const time = Date.parse(day.asOf)
        if (day.date !== date || beijingMarketDate(time) !== date || time > now.getTime()
          || time < Date.parse(date + 'T15:00:00+08:00')) { rejected++; continue }
        days.push(day)
      } catch { rejected++ }
    }
    return { days, ...(rejected ? { error: `${rejected} 份清算记录未通过校验。` } : {}) }
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? { days: [] } : { days: [], error: '读取收盘清算失败。' }
  }
}
