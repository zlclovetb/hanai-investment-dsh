import { lstatSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beijingMarketDate, isMarketDate } from '../../contracts/src/market-history.ts'
import { manualCycleSchema, type CycleReview } from '../../contracts/src/topic-cycle.ts'

export function readManualCycle(exportsDir: string, now: Date, selectedDate?: string, latestConfirmed?: string) {
  const directory = join(exportsDir, 'topic-cycle')
  const today = beijingMarketDate(now.getTime())
  try {
    if (!lstatSync(directory).isDirectory()) return { dates: [] }
    const dates = readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
      const date = entry.name.slice(0, -5)
      return entry.isFile() && entry.name.endsWith('.json') && isMarketDate(date) && date <= today ? [date] : []
    }).sort().reverse()
    const matching = selectedDate ? dates.filter(date => date === selectedDate) : dates.filter(date => date >= (latestConfirmed ?? ''))
    for (const date of matching) {
      try {
        const file = join(directory, date + '.json')
        const stat = lstatSync(file)
        if (!stat.isFile() || stat.size > 64_000) continue
        const { recordedAt, result } = manualCycleSchema.parse(JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, '')))
        const recordedDate = beijingMarketDate(Date.parse(recordedAt))
        if (result.date !== date || recordedDate < date || Date.parse(recordedAt) > now.getTime()) continue
        const references = new Set(result.cycles.flatMap(cycle => cycle.events.flatMap(event => event.evidence)))
        const review: CycleReview = {
          date, result, status: 'confirmed', origin: 'user', error: null, updatedAt: recordedAt,
          evidence: [...references].map(id => ({
            id, date: recordedDate, label: '用户提供的周期复盘',
            sourceName: '人工补录', observedAt: recordedAt,
          })),
        }
        return { dates, review }
      } catch { /* Other saved dates can still be displayed. */ }
    }
    return { dates }
  } catch {
    return { dates: [] }
  }
}
