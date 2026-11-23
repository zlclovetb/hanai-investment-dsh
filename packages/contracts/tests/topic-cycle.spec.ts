import { describe, expect, it } from 'vitest'
import { cycleDraftSchema, type CycleDraft } from '../src/topic-cycle.ts'

const leader = { code: '002242', name: '九阳股份' }
const branchLeader = { code: '002724', name: '海洋王' }
const draft: CycleDraft = {
  date: '2026-11-04',
  marketLeader: leader,
  cycles: [{
    id: 'zodiac-goat', name: '羊字辈（样例）', stage: '高潮', leader,
    branches: [{ name: '洋字分支', leader: branchLeader, followers: [], change: '分支接力后出现负反馈' }],
    events: [
      { date: '2026-10-14', kind: '总龙确立', detail: '总龙持续抬高板位', stocks: [leader], evidence: ['day:2026-10-14'] },
      { date: '2026-10-23', kind: '分支接力', detail: '洋字分支出现接力', stocks: [branchLeader], evidence: ['day:2026-10-23'] },
      { date: '2026-11-04', kind: '补涨负反馈', detail: '后排转弱时总龙仍有承接', stocks: [leader, branchLeader], evidence: ['day:2026-11-04'] },
    ],
    takeaway: '确认分支负反馈是否传导到总龙',
    uncertainty: ['异动公告待核实'],
  }],
}

describe('topic cycle review', () => {
  it('preserves the market leader, branch leader and dated negative feedback separately', () => {
    expect(cycleDraftSchema.parse(draft)).toEqual(draft)
  })

  it('rejects events beyond the day being reviewed and repeated cycle identities', () => {
    const cycle = draft.cycles[0]!
    expect(cycleDraftSchema.safeParse({ ...draft, date: '2026-10-30' }).success).toBe(false)
    expect(cycleDraftSchema.safeParse({ ...draft, cycles: [cycle, cycle] }).success).toBe(false)
  })
})
