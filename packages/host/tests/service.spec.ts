import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SessionSeq, type SessionEvent } from '@deepseek-ai/dsh-session'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DashboardData, DefaultModelSelection, ProviderMeta, StockDetail } from '../../contracts/src/index.ts'
import { MARKET_HISTORY_PANELS, marketHistoryPanel } from '../../contracts/src/market-history.ts'
import { HanaiDatabase } from '../../domain/src/database.ts'
import { ensureHanaiLayout, resolveHanaiPaths } from '../../domain/src/paths.ts'
import { ReportStore } from '../../domain/src/reports.ts'
import { ExpertChatStore } from '../../domain/src/expert-chats.ts'
import {
  HanaiService,
  type DefaultModelFacade,
  type MarketFacade,
  type SessionFacade,
} from '../src/service.ts'

const roots: string[] = []
const assets = resolve(dirname(fileURLToPath(import.meta.url)), '../../masters/assets')

afterEach(() => {
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

class FakeSessions implements SessionFacade {
  prompts: Array<{ sessionId: string; text: string }> = []
  archived: string[] = []
  running = false

  async create(judgementId: string): Promise<string> { return `hanai-${judgementId}` }
  async archive(sessionId: string): Promise<void> { this.archived.push(sessionId) }
  async prompt(sessionId: string, text: string): Promise<void> { this.prompts.push({ sessionId, text }) }
  async isRunning(): Promise<boolean> { return this.running }
}

class FakeDefaultModel implements DefaultModelFacade {
  selection: DefaultModelSelection = {
    provider: 'deepseek-official',
    model: 'deepseek-v4-pro',
    reasoningEffort: 'high',
  }

  currentSelection() { return { ...this.selection } }

  async saveSelection(next: Parameters<DefaultModelFacade['saveSelection']>[0]): Promise<void> {
    this.selection = {
      provider: next.provider,
      model: next.model,
      ...(next.reasoningEffort === undefined ? {} : { reasoningEffort: next.reasoningEffort }),
    }
  }
}

function stockDetail(): StockDetail {
  return {
    security: { secId: '1.600519', code: '600519', name: '贵州茅台', exchange: 'SH', pinyinFull: 'guizhoumaotai', pinyinInitial: 'gzmt' },
    quote: null, metrics: null, trend: [], trendPrevClose: null,
    daily: [], weekly: [], monthly: [], valuation: null,
    sources: { quote: null, metrics: null, trend: null, daily: null, weekly: null, monthly: null, valuation: null },
  }
}

function fixture(minChars = 100) {
  const root = mkdtempSync(join(tmpdir(), 'hanai-dsh-service-'))
  roots.push(root)
  const paths = resolveHanaiPaths(root)
  ensureHanaiLayout(paths)
  const database = new HanaiDatabase(paths.databasePath)
  const sessions = new FakeSessions()
  const defaultModel = new FakeDefaultModel()
  const meta = {
    providerId: 'fake', sourceName: 'fake', sourceTimestamp: null,
    fetchedAt: new Date(0).toISOString(), cacheState: 'fresh' as const,
  }
  const market: MarketFacade = {
    getDashboard: async () => { throw new Error('unused') },
    getMarketBreadth: async () => null,
    getSectorStocks: async () => ({ stocks: [], meta }),
    getStockDetail: async () => stockDetail(),
    getStockQuoteMetrics: async () => ({
      quote: null,
      metrics: null,
      sources: { quote: null, metrics: null },
    }),
    getTrend: async () => ({ trend: [], trendPrevClose: null, meta: null }),
    getKline: async (_secId, period) => ({ period, bars: [], meta: null, hasMore: period === 'daily' }),
    getValuation: async () => ({ valuation: null, meta: null }),
    getQuotes: async () => ({ quotes: [], meta }),
    clearMarketCache: () => 0,
    getSourceDiagnostics: () => [],
    syncSecurities: async () => ({ count: 0, updatedAt: null }),
    searchSecurities: async () => [],
  }
  const reports = new ReportStore(paths, assets, minChars)
  const expertChats = new ExpertChatStore(paths, assets)
  const openDirectory = vi.fn(async (_directory: string): Promise<void> => {})
  const service = new HanaiService({
    paths, database, reports, expertChats, sessions, defaultModel, market, version: 'test', openDirectory,
  })
  return { database, defaultModel, expertChats, market, openDirectory, paths, reports, service, sessions }
}

function completed(turn = 1): SessionEvent {
  return { type: 'turn/end', seq: SessionSeq(turn), time: Date.now(), data: { turn, reason: { kind: 'completed' } } }
}

async function eventually(assertion: () => void): Promise<void> {
  let last: unknown
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try { assertion(); return } catch (error) { last = error }
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw last
}

describe('HanaiService report lifecycle', () => {
  it('never rebinds undated boards, ranks or sector caches to a different market day', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-27T10:00:00+08:00'))
    const { database, market, service } = fixture()
    const quoteMeta: ProviderMeta = { providerId: 'tencent', sourceName: '腾讯', sourceTimestamp: '2026-10-26T15:00:00+08:00', fetchedAt: new Date().toISOString(), cacheState: 'stale' }
    const boardMeta: ProviderMeta = { providerId: 'sina', sourceName: '新浪', sourceTimestamp: null, fetchedAt: new Date().toISOString(), cacheState: 'fresh' }
    const data: DashboardData = {
      overview: { indices: [{ code: '000001', name: '上证', price: 100, change: 0, changePct: 0, amount: 10, upCount: null, downCount: null, flatCount: null }],
        breadth: { up: null, down: null, flat: null, limitUp: null, limitDown: null, totalAmount: null }, meta: quoteMeta, marketStatus: 'trading' },
      industry: { type: 'industry', sectors: [], meta: boardMeta }, concept: { type: 'concept', sectors: [], meta: boardMeta },
      ranks: { gainers: [], losers: [], amount: [], turnover: [] },
      rankSources: { gainers: boardMeta, losers: boardMeta, amount: boardMeta, turnover: boardMeta },
    }
    vi.spyOn(market, 'getDashboard').mockImplementation(async () => data)
    vi.spyOn(market, 'getSectorStocks').mockResolvedValue({ stocks: [], meta: boardMeta })
    const signal = new AbortController().signal
    try {
      await service.call('dashboard.get', {}, signal)
      await service.call('sector.stocks', { sectorCode: 'SINA:new_blhy' }, signal)
      expect((await service.call('market.history.get', { date: '2026-10-26' }, signal))?.panels).toEqual(['overview'])
      expect(await service.call('market.history.get', { date: '2026-10-27' }, signal)).toBeNull()
      quoteMeta.sourceTimestamp = '2026-10-27T09:25:00+08:00'
      quoteMeta.cacheState = 'fresh'
      boardMeta.cacheState = 'cached'
      for (const fetchedAt of ['2026-10-26T23:59:59+08:00', '2026-10-27T09:24:59+08:00']) {
        boardMeta.fetchedAt = fetchedAt
        await service.call('dashboard.get', {}, signal)
        await service.call('sector.stocks', { sectorCode: 'SINA:new_blhy' }, signal)
        expect((await service.call('market.history.get', { date: '2026-10-27' }, signal))?.panels).toEqual(['overview'])
      }
      boardMeta.cacheState = 'fresh'
      boardMeta.fetchedAt = new Date().toISOString()
      await service.call('dashboard.get', {}, signal)
      await service.call('sector.stocks', { sectorCode: 'SINA:new_blhy' }, signal)
      const saved = await service.call('market.history.get', { date: '2026-10-27' }, signal)
      expect(saved?.panels).toEqual(expect.arrayContaining(['industry', 'concept', 'rank.gainers', 'rank.losers', 'rank.amount', 'rank.turnover', 'sector:SINA:new_blhy']))
      quoteMeta.cacheState = 'unavailable'
      data.overview.indices = []
      vi.advanceTimersByTime(60_000)
      boardMeta.fetchedAt = new Date().toISOString()
      await service.call('dashboard.get', {}, signal)
      await service.call('sector.stocks', { sectorCode: 'SINA:new_blhy' }, signal)
      expect(await service.call('market.history.get', { date: '2026-10-27' }, signal)).toEqual(saved)
    } finally { database.close(); vi.useRealTimers() }
  })

  it('archives all market panels on ordinary reads, preserving source dates, independent breadth and sector drills', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-26T16:00:00+08:00'))
    const { database, market, service } = fixture()
    const meta: ProviderMeta = { providerId: 'fake', sourceName: '测试', sourceTimestamp: '2026-10-26T15:00:00+08:00', fetchedAt: new Date().toISOString(), cacheState: 'stale' }
    const summaryMeta = { ...meta, sourceTimestamp: null, cacheState: 'fresh' as const }
    const data: DashboardData = {
      overview: { indices: [{ code: '000001', name: '上证指数', price: 3500, change: 0, changePct: 0, amount: 100, upCount: null, downCount: null, flatCount: null }],
        breadth: { up: null, down: null, flat: null, limitUp: null, limitDown: null, totalAmount: 100 }, meta, marketStatus: 'closed' },
      industry: { type: 'industry', sectors: [], meta: summaryMeta }, concept: { type: 'concept', sectors: [], meta: summaryMeta },
      ranks: { gainers: [], losers: [], amount: [], turnover: [] },
      rankSources: { gainers: summaryMeta, losers: summaryMeta, amount: summaryMeta, turnover: summaryMeta },
    }
    const width = { up: 100, down: 200, flat: 3, limitUp: 4, limitDown: 5, qdate: '2026-10-26', meta }
    const dashboardRead = vi.spyOn(market, 'getDashboard').mockResolvedValue(data)
    const breadthRead = vi.spyOn(market, 'getMarketBreadth').mockResolvedValue(width)
    const sectorRead = vi.spyOn(market, 'getSectorStocks').mockResolvedValue({ stocks: [], meta: summaryMeta })
    const signal = new AbortController().signal
    try {
      await service.call('market.breadth', {}, signal)
      await service.call('dashboard.get', { refresh: false }, signal)
      await service.call('sector.stocks', { sectorCode: 'SINA:new_blhy' }, signal)
      const snapshot = await service.call('market.history.get', { date: '2026-10-26' }, signal)
      expect(snapshot?.panels).toEqual(expect.arrayContaining([...MARKET_HISTORY_PANELS, 'sector:SINA:new_blhy']))
      expect(marketHistoryPanel(snapshot, 'overview')).toMatchObject({ indices: [{ ...data.overview.indices[0], meta }], meta })
      expect(marketHistoryPanel(snapshot, 'breadth')).toEqual(width)
      expect(marketHistoryPanel(snapshot, 'industry')).toEqual(data.industry)
      expect(await service.call('market.history.get', { date: '2026-10-27' }, signal)).toBeNull()
      await service.call('cache.clear', { scope: 'market' }, signal)
      expect(await service.call('market.history.list', {}, signal)).toMatchObject({ snapshots: [{ date: '2026-10-26' }] })
      expect(await service.call('market.history.get', { date: '2026-10-26' }, signal)).toEqual(snapshot)
      expect(dashboardRead).toHaveBeenCalledTimes(1)
      expect(breadthRead).toHaveBeenCalledTimes(1)
      expect(sectorRead).toHaveBeenCalledTimes(1)
      vi.advanceTimersByTime(60_000)
      const failed = { ...meta, cacheState: 'unavailable' as const, fetchedAt: new Date().toISOString() }
      dashboardRead.mockResolvedValue({ ...data, overview: { ...data.overview, indices: [], meta: failed },
        industry: { ...data.industry, meta: failed }, concept: { ...data.concept, meta: failed },
        rankSources: { gainers: failed, losers: failed, amount: failed, turnover: failed } })
      await service.call('dashboard.get', { refresh: true }, signal)
      expect(await service.call('market.history.get', { date: '2026-10-26' }, signal)).toEqual(snapshot)
    } finally { database.close(); vi.useRealTimers() }
  })

  it('serves independent breadth without running the dashboard and preserves both source records', async () => {
    const { database, market, service } = fixture()
    const quoteMeta: ProviderMeta = { providerId: 'tencent', sourceName: '腾讯行情', sourceTimestamp: null,
      fetchedAt: '2026-10-27T06:40:00.000Z', cacheState: 'fresh' }
    const width = { up: 100, down: 200, flat: 3, limitUp: 4, limitDown: 5, qdate: '2026-10-27',
      meta: { ...quoteMeta, providerId: 'legu-breadth', sourceName: '乐咕乐股（AKShare 同源）' } }
    database.setSetting('market.latestSuccess.sources', JSON.stringify([quoteMeta]))
    const dashboard = vi.spyOn(market, 'getDashboard')
    vi.spyOn(market, 'getMarketBreadth').mockResolvedValue(width)
    try {
      expect(await service.call('market.breadth', {}, new AbortController().signal)).toEqual(width)
      expect(dashboard).not.toHaveBeenCalled()
      const diagnostics = await service.call('diagnostics.get', {}, new AbortController().signal)
      expect(diagnostics.marketSources).toEqual([quoteMeta, width.meta])
      expect(diagnostics.latestMarketSuccess).toBe(width.meta.fetchedAt)
    } finally { database.close() }
  })

  it('creates a stock-independent expert chat, tracks DSH turns, and removes its workspace safely', async () => {
    const { database, paths, service, sessions } = fixture()
    const created = await service.call('expert-chat.create', {
      masterId: 'sun-yuchen-perspective',
      openingMessage: '“永远缺存储”要看哪些供需信号？',
    }, new AbortController().signal)

    expect(created).toMatchObject({
      masterId: 'sun-yuchen-perspective',
      masterName: '孙宇晨',
      title: '“永远缺存储”要看哪些供需信号？',
      turnStatus: 'queued',
    })
    expect(created.dshSessionId).toBe(`hanai-chat-${created.id}`)
    expect(sessions.prompts).toEqual([{
      sessionId: created.dshSessionId,
      text: '“永远缺存储”要看哪些供需信号？',
    }])
    const workspace = join(paths.expertChatsDir, created.id, 'workspace')
    expect(existsSync(join(workspace, '.agents', 'skills', 'sun-yuchen-perspective', 'SKILL.md'))).toBe(true)
    expect(existsSync(join(workspace, 'REPORT.md'))).toBe(false)
    expect(readFileSync(join(workspace, 'AGENTS.md'), 'utf8')).toContain('专家开放对谈工作区')

    service.handleSessionEvent(created.dshSessionId!, {
      type: 'turn/start', seq: SessionSeq(1), time: Date.now(), data: { turn: 1 },
    })
    expect(database.getExpertChat(created.id)?.turnStatus).toBe('running')
    service.handleSessionEvent(created.dshSessionId!, completed())
    expect(database.getExpertChat(created.id)).toMatchObject({
      turnStatus: 'idle', errorCode: null, errorMessage: null,
    })

    await expect(service.call('expert-chat.remove', {
      id: created.id,
    }, new AbortController().signal)).resolves.toEqual([])
    expect(sessions.archived).toEqual([created.dshSessionId])
    expect(database.getExpertChat(created.id)).toBeNull()
    expect(existsSync(join(paths.expertChatsDir, created.id))).toBe(false)
    database.close()
  })

  it('creates a blank expert chat without injecting a synthetic user message', async () => {
    const { database, service, sessions } = fixture()
    const created = await service.call('expert-chat.create', {
      masterId: 'munger-perspective',
    }, new AbortController().signal)

    expect(created).toMatchObject({ title: '与查理·芒格开放对谈', turnStatus: 'idle' })
    expect(sessions.prompts).toEqual([])
    database.close()
  })

  it('enforces chat-only expert capability at the Host boundary', async () => {
    const { database, market, service } = fixture()
    const stockLookup = vi.spyOn(market, 'getStockDetail')
    await expect(service.call('judgement.create', {
      secId: '1.600519', masterId: 'sun-yuchen-perspective',
    }, new AbortController().signal)).rejects.toThrow('仅支持开放对谈')
    expect(stockLookup).not.toHaveBeenCalled()
    expect(database.listJudgements()).toEqual([])
    database.close()
  })

  it('starts Sanhu Yi in both research and open-chat modes with its own complete Skill snapshot', async () => {
    const { database, paths, service, sessions } = fixture()
    const signal = new AbortController().signal
    const masterId = 'sanhu-yi-perspective'
    const judgement = await service.call('judgement.create', {
      secId: '1.600519', masterId,
    }, signal)
    const chat = await service.call('expert-chat.create', { masterId }, signal)

    expect(judgement).toMatchObject({ masterId, masterName: '散户乙', reportStatus: 'generating' })
    expect(chat).toMatchObject({ masterId, masterName: '散户乙', turnStatus: 'idle' })
    expect(chat.dshSessionId).not.toBe(judgement.dshSessionId)
    expect(sessions.prompts).toHaveLength(1)
    expect(sessions.prompts[0]!.sessionId).toBe(judgement.dshSessionId)
    for (const workspace of [
      join(paths.judgementsDir, judgement.id, 'workspace'),
      join(paths.expertChatsDir, chat.id, 'workspace'),
    ]) {
      const skillRoot = join(workspace, '.agents', 'skills', masterId)
      expect(readFileSync(join(skillRoot, 'SKILL.md'), 'utf8')).toContain('name: sanhu-yi-perspective')
      expect(readFileSync(join(skillRoot, 'references', 'provenance.md'), 'utf8')).toContain('493')
      expect(readFileSync(join(skillRoot, 'references', 'valuation-worked-example.md'), 'utf8')).toContain('ROE')
    }
    const chatWorkspace = join(paths.expertChatsDir, chat.id, 'workspace')
    expect(readFileSync(join(chatWorkspace, 'AGENTS.md'), 'utf8')).toContain('不代表散户乙本人观点')
    expect(existsSync(join(chatWorkspace, 'REPORT.md'))).toBe(false)
    database.close()
  })

  it('runs Dong Taishan in both modes and seals the research report without leaking it into open chat', async () => {
    const { database, paths, reports, service, sessions } = fixture()
    const signal = new AbortController().signal
    const masterId = 'dong-taishan-perspective'
    const openingMessage = '估值便宜和产业拐点怎样分开判断？'
    const judgement = await service.call('judgement.create', { secId: '1.600519', masterId }, signal)
    const chat = await service.call('expert-chat.create', { masterId, openingMessage }, signal)

    expect(judgement).toMatchObject({ masterId, masterName: '东泰山', masterVersion: '2026.10.01-v6', reportStatus: 'generating' })
    expect(chat).toMatchObject({ masterId, masterName: '东泰山', masterVersion: '2026.10.01-v6', turnStatus: 'queued' })
    expect(chat.dshSessionId).not.toBe(judgement.dshSessionId)
    expect(sessions.prompts).toEqual([
      { sessionId: judgement.dshSessionId, text: expect.stringContaining('以东泰山大师的方法论') },
      { sessionId: chat.dshSessionId, text: openingMessage },
    ])
    for (const workspace of [
      join(paths.judgementsDir, judgement.id, 'workspace'),
      join(paths.expertChatsDir, chat.id, 'workspace'),
    ]) {
      const skillRoot = join(workspace, '.agents', 'skills', masterId)
      expect(readFileSync(join(skillRoot, 'SKILL.md'), 'utf8')).toContain('name: dong-taishan-perspective')
      expect(readFileSync(join(skillRoot, 'references', 'source-manifest.md'), 'utf8')).toContain('P22')
    }
    const chatWorkspace = join(paths.expertChatsDir, chat.id, 'workspace')
    expect(readFileSync(join(chatWorkspace, 'AGENTS.md'), 'utf8')).toContain('不代表本人当前观点')
    const report = `# 东泰山研判\n\n${'估值位置与产业位置分别判断，盈利质量需核验，列出反证与下一次验证条件。'.repeat(8)}`
    writeFileSync(reports.workingReportPath(judgement.id), report)
    service.handleSessionEvent(judgement.dshSessionId!, completed())
    service.handleSessionEvent(chat.dshSessionId!, completed())
    await eventually(() => expect(database.getJudgement(judgement.id)?.reportStatus).toBe('ready'))
    expect(database.listReportRows(judgement.id)).toHaveLength(1)
    expect(database.getExpertChat(chat.id)?.turnStatus).toBe('idle')
    expect(existsSync(join(chatWorkspace, 'REPORT.md'))).toBe(false)
    database.close()
  })

  it('deletes only a settled judgement, archives its session, and removes local report files', async () => {
    const { database, paths, service, sessions } = fixture()
    const created = await service.call('judgement.create', {
      secId: '1.600519', masterId: 'munger-perspective',
    }, new AbortController().signal)
    const judgementDirectory = join(paths.judgementsDir, created.id)
    expect(existsSync(judgementDirectory)).toBe(true)

    await expect(service.call(
      'judgement.remove',
      { id: created.id },
      new AbortController().signal,
    )).rejects.toThrow('仍在进行中')
    expect(database.getJudgement(created.id)).not.toBeNull()
    expect(sessions.archived).toEqual([])

    database.updateJudgement(created.id, { reportStatus: 'failed', turnStatus: 'failed' })
    await expect(service.call(
      'judgement.remove',
      { id: created.id },
      new AbortController().signal,
    )).resolves.toEqual([])
    expect(sessions.archived).toEqual([created.dshSessionId])
    expect(database.getJudgement(created.id)).toBeNull()
    expect(existsSync(judgementDirectory)).toBe(false)
    database.close()
  })

  it('creates one persistent DSH session, seals report v1, and keeps ordinary chat out of report versions', async () => {
    const { database, reports, service, sessions } = fixture()
    const created = await service.call('judgement.create', {
      secId: '1.600519', masterId: 'munger-perspective', prompt: '重点检查永久损失风险',
    }, new AbortController().signal)
    expect(created.dshSessionId).toBe(`hanai-${created.id}`)
    expect(sessions.prompts).toHaveLength(1)
    expect(sessions.prompts[0]?.text).toContain('永久损失风险')
    expect(sessions.prompts[0]?.text).toContain('主动联网检索公司公告、财报、监管披露')
    expect(sessions.prompts[0]?.text).toContain('不要向用户提问，也不要等待用户补充材料')
    expect(sessions.prompts[0]?.text).toContain('关键事实注明来源链接和日期')
    expect(sessions.prompts[0]?.text).toContain('严禁编造数据、来源或引文')
    expect(sessions.prompts[0]?.text).toContain('证据不足时明确标记不确定性')
    expect(sessions.prompts[0]?.text).toContain('只用一句话向用户确认报告已经完成')
    expect(sessions.prompts[0]?.text).toContain('不要在回复中重复整份报告')
    writeFileSync(reports.workingReportPath(created.id), `# 正式研判\n\n${'事实、推断、风险与验证条件。'.repeat(20)}`)
    service.handleSessionEvent(created.dshSessionId!, completed())
    await eventually(() => expect(database.getJudgement(created.id)?.reportStatus).toBe('ready'))
    expect(database.listReportRows(created.id)).toHaveLength(1)

    service.handleSessionEvent(created.dshSessionId!, {
      type: 'turn/start', seq: SessionSeq(2), time: Date.now(), data: { turn: 2 },
    })
    service.handleSessionEvent(created.dshSessionId!, completed(2))
    expect(database.getJudgement(created.id)?.turnStatus).toBe('idle')
    expect(database.listReportRows(created.id)).toHaveLength(1)
    database.close()
  })

  it('uses exactly one automatic repair turn before sealing a valid report', async () => {
    const { database, reports, service, sessions } = fixture(180)
    const created = await service.call('judgement.create', {
      secId: '1.600519', masterId: 'warren-buffett-perspective',
    }, new AbortController().signal)
    writeFileSync(reports.workingReportPath(created.id), '# 太短')
    service.handleSessionEvent(created.dshSessionId!, completed())
    await eventually(() => expect(database.getJudgement(created.id)?.reportStatus).toBe('repairing'))
    expect(database.getRepairAttempts(created.id)).toBe(1)
    expect(sessions.prompts).toHaveLength(2)
    expect(sessions.prompts[1]?.text).toContain('唯一一次自动修复机会')

    writeFileSync(reports.workingReportPath(created.id), `# 修复后的正式报告\n\n${'所有者收益、安全边际、反方证据与验证条件。'.repeat(20)}`)
    service.handleSessionEvent(created.dshSessionId!, completed(2))
    await eventually(() => expect(database.getJudgement(created.id)?.reportStatus).toBe('ready'))
    expect(database.listReportRows(created.id)).toHaveLength(1)
    expect(database.getRepairAttempts(created.id)).toBe(0)

    await service.call('judgement.revise', {
      id: created.id,
      instruction: '补充最新估值与反方证据',
    }, new AbortController().signal)
    expect(database.getRepairAttempts(created.id)).toBe(0)
    writeFileSync(reports.workingReportPath(created.id), '# 第二版仍然太短')
    service.handleSessionEvent(created.dshSessionId!, completed(3))
    await eventually(() => expect(database.getJudgement(created.id)?.reportStatus).toBe('repairing'))
    expect(database.getRepairAttempts(created.id)).toBe(1)

    writeFileSync(reports.workingReportPath(created.id), `# 修复后的第二版报告\n\n${'估值、反方证据、风险与验证条件。'.repeat(20)}`)
    service.handleSessionEvent(created.dshSessionId!, completed(4))
    await eventually(() => expect(database.getJudgement(created.id)?.reportStatus).toBe('ready'))
    expect(database.getJudgement(created.id)?.latestReportVersion).toBe(2)
    expect(database.getRepairAttempts(created.id)).toBe(0)
    expect(database.listReportRows(created.id)).toHaveLength(2)
    database.close()
  })

  it('keeps the concrete DSH failure message when an initial report turn crashes', async () => {
    const { database, service } = fixture()
    const created = await service.call('judgement.create', {
      secId: '1.600519', masterId: 'duan-yongping-perspective',
    }, new AbortController().signal)

    service.handleSessionEvent(created.dshSessionId!, {
      type: 'turn/end',
      seq: SessionSeq(1),
      time: Date.now(),
      data: {
        turn: 1,
        reason: {
          kind: 'error',
          error: { code: 'UNKNOWN', message: "Cannot read properties of undefined (reading 'prepare')" },
        },
      },
    })

    expect(database.getJudgement(created.id)).toMatchObject({
      reportStatus: 'failed',
      turnStatus: 'failed',
      errorCode: 'turn-error',
      errorMessage: "DSH 回合未完成：Cannot read properties of undefined (reading 'prepare')",
    })
    database.close()
  })

  it('keeps the sealed report ready when a revision exhausts repair and permits another revision', async () => {
    const { database, reports, service, sessions } = fixture(180)
    const created = await service.call('judgement.create', {
      secId: '1.600519', masterId: 'munger-perspective',
    }, new AbortController().signal)
    writeFileSync(reports.workingReportPath(created.id), `# 第一版正式报告\n\n${'事实、推断、风险与验证条件。'.repeat(24)}`)
    service.handleSessionEvent(created.dshSessionId!, completed())
    await eventually(() => expect(database.getJudgement(created.id)?.reportStatus).toBe('ready'))

    await service.call('judgement.revise', {
      id: created.id, instruction: '生成第二版',
    }, new AbortController().signal)
    writeFileSync(reports.workingReportPath(created.id), '# 第二版太短')
    service.handleSessionEvent(created.dshSessionId!, completed(2))
    await eventually(() => expect(database.getJudgement(created.id)?.reportStatus).toBe('repairing'))
    service.handleSessionEvent(created.dshSessionId!, completed(3))
    await eventually(() => expect(database.getJudgement(created.id)?.turnStatus).toBe('failed'))

    expect(database.getJudgement(created.id)).toMatchObject({
      reportStatus: 'ready',
      latestReportVersion: 1,
      turnStatus: 'failed',
      errorCode: 'report-too-short',
    })
    expect(database.getRepairAttempts(created.id)).toBe(0)
    expect(database.listReportRows(created.id)).toHaveLength(1)

    await expect(service.call('judgement.revise', {
      id: created.id, instruction: '重新生成第二版',
    }, new AbortController().signal)).resolves.toMatchObject({
      reportStatus: 'revising',
      latestReportVersion: 1,
      errorCode: null,
    })
    expect(sessions.prompts.at(-1)?.text).toContain('重新生成第二版')
    database.close()
  })

  it('restores ready state when submitting a revision prompt fails', async () => {
    const { database, reports, service, sessions } = fixture()
    const created = await service.call('judgement.create', {
      secId: '1.600519', masterId: 'munger-perspective',
    }, new AbortController().signal)
    writeFileSync(reports.workingReportPath(created.id), `# 第一版正式报告\n\n${'事实、推断、风险与验证条件。'.repeat(24)}`)
    service.handleSessionEvent(created.dshSessionId!, completed())
    await eventually(() => expect(database.getJudgement(created.id)?.reportStatus).toBe('ready'))

    vi.spyOn(sessions, 'prompt').mockRejectedValueOnce(new Error('prompt submission failed'))
    await expect(service.call('judgement.revise', {
      id: created.id, instruction: '本次提交会失败',
    }, new AbortController().signal)).rejects.toThrow('prompt submission failed')
    expect(database.getJudgement(created.id)).toMatchObject({
      reportStatus: 'ready',
      latestReportVersion: 1,
      turnStatus: 'failed',
      errorCode: 'revision-start-failed',
    })

    await expect(service.call('judgement.revise', {
      id: created.id, instruction: '再次修订',
    }, new AbortController().signal)).resolves.toMatchObject({ reportStatus: 'revising' })
    database.close()
  })

  it('marks a preparing judgement recoverably failed after a host restart', async () => {
    const { database, service } = fixture()
    const judgement = database.createJudgement({
      id: 'interrupted-before-session-binding',
      secId: '1.600519',
      code: '600519',
      stockName: '贵州茅台',
      masterId: 'munger-perspective',
      masterName: '查理·芒格',
      masterVersion: 'v1',
    })
    expect(judgement.reportStatus).toBe('preparing')

    await service.recover()

    expect(database.getJudgement(judgement.id)).toMatchObject({
      reportStatus: 'failed',
      turnStatus: 'failed',
      errorCode: 'recovery-preparing-interrupted',
      errorMessage: expect.stringContaining('重新发起研判'),
    })
    database.close()
  })

  it('recovers interrupted expert chat turns without hiding a prior failure', async () => {
    const { database, service } = fixture()
    const interrupted = database.createExpertChat({
      id: 'chat-interrupted',
      title: '中断的开放对谈',
      masterId: 'munger-perspective',
      masterName: '查理·芒格',
      masterVersion: 'v1',
    })
    database.updateExpertChat(interrupted.id, {
      dshSessionId: 'session-interrupted',
      turnStatus: 'running',
    })
    const failed = database.createExpertChat({
      id: 'chat-failed',
      title: '失败的开放对谈',
      masterId: 'sun-yuchen-perspective',
      masterName: '孙宇晨',
      masterVersion: 'v1',
    })
    database.updateExpertChat(failed.id, {
      dshSessionId: 'session-failed',
      turnStatus: 'failed',
      errorCode: 'chat-turn-error',
      errorMessage: '保留这条错误',
    })

    await service.recover()

    expect(database.getExpertChat(interrupted.id)).toMatchObject({
      turnStatus: 'idle', errorCode: null, errorMessage: null,
    })
    expect(database.getExpertChat(failed.id)).toMatchObject({
      turnStatus: 'failed', errorCode: 'chat-turn-error', errorMessage: '保留这条错误',
    })
    database.close()
  })

  it('archives a DSH session when database binding fails', async () => {
    const { database, service, sessions } = fixture()
    const update = database.updateJudgement.bind(database)
    vi.spyOn(database, 'updateJudgement').mockImplementation((id, patch) => {
      if ('dshSessionId' in patch && patch.dshSessionId !== null) throw new Error('database binding failed')
      return update(id, patch)
    })

    await expect(service.call('judgement.create', {
      secId: '1.600519', masterId: 'munger-perspective',
    }, new AbortController().signal)).rejects.toThrow('database binding failed')

    expect(sessions.archived).toHaveLength(1)
    expect(sessions.archived[0]).toMatch(/^hanai-/)
    expect(database.listJudgements()).toEqual([
      expect.objectContaining({
        dshSessionId: null,
        reportStatus: 'failed',
        turnStatus: 'failed',
        errorCode: 'judgement-start-failed',
      }),
    ])
    database.close()
  })

  it('persists successful market and valuation timestamps without regressing them', async () => {
    const { database, market, service } = fixture()
    const marketMeta: ProviderMeta = {
      providerId: 'eastmoney',
      sourceName: '东方财富',
      sourceTimestamp: '2026-08-15T01:00:00.000Z',
      fetchedAt: '2026-08-15T01:02:00.000Z',
      cacheState: 'fresh',
    }
    const valuationMeta: ProviderMeta = {
      providerId: 'gurufocus',
      sourceName: 'GuruFocus',
      sourceTimestamp: null,
      fetchedAt: '2026-08-15T01:03:00.000Z',
      cacheState: 'cached',
    }
    market.getStockDetail = async () => ({
      ...stockDetail(),
      trend: [{ time: '09:30', price: 10, avgPrice: 10, volume: 100 }],
      trendPrevClose: 9.8,
      valuation: {
        stockId: 'SHSE:600519', ivDcf: null, medps: 10, gfScore: null, valuationRank: null,
        dimensions: {
          financialStrength: null, profitability: null, growth: null, gfValue: null, momentum: null,
        },
        series: { price: [], medps: [] },
        meta: valuationMeta,
      },
      sources: {
        ...stockDetail().sources,
        trend: marketMeta,
        valuation: valuationMeta,
      },
    })

    await service.call('security.detail', { secId: '1.600519' }, new AbortController().signal)
    expect(database.getSetting('market.latestSuccess')).toBe('2026-08-15T01:02:00.000Z')
    expect(database.getSetting('valuation.latestSuccess')).toBe('2026-08-15T01:03:00.000Z')

    market.getStockDetail = async () => ({
      ...stockDetail(),
      trend: [{ time: '09:30', price: 10, avgPrice: 10, volume: 100 }],
      trendPrevClose: 9.8,
      valuation: {
        stockId: 'SHSE:600519', ivDcf: null, medps: 10, gfScore: null, valuationRank: null,
        dimensions: {
          financialStrength: null, profitability: null, growth: null, gfValue: null, momentum: null,
        },
        series: { price: [], medps: [] },
        meta: { ...valuationMeta, fetchedAt: '2026-08-14T01:03:00.000Z' },
      },
      sources: {
        ...stockDetail().sources,
        trend: { ...marketMeta, fetchedAt: '2026-08-14T01:02:00.000Z' },
        valuation: { ...valuationMeta, fetchedAt: '2026-08-14T01:03:00.000Z' },
      },
    })
    await service.call('security.detail', { secId: '1.600519' }, new AbortController().signal)
    const diagnostics = await service.call('diagnostics.get', {}, new AbortController().signal)
    expect(diagnostics.latestMarketSuccess).toBe('2026-08-15T01:02:00.000Z')
    expect(diagnostics.latestValuationSuccess).toBe('2026-08-15T01:03:00.000Z')
    expect(diagnostics.marketSources).toEqual([marketMeta])
    expect(diagnostics.valuationSources).toEqual([valuationMeta])
    database.close()
  })
})

describe('HanaiService parity endpoints and diagnostics', () => {
  it('enforces the shared manual security cooldown until the exact 60-second boundary', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-26T10:00:00+08:00'))
    const { database, market, service } = fixture()
    try {
      const sync = vi.spyOn(market, 'syncSecurities').mockResolvedValue({ count: 5576, updatedAt: null })
      const signal = new AbortController().signal
      await service.call('security.sync', { force: true }, signal)
      expect((await service.call('diagnostics.get', {}, signal)).securitySyncAvailableAt).toBe('2026-10-26T02:01:00.000Z')
      await expect(service.call('security.sync', {}, signal)).rejects.toThrow('60 秒后重试')
      vi.advanceTimersByTime(59_999)
      await expect(service.call('security.sync', { force: true }, signal)).rejects.toThrow('1 秒后重试')
      expect(sync).toHaveBeenCalledTimes(1)
      vi.advanceTimersByTime(1)
      await service.call('security.sync', { force: true }, signal)
      expect(sync).toHaveBeenCalledTimes(2)
    } finally { database.close(); vi.useRealTimers() }
  })

  it('retains cooldown after failure and service recreation while leaving automatic bootstrap sync independent', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-26T10:00:00+08:00'))
    const setup = fixture()
    try {
      const sync = vi.spyOn(setup.market, 'syncSecurities').mockRejectedValueOnce(new Error('offline'))
        .mockResolvedValue({ count: 0, updatedAt: null })
      const signal = new AbortController().signal
      await expect(setup.service.call('security.sync', { force: true }, signal)).rejects.toThrow('offline')
      const restarted = new HanaiService({ ...setup, version: 'test' })
      await expect(restarted.call('security.sync', { force: true }, signal)).rejects.toThrow('冷却中')
      await restarted.call('bootstrap', {}, signal)
      expect(sync).toHaveBeenCalledTimes(2)
      expect(sync.mock.calls[1]?.[1]).toBe(false)
      vi.advanceTimersByTime(60_000)
      await setup.service.call('security.sync', { force: true }, signal)
      expect(sync).toHaveBeenCalledTimes(3)
    } finally { setup.database.close(); vi.useRealTimers() }
  })

  it('blocks overlapping manual syncs even when a running request outlasts its cooldown', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-26T10:00:00+08:00'))
    const { database, market, service } = fixture()
    let finish!: (value: { count: number; updatedAt: string | null }) => void
    const pending = new Promise<{ count: number; updatedAt: string | null }>(resolve => { finish = resolve })
    const sync = vi.spyOn(market, 'syncSecurities').mockReturnValue(pending)
    const signal = new AbortController().signal
    const active = service.call('security.sync', { force: true }, signal)
    try {
      vi.advanceTimersByTime(61_000)
      await expect(service.call('security.sync', { force: true }, signal)).rejects.toThrow('正在同步')
      expect(sync).toHaveBeenCalledTimes(1)
    } finally {
      finish({ count: 5576, updatedAt: null })
      await active
      database.close()
      vi.useRealTimers()
    }
  })

  it('keeps security provenance separate from market success and exposes diagnostics without fetching prices', async () => {
    const { database, market, service } = fixture()
    try {
      database.setSetting('market.latestSuccess', '2026-10-26T01:00:00.000Z')
      market.syncSecurities = async () => {
        database.setSetting('security.master.syncedAt', '2026-10-26T02:00:00.000Z')
        database.setSetting('security.master.source', '新浪')
        return { count: 5576, updatedAt: '2026-10-26T02:00:00.000Z' }
      }
      const history = [{ source: 'sina', sourceName: '新浪', scope: 'security' as const, lastAttemptAt: null,
        lastSuccessAt: null, lastError: null, failures: 0, openUntil: null }]
      market.getSourceDiagnostics = () => history
      const quotes = vi.spyOn(market, 'getQuotes')
      await service.call('security.sync', { force: true }, new AbortController().signal)
      await service.call('bootstrap', {}, new AbortController().signal)
      const diagnostics = await service.call('diagnostics.get', {}, new AbortController().signal)
      expect(diagnostics).toMatchObject({ latestMarketSuccess: '2026-10-26T01:00:00.000Z', marketSources: [],
        securitySource: '新浪', latestSecuritySuccess: '2026-10-26T02:00:00.000Z', sourceAttempts: history })
      expect(quotes).not.toHaveBeenCalled()
    } finally { database.close() }
  })

  it('reads unique watch securities locally even when market providers are unavailable', async () => {
    const { database, market, service } = fixture()
    try {
      const security = stockDetail().security!
      database.sqlite.prepare(`
        INSERT INTO security_master(sec_id, code, name, exchange, pinyin_full, pinyin_initial, updated_at)
        VALUES(?, ?, ?, ?, ?, ?, ?)
      `).run(security.secId, security.code, security.name, security.exchange, security.pinyinFull, security.pinyinInitial, new Date().toISOString())
      const group = database.listWatchGroups()[0]!
      const second = database.createWatchGroup('观察组')
      database.addWatchItem(group.id, security.secId, null)
      database.addWatchItem(second.id, security.secId, null)
      database.addWatchItem(second.id, '0.000001', null)
      const quotes = vi.spyOn(market, 'getQuotes').mockRejectedValue(new Error('offline'))
      const search = vi.spyOn(market, 'searchSecurities').mockRejectedValue(new Error('offline'))

      await expect(service.call('watch.securities', {}, new AbortController().signal)).resolves.toEqual([security])
      expect(quotes).not.toHaveBeenCalled()
      expect(search).not.toHaveBeenCalled()
    } finally {
      database.close()
    }
  })

  it('loads daily watch valuations as one resilient group batch', async () => {
    const { database, market, service } = fixture()
    const group = database.listWatchGroups()[0]!
    database.addWatchItem(group.id, '1.600519', 100)
    database.addWatchItem(group.id, '0.000001', 10)
    const valuationMeta: ProviderMeta = {
      providerId: 'gurufocus-cn-prototype',
      sourceName: '价值大师网',
      sourceTimestamp: '2026-08-15',
      fetchedAt: '2026-08-15T01:03:00.000Z',
      cacheState: 'cached',
    }
    vi.spyOn(market, 'getValuation').mockImplementation(async (secId) => {
      if (secId === '0.000001') throw new Error('single valuation unavailable')
      return {
        valuation: {
          stockId: 'SHSE:600519', ivDcf: null, medps: 123.45, gfScore: null, valuationRank: 4,
          dimensions: { financialStrength: null, profitability: null, growth: null, gfValue: null, momentum: null },
          series: { price: [], medps: [] },
          meta: valuationMeta,
        },
        meta: valuationMeta,
      }
    })

    await expect(service.call(
      'watch.valuations',
      { groupId: group.id },
      new AbortController().signal,
    )).resolves.toEqual({
      valuations: [
        { secId: '0.000001', fairValue: null, valuationRank: null, meta: null },
        { secId: '1.600519', fairValue: 123.45, valuationRank: 4, meta: valuationMeta },
      ],
      meta: valuationMeta,
    })
    expect(database.getSetting('valuation.latestSuccess')).toBe('2026-08-15T01:03:00.000Z')
    database.close()
  })

  it('reads and writes the DSH-owned default model without a Hanai settings copy', async () => {
    const { database, defaultModel, service } = fixture()

    await expect(service.call(
      'model.default.get',
      {},
      new AbortController().signal,
    )).resolves.toEqual({
      provider: 'deepseek-official',
      model: 'deepseek-v4-pro',
      reasoningEffort: 'high',
    })

    await expect(service.call(
      'model.default.set',
      { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
      new AbortController().signal,
    )).resolves.toEqual({
      provider: 'deepseek-official',
      model: 'deepseek-v4-flash',
    })
    expect(defaultModel.currentSelection()).toEqual({
      provider: 'deepseek-official',
      model: 'deepseek-v4-flash',
    })
    database.close()
  })

  it('fails loudly when DSH exposes only the composition default and cannot persist', async () => {
    const { database, defaultModel, service } = fixture()
    vi.spyOn(defaultModel, 'saveSelection').mockResolvedValueOnce()

    await expect(service.call(
      'model.default.set',
      { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
      new AbortController().signal,
    )).rejects.toThrow('未提供可写的默认模型设置')
    expect(defaultModel.currentSelection()).toEqual({
      provider: 'deepseek-official',
      model: 'deepseek-v4-pro',
      reasoningEffort: 'high',
    })
    database.close()
  })

  it('opens only the isolated data root through the injected platform launcher', async () => {
    const { database, openDirectory, paths, service } = fixture()

    await expect(service.call(
      'storage.openDataRoot',
      {},
      new AbortController().signal,
    )).resolves.toEqual({ opened: true, dataRoot: paths.root })
    expect(openDirectory).toHaveBeenCalledOnce()
    expect(openDirectory).toHaveBeenCalledWith(paths.root)

    openDirectory.mockRejectedValueOnce(new Error('Finder launch failed'))
    await expect(service.call(
      'storage.openDataRoot',
      {},
      new AbortController().signal,
    )).rejects.toThrow('Finder launch failed')
    database.close()
  })

  it('refreshes stock-detail surfaces independently instead of refetching the aggregate detail', async () => {
    const { database, market, service } = fixture()
    const aggregate = vi.spyOn(market, 'getStockDetail')
    const quote = vi.spyOn(market, 'getStockQuoteMetrics')
    const trendMeta: ProviderMeta = {
      providerId: 'eastmoney', sourceName: '东方财富', sourceTimestamp: null,
      fetchedAt: '2026-08-15T01:01:00.000Z', cacheState: 'fresh',
    }
    const trend = vi.spyOn(market, 'getTrend').mockResolvedValue({
      trend: [{ time: '09:30', price: 10, avgPrice: 10, volume: 100 }],
      trendPrevClose: 9.8,
      meta: trendMeta,
    })
    const kline = vi.spyOn(market, 'getKline')
    const valuation = vi.spyOn(market, 'getValuation')

    await service.call('security.quote', { secId: '1.600519' }, new AbortController().signal)
    expect(quote).toHaveBeenCalledOnce()
    expect(aggregate).not.toHaveBeenCalled()
    expect(trend).not.toHaveBeenCalled()
    expect(kline).not.toHaveBeenCalled()
    expect(valuation).not.toHaveBeenCalled()

    const refreshedTrend = await service.call(
      'security.trend',
      { secId: '1.600519' },
      new AbortController().signal,
    )
    expect(refreshedTrend.trendPrevClose).toBe(9.8)
    expect(trend).toHaveBeenCalledOnce()
    expect(aggregate).not.toHaveBeenCalled()
    expect(database.getSetting('market.latestSuccess')).toBe('2026-08-15T01:01:00.000Z')

    await service.call(
      'security.kline',
      { secId: '1.600519', period: 'daily', before: '2018-06-08' },
      new AbortController().signal,
    )
    expect(kline).toHaveBeenCalledWith('1.600519', 'daily', '2018-06-08')
    expect(aggregate).not.toHaveBeenCalled()
    database.close()
  })

  it('reports real storage categories and clears only the selected cache contents idempotently', async () => {
    const { database, market, paths, service } = fixture()
    const clearMemory = vi.spyOn(market, 'clearMarketCache').mockReturnValue(3)
    const nestedMarket = join(paths.marketCacheDir, 'nested')
    const nestedJudgement = join(paths.judgementsDir, 'archive')
    mkdirSync(nestedMarket)
    mkdirSync(nestedJudgement)
    writeFileSync(join(paths.marketCacheDir, 'quote.json'), Buffer.alloc(4))
    writeFileSync(join(nestedMarket, 'board.json'), Buffer.alloc(3))
    writeFileSync(join(paths.valuationCacheDir, 'value.json'), Buffer.alloc(5))
    writeFileSync(join(nestedJudgement, 'report.md'), Buffer.alloc(6))
    writeFileSync(join(paths.root, 'keep.txt'), Buffer.alloc(8))

    const before = await service.call('diagnostics.get', {}, new AbortController().signal)
    expect(before.storage).toMatchObject({
      marketCacheBytes: 7,
      valuationCacheBytes: 5,
      cacheBytes: 12,
      judgementsBytes: 6,
    })
    expect(before.storage.totalBytes).toBeGreaterThanOrEqual(26)

    const cleared = await service.call(
      'cache.clear',
      { scope: 'market' },
      new AbortController().signal,
    )
    expect(cleared).toEqual({ scope: 'market', removedFiles: 2, freedBytes: 7 })
    expect(clearMemory).toHaveBeenCalledOnce()
    expect(existsSync(paths.marketCacheDir)).toBe(true)
    expect(existsSync(join(paths.root, 'keep.txt'))).toBe(true)
    expect(existsSync(join(paths.valuationCacheDir, 'value.json'))).toBe(true)
    expect(existsSync(join(nestedJudgement, 'report.md'))).toBe(true)

    await expect(service.call(
      'cache.clear',
      { scope: 'market' },
      new AbortController().signal,
    )).resolves.toEqual({ scope: 'market', removedFiles: 0, freedBytes: 0 })
    database.close()
  })

  it('rejects a dedicated cache directory replaced by a symlink and leaves its target untouched', async () => {
    const { database, paths, service } = fixture()
    const outside = mkdtempSync(join(tmpdir(), 'hanai-dsh-cache-outside-'))
    roots.push(outside)
    writeFileSync(join(outside, 'sentinel.txt'), 'do-not-delete')
    rmSync(paths.marketCacheDir, { recursive: true })
    symlinkSync(outside, paths.marketCacheDir, 'dir')

    await expect(service.call(
      'cache.clear',
      { scope: 'market' },
      new AbortController().signal,
    )).rejects.toThrow('符号链接')
    expect(existsSync(join(outside, 'sentinel.txt'))).toBe(true)
    database.close()
  })
})
