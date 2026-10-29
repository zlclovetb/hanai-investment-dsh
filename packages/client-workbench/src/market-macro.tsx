import { useEffect, useMemo, useRef, useState } from 'react'
import type { ThemeId } from '../../contracts/src/index.ts'
import { MACRO_ETFS, macroAllTotals, type MacroGenerationStatus, type MacroAllDailyData, type MacroAllEtfData, type MacroCapitalData, type MacroEtfData, type MacroIndexData, type MacroDailyEtfData } from '../../contracts/src/market-macro.ts'
import { beijingMarketDate, marketHistoryPanel, type MarketHistorySnapshot } from '../../contracts/src/market-history.ts'
import type { HanaiClient } from './api.ts'
import { dateTime } from './format.ts'
import { getChartPalette } from './chart-options.ts'
import { EChart } from './echarts.tsx'
import { PanelHead, DataStateBadge, DataSourceText } from './panel-head.tsx'
import { describeDataStatus } from './data-status.ts'
import { buildMacroOption, macroFourTotals, macroRatios, macroTotals } from './macro-chart.ts'
import { MarketHistoryBar, useMarketHistory } from './market-history.tsx'
import { useRefreshCooldown } from './market-hours.ts'
import styles from './styles.module.css'

export function MacroPage({ client, theme }: { client: HanaiClient; theme: ThemeId }) {
  const history = useMarketHistory(client)
  const historical = history.selectedDate !== null
  const [allDaily, setAllDaily] = useState<MacroAllDailyData | null>(null)
  const [allEtfs, setAllEtfs] = useState<MacroAllEtfData | null>(null)
  const [capital, setCapital] = useState<MacroCapitalData | null>(null)
  const [daily, setDaily] = useState<MacroDailyEtfData | null>(null)
  const [job, setJob] = useState<MacroGenerationStatus | null>(null)
  const [revision, setRevision] = useState(0)
  const [watchRevision, setWatchRevision] = useState(0)
  const [starting, setStarting] = useState(false)
  const [hasGenerated, setHasGenerated] = useState(false)
  const generating = starting || job?.state === 'running'
  const backfilling = generating
  const archivedChart = historical ? marketHistoryPanel(history.snapshot, 'macro.chart') : null
  const shownTask = historical ? archivedChart?.task ?? null : job
  const jobError = (endpoint: string) => shownTask?.panels.find(panel => panel.endpoint === endpoint)?.error ?? null
  const dailyError = jobError('market.macro.daily')
  const allDailyError = jobError('market.macro.allDaily')
  const allError = jobError('market.macro.all')
  const capitalError = jobError('market.macro.capital')
  const [etfs, setEtfs] = useState<MacroEtfData | null>(null)
  const [index, setIndex] = useState<MacroIndexData | null>(null)
  const [errors, setErrors] = useState<string[]>([])
  const [loading, setLoading] = useState(false)
  const request = useRef<AbortController | null>(null)
  const { canRefresh, cooldown, startCooldown } = useRefreshCooldown()

  useEffect(() => {
    if (historical) { setHasGenerated(false); return }
    const controller = new AbortController()
    request.current = controller
    setLoading(true)
    const restore = async () => {
      try {
        const { snapshots } = await client.call('market.history.list', {}, controller.signal)
        const candidates = snapshots.filter(snapshot => snapshot.date <= beijingMarketDate()).sort((a, b) => b.date.localeCompare(a.date))
        const records = new Map<string, MarketHistorySnapshot | null>()
        let savedEtfs: MacroEtfData | null = null
        let savedIndex: MacroIndexData | null = null
        let savedDaily: MacroDailyEtfData | null = null
        let savedCapital: MacroCapitalData | null = null
        let savedAll: MacroAllEtfData | null = null
        let savedAllDaily: MacroAllDailyData | null = null
        for (const key of ['macro.etf', 'macro.index', 'macro.etf.daily', 'macro.capital', 'macro.etf.all.quarter', 'macro.etf.all.daily'] as const) {
          for (const item of candidates.filter(snapshot => snapshot.panels.includes(key))) {
            if (!records.has(item.date)) records.set(item.date, await client.call('market.history.get', { date: item.date }, controller.signal))
            if (controller.signal.aborted) return
            const snapshot = records.get(item.date) ?? null
            if (snapshot !== null && snapshot.date !== item.date) throw new Error('历史记录日期不匹配')
            if (key === 'macro.etf') { savedEtfs = marketHistoryPanel(snapshot, key); if (savedEtfs !== null) break }
            else if (key === 'macro.index') { savedIndex = marketHistoryPanel(snapshot, key); if (savedIndex !== null) break }
            else if (key === 'macro.etf.all.daily') { savedAllDaily = marketHistoryPanel(snapshot, key); if (savedAllDaily !== null) break }
            else if (key === 'macro.etf.all.quarter') { savedAll = marketHistoryPanel(snapshot, key); if (savedAll !== null) break }
            else if (key === 'macro.capital') { savedCapital = marketHistoryPanel(snapshot, key); if (savedCapital !== null) break }
            else { savedDaily = marketHistoryPanel(snapshot, key); if (savedDaily !== null) break }
          }
        }
        if (!controller.signal.aborted) { setEtfs(savedEtfs); setIndex(savedIndex); setDaily(savedDaily); setCapital(savedCapital); setAllEtfs(savedAll); setAllDaily(savedAllDaily) }
      } catch {
        if (!controller.signal.aborted) setErrors(['宏观历史归档读取失败，请重新打开页面重试'])
      } finally {
        if (!controller.signal.aborted) setLoading(false)
      }
    }
    void restore()
    return () => { controller.abort(); request.current?.abort() }
  }, [client, historical, revision])

  useEffect(() => {
    if (historical) return
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    let wasRunning = false
    const observe = async () => {
      try {
        const status = await client.call('market.macro.generation', {}, controller.signal)
        if (controller.signal.aborted) return
        setJob(status)
        if (status.state === 'running') setHasGenerated(true)
        if (status.state === 'running' || wasRunning) { setRevision(value => value + 1); void history.reloadIndex() }
        wasRunning = status.state === 'running'
        if (wasRunning) timer = setTimeout(() => { void observe() }, 2000)
      } catch {
        if (!controller.signal.aborted) setErrors(['后台任务状态读取失败；任务可能仍在运行，重新打开页面可查看'])
      }
    }
    void observe()
    return () => { controller.abort(); clearTimeout(timer) }
  }, [client, historical, watchRevision, history.reloadIndex])

  const generate = async () => {
    if (historical || generating || loading || !canRefresh) return
    const controller = new AbortController()
    request.current = controller
    startCooldown()
    setStarting(true)
    setHasGenerated(true)
    setErrors([])
    try {
      const status = await client.call('market.macro.generate', {}, controller.signal)
      if (!controller.signal.aborted) setJob(status)
    } catch {
      if (!controller.signal.aborted) setErrors(['启动结果未确认，请查看后台任务状态；已保存数据保留'])
    } finally {
      setStarting(false)
      if (!controller.signal.aborted) { setWatchRevision(value => value + 1); setRevision(value => value + 1) }
    }
  }

  const etfData = historical ? archivedChart !== null ? archivedChart.etfs : marketHistoryPanel(history.snapshot, 'macro.etf') : etfs
  const indexData = historical ? archivedChart !== null ? archivedChart.index : marketHistoryPanel(history.snapshot, 'macro.index') : index
  const dailyData = historical ? archivedChart !== null ? archivedChart.daily : marketHistoryPanel(history.snapshot, 'macro.etf.daily') : daily
  const allDailyData = historical ? archivedChart !== null ? archivedChart.allDaily : marketHistoryPanel(history.snapshot, 'macro.etf.all.daily') : allDaily
  const allData = historical ? archivedChart !== null ? archivedChart.allEtfs : marketHistoryPanel(history.snapshot, 'macro.etf.all.quarter') : allEtfs
  const capitalData = historical ? archivedChart !== null ? archivedChart.capital : marketHistoryPanel(history.snapshot, 'macro.capital') : capital
  const reference = capitalData?.reference
  const latestCapitalDate = [capitalData?.points.at(-1)?.date, reference?.points.at(-1)?.date].filter((date): date is string => date !== undefined).sort().at(-1)
  const ratios = macroRatios(dailyData, capitalData, allDailyData)
  const endDate = history.selectedDate ?? beijingMarketDate()
  const option = useMemo(() => buildMacroOption(etfData, indexData, getChartPalette(theme), endDate, dailyData, capitalData, allData, allDailyData), [etfData, indexData, theme, endDate, dailyData, capitalData, allData, allDailyData])
  const fourTotals = macroFourTotals(dailyData, allDailyData)
  const hasDaily = dailyData !== null || fourTotals.length > 0
  const latest = (hasDaily ? fourTotals : macroTotals(etfData)).at(-1)
  const hasDailyRatio = allDailyData?.points.some(point => capitalData?.points.some(cap => cap.date === point.date) || reference?.points.some(cap => cap.date === point.date)) ?? false
  const sources = [
    dailyData ? { label: '四只ETF日规模', meta: dailyData.meta, dateLabel: '数据日期' as const, failed: !historical && dailyError !== null }
      : etfData ? { label: '四只ETF季度规模', meta: etfData.meta, dateLabel: '报告期' as const, failed: false } : null,
    indexData && { label: '沪深300指数', meta: indexData.meta, dateLabel: '交易日' as const, failed: false },
    allDailyData && { label: 'ETF日频总规模', meta: allDailyData.meta, dateLabel: '数据日期' as const, failed: !historical && allDailyError !== null },
    !hasDailyRatio && allData && { label: '在列ETF季末规模', meta: allData.meta, dateLabel: '报告期' as const, failed: !historical && allError !== null },
    capitalData && { label: '沪深300流通市值', meta: capitalData.officialMeta ?? capitalData.meta, dateLabel: '数据日期' as const, failed: !historical && capitalError !== null },
    reference && { label: '分母重建参考', meta: reference.meta, dateLabel: '数据日期' as const, failed: reference.missingDates.length > 0 || Boolean(capitalData?.referenceError) },
  ].filter(source => source !== null && source !== false && source !== undefined).map(source => ({ ...source, resting: !historical && (!hasGenerated || (job?.startedAt != null && Date.parse(source.meta.fetchedAt) < Date.parse(job.startedAt))) }))
  const sourceGroups = new Map<string, typeof sources>()
  for (const source of sources) {
    const key = historical && source.meta.cacheState !== 'unavailable' ? 'history' : source.resting && !source.failed && source.meta.cacheState !== 'unavailable' ? 'resting'
      : JSON.stringify(describeDataStatus(source.meta, { liveCapable: false, refreshFailed: source.failed }))
    const group = sourceGroups.get(key)
    if (group === undefined) sourceGroups.set(key, [source])
    else group.push(source)
  }
  return <div className={styles['page']}>
    <div className={styles['pageHeader']}><div><h1>宏观数据</h1><p>沪深300 ETF规模与指数走势 · 近五年 · 仅手动启动后台生成</p></div></div>
    <div className={styles['macroToolbar']}>
      <MarketHistoryBar history={history} onSelect={history.selectDate} />
      {!historical && <button className={styles['button']} disabled={loading || generating || !canRefresh} onClick={() => { void generate() }}>{generating ? '后台生成中…' : loading ? '读取记录中' : canRefresh ? '生成宏观记录' : `生成 ${cooldown}s`}</button>}
    </div>
    {(historical ? [history.error].filter(Boolean) : errors).map((error, i) => <p key={i} role="alert">{error}</p>)}
    <section className={styles['card']} aria-label="沪深300 ETF宏观图表">
      <PanelHead title="沪深300 ETF规模与流通市值占比" extra={<span>{!historical && generating ? '后台生成中…' : (!historical && loading) || history.loading ? '正在读取…' : latest ? `${latest.date} · 四只合计 ${latest.assets.toLocaleString('zh-CN', { maximumFractionDigits: 2 })} 亿元` : '日规模不可用'}</span>}
        meta={<div className={styles['macroMetadata']}>
          {archivedChart && <small>整图保存于 {dateTime(archivedChart.generatedAt)}；各分项日期见下方来源。</small>}
          {shownTask?.archiveError && <small role="alert">整图快照保存失败：{shownTask.archiveError}</small>}
          {shownTask && shownTask.state !== 'idle' && <div role="status">
            <details><summary>{shownTask.state === 'running' ? '后台生成中，可离开页面；保持DSH宿主运行即可继续补齐' : shownTask.state === 'completed' ? '后台生成完成，图表记录已保存' : '后台任务已结束，部分数据未补齐；再次手动生成可续传'}</summary>
            {shownTask.panels.map(panel => <small key={panel.endpoint}>{panel.label}：{panel.state === 'pending' ? '等待中' : panel.state === 'running' ? '生成中' : panel.state === 'completed' ? '完成' : panel.state === 'partial' ? '有缺口' : '失败'}{panel.total > 1 ? ' · 已检查 ' + panel.checked + (panel.endpoint === 'market.macro.capital' ? ' 项（月报月份＋参考交易日）' : ' / ' + panel.total + ' 日') : ''}{panel.missing > 0 ? ' · 缺口 ' + panel.missing + ' 日' : ''}{panel.error ? ' · ' + panel.error : ''}<br /></small>)}
            </details>
          </div>}
          {[...sourceGroups].map(([key, rows]) => <div className={styles['macroMetadataGroup']} key={key}>
            <DataStateBadge meta={rows[0]!.meta} history={historical} resting={rows[0]!.resting} liveCapable={false} refreshFailed={rows[0]!.failed} />
            <div className={styles['macroSources']}>{rows.map(source => <div className={styles['macroSourceRow']} key={source.label}>
              <span>{source.label}：</span><DataSourceText meta={source.meta} dateLabel={source.dateLabel} />
            </div>)}</div>
          </div>)}
          {!historical && allDailyError && <small role="alert">{allDailyError}</small>}
          {!historical && allError && <small role="alert">{allError}</small>}
          {!historical && capitalError && <small role="alert">{capitalError}</small>}
          {!historical && dailyError && <small role="alert">{dailyError}</small>}
        </div>} />
      <div className={styles['macroNotice']}>
        {historical && history.snapshot !== null && archivedChart === null && <p>该日期仅有旧版分项归档，未保存完整生成快照，不能还原当时整张图；不会混入其它日期的新数据。</p>}
        <p>{ratios.length > 0 ? `上图红线：四只ETF同日规模 ÷ 沪深300流通市值 × 100（月报优先，重建参考段单独标注）；已匹配 ${ratios.length} 个交易日（${ratios[0]!.date} 至 ${ratios.at(-1)!.date}），缺少同日分子或分母处断线，不沿用其它日期数值。` : capitalData ? '占比不可用：已保存流通市值与四只ETF日频规模尚无同日交集，请手动生成继续补齐。' : '占比不可用：尚未保存上交所月报沪深300流通市值，点击“生成宏观记录”后取数；不以总市值或指数点位替代。'}</p>
        {capitalData && latest && latestCapitalDate && latestCapitalDate < latest.date && <p>{`近期占比缺口：流通市值（含重建参考）仅覆盖至 ${latestCapitalDate}，ETF规模已至 ${latest.date}；后续区间暂缺同日分母，待来源发布后再次手动生成，不表示ETF规模停止变化。`}</p>}
        {reference && <p>{`分母重建参考：已取得 ${reference.points.length} / ${reference.expectedDays} 个交易日${reference.points.length > 0 ? `（${reference.points[0]!.date} 至 ${reference.points.at(-1)!.date}）` : ''}，按历史成分周快照汇总300只股票的同日流通市值；周快照不保证精确调样日，与月报存在口径差异。上图红色虚线和蓝色点线为参考段，官方月报可用时优先使用月报，不作比例校准。`}</p>}
        {capitalData?.referenceError && <p role="alert">重建参考失败：{capitalData.referenceError}；保留已保存数据。</p>}
        {reference && reference.missingDates.length > 0 && <details><summary>查看分母重建缺口（下次手动生成重试）</summary>{reference.missingDates.map(row => <p key={row.date}>{row.date} · {row.reason}</p>)}</details>}
        <p>{allDailyData && allDailyData.points.length > 0 ? `蓝色虚线为已核实目录ETF日频占比；下图蓝色面积为其它ETF规模，与同一批计算的四只ETF规模堆叠，上边界为日频总规模。按实际上市日纳入，清算后不再纳入；已核实 ${allDailyData.funds.length} 个当前或历史代码，目录仍可能漏掉其它历史产品。` : allData ? `蓝色虚线为季末占比参考：按 ${allData.universeAsOf} 中证目录在列的 ${allData.funds.length} 只沪深上市被动沪深300ETF统计，排除联接、增强和海外上市产品；每个季末须当时已成立的在列产品数据全部齐全，并有同日流通市值。仅有真实季末观测点，连线仅作阅读参考，不是日频；当前目录可能漏掉已退市产品，不代表完整历史全集。` : '季末占比参考不可用：尚未保存中证在列ETF目录与季末规模，手动生成后读取。'}</p>
        {!hasDailyRatio && allData && <p>{`日频总规模尚未匹配流通市值，蓝色虚线暂保留季末参考。已取得 ${macroAllTotals(allData).length} 个完整季末；匹配流通市值 ${macroAllTotals(allData).filter(point => capitalData?.points.some(cap => cap.date === point.date)).length} 个，未匹配处不画占比。`}</p>}
        <p>日频规模按交易所同日份额 × 未复权单位净值计算，不是资金净流入；缺任一应纳入产品则该日总规模留空，不将季度规模插值为日频。</p>
        {allDailyData && <p>{`总规模日频覆盖 ${allDailyData.points.length} / ${allDailyData.expectedDays} 个交易日 · 已检查 ${allDailyData.points.length + allDailyData.missingDates.length} 日 · 缺口 ${allDailyData.missingDates.length} 日`}</p>}
        {allDailyData && allDailyData.missingDates.length > 0 && <details><summary>查看总规模缺口（下次手动生成重试）</summary>{allDailyData.missingDates.map(row => <p key={row.date}>{row.date} · {row.reason}</p>)}</details>}
        {dailyData && <p>{`日频覆盖 ${dailyData.points.length} / ${dailyData.expectedDays} 个交易日${dailyData.complete ? '' : ' · 历史尚未补齐'}`}{!historical && backfilling ? ' · 后台正在分批补齐；离开页面仍会继续，重新打开可查看进度' : ''}</p>}
        {!hasDaily && <p>{historical ? '所选日期未保存日频规模；红色虚线仅为季末参考数据。' : generating ? '本次手动生成正在读取日份额；红色虚线仅为季度参考。' : '尚未生成日频记录，点击“生成宏观记录”后取数并保存；页面不会自动刷新。'}</p>}
        {indexData === null && <p>{historical ? '所选日期未保存沪深300点位' : '沪深300点位不可用'}</p>}
        {etfData === null && !hasDaily && <p>{historical ? '所选日期未保存ETF规模' : '四只ETF规模不可用'}</p>}
      </div>
      <EChart option={option} ariaLabel="近五年沪深300指数与四只ETF每日规模交互图" className={styles['macroChart'] ?? ''} />
      <div className={styles['macroNotice']}>
        <p>{MACRO_ETFS.map(fund => `${fund.name} ${fund.code}`).join(' / ')}</p>
      </div>
    </section>
  </div>
}
