import { z } from 'zod'
import { isMarketDate } from './market-history.ts'
import type { LeaderCheckpoint, LeaderDecision } from './leader-decision.ts'

export const cycleDateSchema = z.string().refine(isMarketDate, '无效交易日期')
const text = z.string().trim().min(1).max(240)
const stock = z.object({ code: z.string().regex(/^\d{6}$/), name: z.string().trim().min(1).max(60) }).strict()
export const cycleStages = ['试错', '启动', '主升', '高潮', '退潮', '待核实'] as const
export const cycleEvents = ['试错', '晋级', '总龙确立', '高度破局', '异动观察', '属性扩散', '分支接力', '后排接力', '高潮', '补涨负反馈', '总龙分歧', '退潮', '修复'] as const
const branch = z.object({
  name: text, leader: stock.nullable(), followers: z.array(stock).max(12), change: text,
}).strict()
const event = z.object({
  date: cycleDateSchema, kind: z.enum(cycleEvents), detail: text, stocks: z.array(stock).max(12),
  node: z.string().trim().min(1).max(120).nullable().optional(),
  evidence: z.array(z.string().min(1).max(80)).min(1).max(8),
}).strict()
const cycle = z.object({
  id: z.string().regex(/^[a-z0-9-]{1,60}$/), name: text, stage: z.enum(cycleStages),
  leader: stock.nullable(), branches: z.array(branch).max(10), events: z.array(event).max(32),
  takeaway: text, uncertainty: z.array(text).max(8),
}).strict()
export const cycleDraftSchema = z.object({
  date: cycleDateSchema, marketLeader: stock.nullable(), breakoutLeader: stock.nullable().optional(), cycles: z.array(cycle).max(6),
}).strict().superRefine((row, ctx) => {
  if (new Set(row.cycles.map(cycle => cycle.id)).size !== row.cycles.length) {
    ctx.addIssue({ code: 'custom', path: ['cycles'], message: '周期标识不可重复' })
  }
  for (const [index, item] of row.cycles.entries()) {
    if (item.events.some(event => event.date > row.date)) ctx.addIssue({ code: 'custom', path: ['cycles', index, 'events'], message: '周期事件不得超出复盘日期' })
  }
})
export type CycleDraft = z.infer<typeof cycleDraftSchema>
export const manualCycleSchema = z.object({
  recordedAt: z.iso.datetime({ offset: true }),
  result: cycleDraftSchema,
}).strict()
export interface CycleEvidence {
  id: string
  date: string
  label: string
  sourceName: string
  observedAt: string
  url?: string
}
export interface CycleReview {
  date: string
  status: 'preparing' | 'running' | 'draft' | 'confirmed' | 'failed'
  result: CycleDraft | null
  error: string | null
  updatedAt: string
  evidence: CycleEvidence[]
  origin?: 'user'
  model?: { provider: string; model: string }
}

export const cycleRequests = {
  'topic-cycle.view': z.object({ date: cycleDateSchema.optional() }).strict(),
  'topic-cycle.generate': z.object({ date: cycleDateSchema }).strict(),
  'topic-cycle.confirm': z.object({ draft: cycleDraftSchema }).strict(),
} as const

export interface CycleEndpoints {
  'topic-cycle.view': { request: { date?: string }; response: {
    selected: CycleReview | null; latestConfirmed: CycleReview | null; dates: string[]; latestClosingDate: string | null; canGenerate: boolean
    manualReview?: CycleReview
    decisions?: LeaderDecision[]; decisionError?: string
    stages?: Array<{ date: string; cycles: Array<Pick<CycleDraft['cycles'][number], 'id' | 'name' | 'stage'>> }>
    decisionEvidence?: Array<CycleEvidence & { reviewDate: string }>
    decisionFacts?: Array<{ reviewDate: string; id: string; data: unknown }>
    checkpoint?: LeaderCheckpoint
  } }
  'topic-cycle.generate': { request: { date: string }; response: CycleReview }
  'topic-cycle.confirm': { request: { draft: CycleDraft }; response: CycleReview }
}
