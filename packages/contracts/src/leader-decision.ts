import { z } from 'zod'
import { isMarketDate } from './market-history.ts'

export const decisionRoles = ['总龙候选', '次龙/卡位候选', '中军/容量', '补涨/跟风'] as const
export const decisionStates = ['DORMANT', 'IGNITION', 'MAIN_RALLY', 'DIFFUSION', 'DIVERGENCE', 'EBB'] as const
const text = z.string().min(1).max(500)
const refs = z.array(text).max(24)
const clause = z.object({ metric: text, op: z.enum(['==', '>', '>=', '<', '<=']), value: z.union([z.number(), z.boolean()]) })
const clauses = z.array(clause).min(1).max(12)
const rule = z.object({ label: text, all: clauses, action: z.enum(['撤销', '降级']) })
const candidate = z.object({
  code: z.string().regex(/^\d{6}$/), name: text, theme: text, role: z.enum(decisionRoles),
  weight: z.number().int().min(1).max(5), confidence: z.enum(['低', '中', '高']),
  falsifiers: z.array(rule).min(1).max(12),
})
const alerts = z.discriminatedUnion('level', [
  z.object({ level: z.literal('L2'), theme: text, code: text, reason: text, verifyNext: text, evidence: refs }),
  z.object({ level: z.literal('L3'), theme: text, code: text, reason: text, action: text, evidence: refs }),
])
const facts = z.record(z.string().max(60), z.object({
  value: z.union([z.number(), z.boolean()]), observedAt: z.iso.datetime({ offset: true }), evidence: refs.min(1),
}))
export const leaderDecisionSchema = z.object({
  date: z.string().refine(isMarketDate), asOf: z.iso.datetime({ offset: true }), mode: z.literal('close'),
  previousDate: z.string().refine(isMarketDate).nullable().optional(),
  candidates: z.array(candidate).max(100),
  observations: z.array(candidate.extend({ reason: text, admitWhen: clauses, verification: text })).max(100),
  journal: z.array(z.object({
    key: text, action: text, reason: text, previousConfidence: text.optional(), confidence: text.nullable().optional(),
    checks: z.array(z.object({ condition: text, result: text, evidence: refs, missing: refs })).max(12).optional(),
    metrics: facts.optional(), evidence: refs.optional(),
    weakToStrong: text.optional(), sealQuality: text.optional(),
  })).max(100),
  alerts: z.array(alerts).max(200),
  themes: z.record(z.string().min(1).max(240), z.object({
    state: z.enum(decisionStates), conclusion: text, rule: text.optional(), evidence: refs.min(1),
  })).optional(),
})
export type LeaderDecision = z.infer<typeof leaderDecisionSchema>

export interface LeaderCheckpoint {
  slot: string
  observedAt: string
  sealed: string[]
  resealed: string[]
  broken: string[]
  pending: string[]
}
