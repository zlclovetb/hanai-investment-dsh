import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { StockQuote } from '../../contracts/src/index.ts'
import type { SessionFacade } from '../src/service.ts'
import type { MarketLadderData } from '../../contracts/src/market-ladder.ts'
import type { CycleDraft } from '../../contracts/src/topic-cycle.ts'
import { HanaiDatabase } from '../../domain/src/database.ts'
import { MarketHistoryStore } from '../../domain/src/market-history.ts'
import { ensureHanaiLayout, resolveHanaiPaths } from '../../domain/src/paths.ts'
import { TechnicalHistoryStore } from '../../domain/src/technical-history.ts'
import { TopicCycle } from '../src/topic-cycle.ts'
import { saveLeaderCheckpoint } from '../src/leader-decision.ts'

const resources: Array<() => void> = []
const date = '2026-11-18'
const nextDate = '2026-11-19'
const leader = { code: '002242', name: '九阳股份' }
const breakout = { code: '600825', name: '新华传媒' }
const draftFor = (day: string): CycleDraft => ({
  date: day,
  marketLeader: leader,
  cycles: [{
    id: 'yang', name: '羊字辈', stage: '主升', leader, branches: [],
    events: [{ date: day, kind: '晋级', stocks: [leader], detail: '样本高标晋级', evidence: ['ladder:' + day] }],
    takeaway: '次日看分支是否跟随', uncertainty: ['缺监管公告依据'],
  }],
})

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date(date + 'T16:09:00+08:00')) })
afterEach(() => { for (const release of resources.splice(0)) release(); vi.useRealTimers() })

function fixture() {
  const paths = resolveHanaiPaths(mkdtempSync(join(tmpdir(), 'hanai-topic-cycle-')))
  ensureHanaiLayout(paths)
  const database = new HanaiDatabase(paths.databasePath)
  const history = new MarketHistoryStore(database.sqlite)
  new TechnicalHistoryStore(database.sqlite)
  let sessionsCreated = 0
  const sessions = {
    create: vi.fn<SessionFacade['create']>(async () => 'cycle-session-' + ++sessionsCreated),
    listModels: vi.fn<SessionFacade['listModels']>(async provider => provider === 'openai-codex' ? ['test-codex'] : []),
    prompt: vi.fn(async (_sessionId: string, _text: string) => {}),
    archive: vi.fn(async () => {}),
    isRunning: vi.fn(async () => false),
  }
  const getQuotes = vi.fn(async (_ids: readonly string[]) => {
    const meta: MarketLadderData['meta'] = { providerId: 'fixture', sourceName: '样本报价',
      sourceTimestamp: nextDate + 'T15:00:00+08:00', fetchedAt: nextDate + 'T16:10:00+08:00', cacheState: 'fresh' }
    const quote: StockQuote = {
      ...leader, secId: '0.' + leader.code, price: 8, change: -1, changePct: -11.1, amount: null, volume: null, turnoverRate: null,
      marketCap: null, floatCap: null, pe: null, pb: null, high: null, low: null, open: null, prevClose: null, meta,
    }
    return { quotes: [quote], meta }
  })
  const makeCycle = () => new TopicCycle(database, paths, history, {
    localCalendar: () => [date, nextDate],
  }, sessions, {
    currentSelection: () => ({ provider: 'test', model: 'test' }), saveSelection: async () => {},
  }, getQuotes)
  let cycle = makeCycle()
  resources.push(() => { cycle.dispose(); database.close(); rmSync(paths.root, { recursive: true, force: true }) })
  const restart = () => { cycle.dispose(); cycle = makeCycle(); return cycle }
  const save = (day: string, time = '15:15:00', fetchDate = day) => {
    const timeStamp = fetchDate + 'T' + time + '+08:00'
    const meta: MarketLadderData['meta'] = { providerId: 'fixture', sourceName: '样本梯队', sourceTimestamp: day, fetchedAt: timeStamp, cacheState: 'fresh' }
    const ladder: MarketLadderData = {
      date: day, stocks: [{ ...leader, boards: 3, industry: '家电', reason: '样本', boardType: '换手板', firstSeal: '10:00:00', lastSeal: '10:00:00', breaks: 0, turnover: 5 }],
      promotion: null, broken: null, issues: [], meta,
    }
    ladder.stocks.push({ ...ladder.stocks[0]!, ...breakout, boards: 5 })
    history.save('ladder', ladder, meta, day)
  }
  const reply = (data: CycleDraft, index = 1, finish = true) => {
    const id = 'cycle-session-' + index
    cycle.observe(id, {
      type: 'assistant/message', data: { message: { content: [{ type: 'text', text: JSON.stringify(data) }] } },
    } as unknown as SessionEvent)
    if (finish) cycle.observe(id, { type: 'turn/end', data: { reason: { kind: 'completed' } } } as SessionEvent)
  }
  return { cycle, sessions, save, reply, restart, getQuotes, database, paths }
}

it('reads a dated manual review independently of drafts and keeps it out of earlier dates', () => {
  const { cycle, paths } = fixture()
  const folder = join(paths.exportsDir, 'topic-cycle')
  mkdirSync(folder)
  const recordedAt = date + 'T16:30:00+08:00'
  const result = { ...draftFor(date), breakoutLeader: breakout }
  writeFileSync(join(folder, date + '.json'), JSON.stringify({ recordedAt, result }))
  expect(cycle.view().manualReview).toBeUndefined()
  vi.setSystemTime(new Date(recordedAt))
  expect(cycle.view()).toMatchObject({
    selected: null, latestConfirmed: null,
    manualReview: { origin: 'user', date, result, evidence: [{ label: '用户提供的周期复盘', observedAt: recordedAt }] },
  })
  expect(cycle.view(date).manualReview?.result).toEqual(result)
  expect(cycle.view('2026-11-17').manualReview).toBeUndefined()
  expect(cycle.trackedCodes()).toEqual([leader.code, breakout.code])
})

function modelError(code: string, message = code): SessionEvent {
  return { type: 'turn/end', data: { reason: { kind: 'error', error: { code, message } } } } as SessionEvent
}

it('selects Codex without looking up DeepSeek when the global default is another model', async () => {
  const { cycle, sessions, save, reply } = fixture()
  save(date)
  vi.setSystemTime(new Date(date + 'T16:10:00+08:00'))
  await cycle.generate(date)
  reply(draftFor(date))
  expect(sessions.listModels.mock.calls).toEqual([['openai-codex']])
  expect(sessions.create).toHaveBeenCalledWith(expect.stringMatching(/-codex$/), expect.any(String),
    { provider: 'openai-codex', model: 'test-codex' }, { rememberModel: false })
  expect(sessions.prompt).toHaveBeenCalledOnce()
  expect(cycle.view(date).selected).toMatchObject({ status: 'draft', model: { provider: 'openai-codex', model: 'test-codex' } })
})

it.each([
  ['ACCOUNT_QUOTA', 'ACCOUNT_QUOTA'],
  ['CODEX_REQUEST', 'HTTP 401 token_revoked'],
  ['CODEX_REQUEST', 'You have hit your ChatGPT usage limit (plus). Try again soon.'],
  ['CODEX_REQUEST', 'Codex SSE response headers timed out after 15000ms'],
  ['CODEX_REQUEST', 'Service Unavailable'],
  ['UNKNOWN', 'No Codex account offers the selected model'],
])('falls back once to the exact Flash ID after a terminal %s', async (code, message) => {
  const { cycle, sessions, save, reply } = fixture()
  save(date)
  vi.setSystemTime(new Date(date + 'T16:10:00+08:00'))
  sessions.listModels.mockImplementation(async provider => provider === 'openai-codex'
    ? ['test-codex'] : ['deepseek-v4-pro', 'deepseek-flash'])
  await cycle.generate(date)
  cycle.observe('cycle-session-1', modelError(code, message))
  cycle.observe('cycle-session-1', modelError(code, message))
  await vi.advanceTimersByTimeAsync(0)
  expect(sessions.prompt).toHaveBeenCalledTimes(2)
  expect(sessions.prompt.mock.calls[1]?.[1]).toBe(sessions.prompt.mock.calls[0]?.[1])
  expect(sessions.create).toHaveBeenLastCalledWith(expect.stringMatching(/-flash$/), expect.any(String),
    { provider: 'modlens-deepseek-account', model: 'deepseek-flash' }, { rememberModel: false })
  reply(draftFor(date), 2)
  expect(cycle.view(date).selected).toMatchObject({ status: 'draft', model: { model: 'deepseek-flash' } })
})

it('fails without sending a prompt when Codex is missing and DeepSeek only advertises Pro', async () => {
  const { cycle, sessions, save } = fixture()
  save(date)
  vi.setSystemTime(new Date(date + 'T16:10:00+08:00'))
  sessions.listModels.mockImplementation(async provider => provider === 'openai-codex' ? [] : ['deepseek-v4-pro'])
  expect(await cycle.generate(date)).toMatchObject({ status: 'failed', error: expect.stringContaining('deepseek-flash') })
  expect(sessions.create).not.toHaveBeenCalled()
  expect(sessions.prompt).not.toHaveBeenCalled()
})

it('uses only Flash when Codex session preflight rejects its credentials', async () => {
  const { cycle, sessions, save } = fixture()
  save(date)
  vi.setSystemTime(new Date(date + 'T16:10:00+08:00'))
  sessions.listModels.mockImplementation(async provider => provider === 'openai-codex' ? ['test-codex'] : ['deepseek-flash'])
  sessions.create.mockRejectedValueOnce(Object.assign(new Error('Codex credentials unavailable'), { code: 'AUTH' }))
  expect(await cycle.generate(date)).toMatchObject({ status: 'running', model: { model: 'deepseek-flash' } })
  expect(sessions.create).toHaveBeenCalledTimes(2)
  expect(sessions.prompt).toHaveBeenCalledOnce()
})

it('keeps Flash running when a startup recovery check finishes for the old Codex session', async () => {
  const { cycle, sessions, save } = fixture()
  save(date)
  vi.setSystemTime(new Date(date + 'T16:10:00+08:00'))
  sessions.listModels.mockImplementation(async provider => provider === 'openai-codex' ? ['test-codex'] : ['deepseek-flash'])
  await cycle.generate(date)
  const idle = Promise.withResolvers<boolean>()
  sessions.isRunning.mockReturnValueOnce(idle.promise)
  const recovery = cycle.recover()
  cycle.observe('cycle-session-1', modelError('AUTH'))
  await vi.advanceTimersByTimeAsync(0)
  idle.resolve(false)
  await recovery
  expect(await cycle.generate(date)).toMatchObject({ status: 'running', model: { model: 'deepseek-flash' } })
  expect(sessions.prompt).toHaveBeenCalledTimes(2)
})

it('does not reroute Codex failures unrelated to availability', async () => {
  const { cycle, sessions, save } = fixture()
  save(date)
  vi.setSystemTime(new Date(date + 'T16:10:00+08:00'))
  await cycle.generate(date)
  cycle.observe('cycle-session-1', modelError('CONTEXT_WINDOW_EXCEEDED'))
  await vi.advanceTimersByTimeAsync(0)
  expect(cycle.view(date).selected?.status).toBe('failed')
  expect(sessions.listModels.mock.calls).toEqual([['openai-codex']])
  expect(sessions.prompt).toHaveBeenCalledOnce()
})

it('reads published close reports with their frozen evidence and excludes future reports from history', async () => {
  const { cycle, paths, save, reply } = fixture()
  vi.setSystemTime(new Date(nextDate + 'T16:10:00+08:00'))
  save(date)
  await cycle.generate(date)
  reply(draftFor(date))
  cycle.confirm(draftFor(date))
  const folder = join(paths.exportsDir, 'leader-evolution')
  mkdirSync(folder)
  const record = {
    date, asOf: date + 'T15:30:00+08:00', mode: 'close', candidates: [], observations: [], journal: [], alerts: [],
    themes: { 羊字辈: { state: 'MAIN_RALLY', conclusion: '继续验证分支承接', evidence: ['ladder:' + date] } },
  }
  writeFileSync(join(folder, date + '.json'), JSON.stringify(record))
  writeFileSync(join(folder, nextDate + '.json'), JSON.stringify({ ...record, date: nextDate, asOf: nextDate + 'T16:00:00+08:00' }))
  writeFileSync(join(folder, '2026-11-17.json'), JSON.stringify({ ...record, date: '2026-11-17', mode: 'intraday' }))
  const historical = cycle.view(date)
  expect(historical.decisions?.map(day => day.date)).toEqual([date])
  expect(historical.decisionError).toContain('1 份')
  expect(historical.stages).toEqual([{ date, cycles: [{ id: 'yang', name: '羊字辈', stage: '主升' }] }])
  expect(historical.decisionFacts).toEqual([expect.objectContaining({ reviewDate: date, id: 'ladder:' + date })])
  expect(cycle.view().decisions?.map(day => day.date)).toEqual([nextDate, date])
})

it('captures only the first timely observation at a checkpoint and keeps history read-only', () => {
  const { cycle, database } = fixture()
  vi.setSystemTime(new Date(date + 'T10:01:10+08:00'))
  const ladder: MarketLadderData = {
    date, stocks: [], brokenStocks: [leader], broken: 1, promotion: null, issues: [],
    meta: { providerId: 'fixture', sourceName: '样本', sourceTimestamp: date, fetchedAt: date + 'T10:00:15+08:00', cacheState: 'fresh' },
  }
  saveLeaderCheckpoint(database, ladder, new Date())
  saveLeaderCheckpoint(database, { ...ladder, brokenStocks: [breakout] }, new Date())
  vi.setSystemTime(new Date(date + 'T14:15:00+08:00'))
  saveLeaderCheckpoint(database, { ...ladder, meta: { ...ladder.meta, fetchedAt: date + 'T14:00:30+08:00' } }, new Date())
  expect(cycle.view().checkpoint).toMatchObject({ slot: '10:00', observedAt: ladder.meta.fetchedAt, broken: [leader.code] })
  expect(cycle.view(date).checkpoint).toBeUndefined()
})

it('requires a verified close for a manual draft, deduplicates requests and requires explicit confirmation', async () => {
  const { cycle, sessions, save, reply } = fixture()
  await expect(cycle.generate(date)).rejects.toThrow('尚未到复盘时间')
  vi.setSystemTime(new Date(date + 'T16:10:00+08:00'))
  save(date, '14:50:00')
  await expect(cycle.generate(date)).rejects.toThrow('没有可核实的收盘')
  expect(sessions.prompt).not.toHaveBeenCalled()
  save(date)
  await Promise.all([cycle.generate(date), cycle.generate(date)])
  expect(sessions.prompt).toHaveBeenCalledTimes(1)
  expect(sessions.prompt.mock.calls[0]?.[1]).toContain('ladder:' + date)
  expect(sessions.prompt.mock.calls[0]?.[1]).toContain('"node"')
  const draft = { ...draftFor(date), breakoutLeader: breakout }
  const event = draft.cycles[0]!.events[0]!
  event.kind = '高度破局'
  event.stocks = [breakout]
  event.node = '打开连板空间，跟踪是否形成接力'
  reply(draft)
  expect(cycle.view().selected).toMatchObject({ status: 'draft', result: draft })
  expect(cycle.view().latestConfirmed).toBeNull()
  const edited = { ...draft, marketLeader: { code: '999999', name: '未核实股票' } }
  expect(() => cycle.confirm(edited)).toThrow('冻结行情外')
  expect(() => cycle.confirm({ ...draft, marketLeader: { ...leader, name: '虚构简称' } })).toThrow('简称')
  expect(() => cycle.confirm({ ...draft, breakoutLeader: { ...breakout, code: '999999' } })).toThrow('冻结行情外')
  expect(cycle.confirm(draft)).toMatchObject({ status: 'confirmed', result: draft })
  expect(cycle.view().latestConfirmed?.result).toEqual(draft)
  expect(cycle.trackedCodes()).toEqual([leader.code, breakout.code])
})

it('does not treat a later backfill as evidence known on the historical review day', async () => {
  const { cycle, sessions, save } = fixture()
  vi.setSystemTime(new Date(nextDate + 'T20:00:00+08:00'))
  save(date, '15:15:00', nextDate)
  await expect(cycle.generate(date)).rejects.toThrow('截至该日末')
  expect(sessions.prompt).not.toHaveBeenCalled()
})

it('restores a previously rejected climax event as an unconfirmed draft without prompting again', async () => {
  const { cycle, sessions, save, reply, restart, database } = fixture()
  save(date)
  vi.setSystemTime(new Date(date + 'T16:10:00+08:00'))
  await cycle.generate(date)
  const draft = draftFor(date)
  draft.cycles[0]!.stage = '高潮'
  draft.cycles[0]!.events[0]!.kind = '高潮'
  reply(draft, 1, false)
  database.sqlite.prepare("UPDATE topic_cycle_daily SET status = 'failed', error = ? WHERE date = ?")
    .run('复盘草稿校验失败：事件类型不支持高潮', date)

  const recovered = restart()
  await recovered.recover()
  expect(recovered.view(date).selected).toMatchObject({ status: 'draft', result: draft, error: null })
  expect(recovered.view(date).latestConfirmed).toBeNull()
  await recovered.recover()
  expect(sessions.prompt).toHaveBeenCalledTimes(1)
})

it('recovers a saved response without another model call and rejects later evidence in a historical event', async () => {
  const { cycle, sessions, save, reply, restart, getQuotes } = fixture()
  save(date)
  vi.setSystemTime(new Date(date + 'T16:10:00+08:00'))
  await Promise.all([cycle.generate(date), cycle.generate(date)])
  expect(sessions.prompt).toHaveBeenCalledTimes(1)
  const draft = draftFor(date)
  reply(draft, 1, false)
  const recovered = restart()
  await recovered.recover()
  expect(recovered.view().selected?.status).toBe('draft')
  expect(sessions.prompt).toHaveBeenCalledTimes(1)
  recovered.confirm(draft)
  expect(recovered.trackedCodes()).toEqual([leader.code])

  vi.setSystemTime(new Date(nextDate + 'T16:10:00+08:00'))
  save(nextDate)
  await recovered.generate(nextDate)
  expect(getQuotes).toHaveBeenCalledExactlyOnceWith(['0.' + leader.code])
  expect(sessions.prompt.mock.calls[1]?.[1]).toContain('quote:' + leader.code + ':' + nextDate)
  const next = draftFor(nextDate)
  const event = next.cycles[0]!.events[0]!
  event.date = date
  reply(next, 2)
  expect(recovered.view().selected).toMatchObject({ status: 'failed', error: expect.stringContaining('晚于该事件') })
  await recovered.recover()
  expect(recovered.view().selected).toMatchObject({ status: 'failed', error: expect.stringContaining('晚于该事件') })
  expect(recovered.view().latestConfirmed?.date).toBe(date)
  expect(recovered.view(date).selected?.result).toEqual(draft)
})
