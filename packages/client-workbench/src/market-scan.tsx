import { useCallback, useEffect, useRef, useState } from 'react'
import type { DashboardData, HanaiResponse, RankEntry } from '../../contracts/src/index.ts'
import { marketHistoryPanel, type MarketHistorySnapshot } from '../../contracts/src/market-history.ts'
import type { HanaiClient } from './api.ts'
import { isMarketOpen, isMarketResting, useRefreshCooldown } from './market-hours.ts'
import { MarketHistoryBar, snapshotDashboard, useMarketHistory } from './market-history.tsx'
import { PanelHead, PanelDataMeta } from './panel-head.tsx'
import { classForChange, money, number, percent, ratio } from './format.ts'
import { EMPTY_SCAN_FILTERS, filterScanRows, mergeScanDashboard, scanArchiveCurrent, SCAN_RANKS, type ScanRank } from './market-scan-data.ts'
import styles from './market-scan.module.css'
import ui from './styles.module.css'

const message = (cause: unknown) => cause instanceof Error ? cause.message : String(cause)
export function MarketScanPage({ client, onStock }: { client: HanaiClient; onStock: (row: RankEntry) => void }) {
  const history = useMarketHistory(client)
  const historical = history.selectedDate !== null
  const [live, setLive] = useState<DashboardData | null>(null)
  const [archive, setArchive] = useState<MarketHistorySnapshot | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const request = useRef<AbortController | null>(null)
  const [revision, setRevision] = useState(0)
  const [rank, setRank] = useState<ScanRank>('gainers')
  const [boardType, setBoardType] = useState<'industry' | 'concept'>('industry')
  const [board, setBoard] = useState<{ code: string; name: string } | null>(null)
  const [constituents, setConstituents] = useState<{ code: string; data: HanaiResponse<'sector.stocks'> } | null>(null)
  const [boardError, setBoardError] = useState<string | null>(null)
  const [boardLoading, setBoardLoading] = useState(false)
  const [filters, setFilters] = useState(EMPTY_SCAN_FILTERS)
  const { cooldown, canRefresh, startCooldown } = useRefreshCooldown()
  const load = useCallback(async (force = false) => {
    if (request.current && !request.current.signal.aborted) return
    const controller = new AbortController(); request.current = controller
    setLoading(true)
    try {
      const next = await client.call('dashboard.get', force ? { refresh: true } : {}, controller.signal)
      if (controller.signal.aborted) return
      setLive(previous => mergeScanDashboard(previous, next)); setArchive(null); setError(null); setRevision(value => value + 1)
      void history.reloadIndex()
    } catch (cause) { if (!controller.signal.aborted) setError(`刷新失败，保留已有样本：${message(cause)}`) }
    finally { if (!controller.signal.aborted) setLoading(false); if (request.current === controller) request.current = null }
  }, [client, history.reloadIndex])

  useEffect(() => {
    if (historical) return
    const controller = new AbortController()
    const initialize = async () => {
      setLoading(true)
      if (!isMarketOpen()) {
        try {
          const { snapshots } = await client.call('market.history.list', {}, controller.signal)
          const latest = snapshots.find(item => item.panels.some(key => ['overview', 'industry', 'concept', 'rank.gainers', 'rank.losers', 'rank.amount', 'rank.turnover'].includes(key)))
          const saved = latest ? await client.call('market.history.get', { date: latest.date }, controller.signal) : null
          if (controller.signal.aborted) return
          if (saved) { setLive(snapshotDashboard(saved)); setArchive(saved); if (scanArchiveCurrent(saved)) { setError(null); setLoading(false); return } }
        } catch (cause) { if (!controller.signal.aborted) { setError(`归档读取失败：${message(cause)}`); setLoading(false) }; return }
      }
      if (!controller.signal.aborted) void load()
    }
    void initialize()
    const timer = window.setInterval(() => { if (isMarketOpen()) { controller.abort(); void load() } }, 30_000)
    return () => { controller.abort(); request.current?.abort(); request.current = null; window.clearInterval(timer) }
  }, [client, historical, load])

  const snapshot = historical ? history.snapshot : archive
  const data = historical ? history.dashboard : live
  const currentError = historical ? history.error : error
  useEffect(() => { setBoard(null); setConstituents(null); setBoardError(null) }, [history.selectedDate, boardType])
  useEffect(() => {
    if (!board) return
    const controller = new AbortController()
    setConstituents(current => current?.code === board.code ? current : null); setBoardError(null); setBoardLoading(true)
    if (historical || archive !== null) {
      const saved = marketHistoryPanel(snapshot, `sector:${board.code}`)
      setConstituents(saved ? { code: board.code, data: saved } : null); setBoardError(saved ? null : '本快照未保存该板块成分，不补入实时数据'); setBoardLoading(false)
    } else {
      void client.call('sector.stocks', { sectorCode: board.code }, controller.signal).then(result => {
        if (!controller.signal.aborted) { if (result.meta.cacheState !== 'unavailable') setConstituents({ code: board.code, data: result }); else setBoardError('板块来源不可用，保留已有样本'); void history.reloadIndex() }
      }).catch(cause => { if (!controller.signal.aborted) setBoardError(message(cause)) }).finally(() => { if (!controller.signal.aborted) setBoardLoading(false) })
    }
    return () => controller.abort()
  }, [client, board, snapshot, historical, archive, revision, history.reloadIndex])

  const sectorData = constituents?.code === board?.code ? constituents?.data : null
  const rows = board ? sectorData?.stocks ?? [] : data?.ranks[rank] ?? []
  const meta = board ? sectorData?.meta : data?.rankSources?.[rank] ?? data?.overview.meta
  const filtered = filterScanRows(rows, filters)
  const updateFilter = (key: keyof typeof filters, value: string | boolean) => setFilters(current => ({ ...current, [key]: value }))
  const archived = historical || archive !== null
  return <section className={styles.page} aria-label="市场扫描">
    <div className={styles.heading}><div><h1>市场扫描</h1><p>A 股 · 从榜单和板块样本发现线索，点击股票继续研究</p></div><div className={styles.actions}><MarketHistoryBar history={history} onSelect={history.selectDate} /><button className={ui.button} disabled={historical || loading || !canRefresh} onClick={() => { if (!canRefresh) return; startCooldown(); void load(true) }}>{loading ? '正在更新…' : cooldown ? `${cooldown}秒后刷新` : '刷新样本'}</button></div></div>
    {(currentError || history.indexError) && <p className={styles.error} role="alert">{currentError}{history.indexError ? ' 历史日期列表读取失败' : ''}</p>}
    <section className={styles.panel}><PanelHead title="指数概览" meta={<PanelDataMeta meta={data?.overview.meta} history={historical} resting={archive !== null || isMarketResting()} refreshFailed={!historical && error !== null} />} />
      <div className={styles.indices}>{data?.overview.indices.map(index => <div key={index.code}><span>{index.name}</span><strong className={ui[classForChange(index.changePct)]}>{number(index.price)}</strong><small className={ui[classForChange(index.changePct)]}>{percent(index.changePct)}</small></div>)}{!data?.overview.indices.length && <p>{loading || history.loading ? '正在读取指数…' : '该日期指数数据不可用'}</p>}</div>
    </section>
    <div className={styles.layout}><section className={styles.panel}>
      <PanelHead title={board ? board.name : '特色榜单'} hint={board ? '板块返回样本' : '四类行情榜单'} meta={<PanelDataMeta meta={meta} history={historical} resting={archive !== null || isMarketResting()} refreshFailed={board ? boardError !== null : !historical && error !== null} />} extra={board && <button className={ui.button} onClick={() => setBoard(null)}>返回榜单</button>} />
      <div className={styles.tabs} role="group" aria-label="行情榜单">{(Object.keys(SCAN_RANKS) as ScanRank[]).map(key => <button className={rank === key && !board ? ui.buttonPrimary : ui.button} aria-pressed={rank === key && !board} key={key} onClick={() => { setRank(key); setBoard(null) }}>{SCAN_RANKS[key]}</button>)}</div>
      <div className={styles.filters} aria-label="样本筛选条件"><label>名称／代码<input aria-label="扫描名称代码" placeholder="仅在当前样本内查找" value={filters.query} onChange={e => updateFilter('query', e.target.value)} /></label>{([['minPrice', '最低价（元）'], ['maxPrice', '最高价（元）'], ['minChange', '涨幅至少（%）'], ['minAmount', '成交额至少（亿）'], ['minTurnover', '换手率至少（%）']] as const).map(([key, label]) => <label key={key}>{label}<input type="number" step="any" aria-label={label} value={filters[key]} onChange={e => updateFilter(key, e.target.value)} /></label>)}<label className={styles.check}><input type="checkbox" checked={filters.excludeST} onChange={e => updateFilter('excludeST', e.target.checked)} />排除 ST</label><button className={ui.button} onClick={() => setFilters(EMPTY_SCAN_FILTERS)}>重置条件</button></div>
      <p className={styles.scope}>命中 {filtered.rows.length} / 当前样本 {rows.length} 只 · 非全市场筛选，缺失指标不参与对应条件匹配{archived ? ' · 本地快照只读' : ''}</p>
      {(filtered.error || boardError) && <p role="alert" className={styles.error}>{filtered.error ?? boardError}</p>}
      <div className={styles.table}><table><thead><tr><th>序号</th><th>名称／代码</th><th>最新价</th><th>涨跌幅</th><th>成交额</th><th>换手率</th></tr></thead><tbody>{filtered.rows.map((row, index) => <tr key={row.secId}><td>{index + 1}</td><td><button disabled={historical} title={historical ? '历史视图只读，不跳转实时个股数据' : '查看个股详情'} onClick={() => onStock(row)}><b>{row.name}</b><small>{row.code}</small></button></td><td>{number(row.price)}</td><td className={ui[classForChange(row.changePct)]}>{percent(row.changePct)}</td><td>{money(row.amount)}</td><td>{ratio(row.turnoverRate)}</td></tr>)}</tbody></table>{filtered.rows.length === 0 && <p className={styles.empty}>{boardLoading || (!data && (loading || history.loading)) ? '正在读取样本…' : meta?.cacheState === 'unavailable' || !meta ? '样本数据不可用或该日期未保存' : rows.length ? '当前样本没有符合条件的股票' : '来源未返回样本'}</p>}</div>
    </section><aside className={styles.panel}><PanelHead title="板块扫描" meta={<PanelDataMeta meta={data?.[boardType].meta} history={historical} resting={archive !== null || isMarketResting()} refreshFailed={!historical && error !== null} />} /><div className={styles.tabs}><button className={boardType === 'industry' ? ui.buttonPrimary : ui.button} onClick={() => setBoardType('industry')}>行业</button><button className={boardType === 'concept' ? ui.buttonPrimary : ui.button} onClick={() => setBoardType('concept')}>概念</button></div><div className={styles.boards}>{data?.[boardType].sectors.map(sector => <button key={sector.code} onClick={() => setBoard({ code: sector.code, name: sector.name })}><span>{sector.name}<small>{sector.leaderName ? `领涨：${sector.leaderName}` : '领涨股未提供'}</small></span><strong className={ui[classForChange(sector.changePct)]}>{percent(sector.changePct)}</strong></button>)}{!data?.[boardType].sectors.length && <p className={styles.empty}>该日期板块数据不可用或未保存</p>}</div></aside></div>
  </section>
}
