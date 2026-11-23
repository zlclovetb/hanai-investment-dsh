import { useEffect, useId, useState, type ComponentProps, type ReactNode } from 'react'
import type { SearchResult, StockQuote } from '../../contracts/src/index.ts'
import type { MarketLadderData } from '../../contracts/src/market-ladder.ts'
import { beijingMarketDate } from '../../contracts/src/market-history.ts'
import { cycleDraftSchema, type CycleDraft, type CycleEndpoints, type CycleReview } from '../../contracts/src/topic-cycle.ts'
import type { HanaiClient } from './api.ts'
import { dateTime, percent } from './format.ts'
import { LeaderDesk } from './leader-desk.tsx'
import ui from './styles.module.css'
import styles from './topic-cycle.module.css'

type View = CycleEndpoints['topic-cycle.view']['response']
type Stock = NonNullable<CycleDraft['marketLeader']>
type CycleEvent = CycleDraft['cycles'][number]['events'][number]
type OpenStock = (row: SearchResult) => void
type Intraday = { date: string; ladder: MarketLadderData | null; quotes?: StockQuote[] | undefined }
const panes = { judgement: '判断', archive: '周期回看', review: '模型复盘' } as const

const statusLabel: Record<CycleReview['status'], string> = {
  preparing: '准备行情证据',
  running: '模型起草中',
  draft: '待人工确认',
  confirmed: '已人工确认',
  failed: '起草失败',
}

function StockLink({ stock, onStock }: { stock: Stock; onStock: OpenStock }) {
  const open = () => {
    const exchange = stock.code.startsWith('6') ? 'SH' : /^(4|8|92)/.test(stock.code) ? 'BJ' : 'SZ'
    onStock({ ...stock, exchange, secId: (exchange === 'SH' ? '1.' : '0.') + stock.code,
      pinyinInitial: '', pinyinFull: '', price: null, changePct: null })
  }
  return <button type="button" className={styles.stock} onClick={open}>{stock.name}<small>{stock.code}</small></button>
}

const leaderLabels = { marketLeader: '市场情绪总龙', breakoutLeader: '高度破局龙' } as const
type LeaderRole = keyof typeof leaderLabels

function LeaderAnchor({ role, review, onStock, preview = false }: {
  role: LeaderRole; review?: CycleReview | null | undefined; onStock: OpenStock; preview?: boolean
}) {
  const stock = review?.result?.[role]
  const label = preview ? leaderLabels[role] + '草稿候选' : leaderLabels[role]
  return <section className={styles.anchor} aria-label={label} data-candidate={review?.status === 'draft' && Boolean(stock)}>
    <span>{leaderLabels[role]}</span>
    {review && stock ? <>
      <StockLink stock={stock} onStock={onStock} />
      <span><time dateTime={review.date}>{review.date}</time> · {review.origin === 'user' ? '人工补录' : review.status === 'draft' ? '草稿候选' : statusLabel.confirmed}</span>
    </> : <b>待确认</b>}
  </section>
}

function EventEvidence({ event, evidenceById, manual = false }: {
  event: CycleEvent; evidenceById: ReadonlyMap<string, CycleReview['evidence'][number]>
  manual?: boolean
}) {
  return <details className={styles.evidence}>
    <summary>{manual ? '复盘来源' : '行情证据'}</summary>
    <ul>{event.evidence.map((id, index) => {
      const evidence = evidenceById.get(id)
      if (!evidence) return <li key={index}>证据待补充</li>
      return <li key={index}>
        {evidence.url && /^https?:\/\//i.test(evidence.url)
          ? <a href={evidence.url} target="_blank" rel="noreferrer">{evidence.label}</a> : evidence.label}
        <small>{evidence.date} · {evidence.sourceName} · {dateTime(evidence.observedAt)}</small>
      </li>
    })}</ul>
  </details>
}

const legacyNodeKinds = new Set<CycleEvent['kind']>(['总龙确立', '高潮', '补涨负反馈', '总龙分歧', '退潮'])

function verifiedNodes(review: CycleReview | null | undefined) {
  const evidenceById = new Map(review?.evidence.map(item => [item.id, item]))
  return (review?.result?.cycles ?? []).flatMap(cycle => cycle.events.flatMap((event, index) => {
    const legacy = event.node === undefined && legacyNodeKinds.has(event.kind)
    const change = legacy ? event.detail : event.node
    if (!change || !event.evidence.every(id => evidenceById.has(id))) return []
    return [{ key: cycle.id + ':' + index, cycle: cycle.name, event, change, legacy, next: cycle.takeaway }]
  })).sort((a, b) => b.event.date.localeCompare(a.event.date))
}

function CycleNodes({ review, onStock, preview = false }: {
  review?: CycleReview | null | undefined; onStock: OpenStock; preview?: boolean
}) {
  const evidenceById = new Map(review?.evidence.map(item => [item.id, item]))
  const nodes = verifiedNodes(review)
  const recent = nodes.filter(node => node.event.date === nodes[0]?.event.date).slice(0, 3)
  const earlier = nodes.slice(recent.length)
  const title = preview ? '草稿节点' : '关键节点'
  const manual = review?.origin === 'user'
  const list = (items: typeof nodes) => <ol className={styles.nodesList}>{items.map(({ key, cycle, event, change, legacy }) => <li key={key}>
    <div className={styles.nodeMeta}><time dateTime={event.date}>{event.date}{manual && '前后'}</time><span>{cycle}</span>{legacy && <span>历史事件归纳</span>}</div>
    <strong>{event.kind}</strong>
    <p>{change}</p>
    {event.stocks.length > 0 && <div className={styles.stockRow}>
      {event.stocks.map((stock, index) => <StockLink key={index} stock={stock} onStock={onStock} />)}
    </div>}
    <EventEvidence event={event} evidenceById={evidenceById} manual={manual} />
  </li>)}</ol>
  return <section className={styles.nodes} aria-label={title}>
    <header className={styles.nodeMeta}>
      <h3>{title}</h3>
      {review && <span>复盘 {review.date} · {manual ? '人工补录' : statusLabel[review.status]}</span>}
    </header>
    {recent.length > 0 ? list(recent) : <p className={styles.note}>暂无有证据支持的关键节点。</p>}
    {earlier.length > 0 && <details className={styles.evidence}>
      <summary>查看其余 {earlier.length} 个节点</summary>
      {list(earlier)}
    </details>}
  </section>
}

function CycleResult({ review, onStock }: { review: CycleReview; onStock: OpenStock }) {
  const draft = review.result
  if (!draft) return null
  const evidenceById = new Map(review.evidence.map(item => [item.id, item]))
  const manual = review.origin === 'user'
  return <div className={styles.result}>
    {draft.cycles.length === 0 && <p className={styles.note}>当前没有足够证据建立题材周期。</p>}
    {draft.cycles.map(cycle => <article className={styles.cycle} key={cycle.id}>
      <div className={styles.cycleHead}>
        <h3>{cycle.name}</h3>
        <span className={styles.stage}>{cycle.stage}</span>
        <div className={styles.leader}><span>题材龙头</span> {cycle.leader ? <StockLink stock={cycle.leader} onStock={onStock} /> : '待确认'}</div>
      </div>
      <p className={styles.takeaway}>{cycle.takeaway}</p>
      {cycle.branches.length > 0 && <section>
        <h4>属性与分支</h4>
        <div className={styles.branches}>{cycle.branches.map((branch, index) => <div className={styles.branch} key={index}>
          <strong>{branch.name}</strong>
          <p>{branch.change}</p>
          <div className={styles.stockRow}><span>分支龙</span> {branch.leader ? <StockLink stock={branch.leader} onStock={onStock} /> : '待确认'}</div>
          {branch.followers.length > 0 && <div className={styles.stockRow}><span>后排接力</span>
            {branch.followers.map((stock, index) => <StockLink key={index} stock={stock} onStock={onStock} />)}
          </div>}
        </div>)}</div>
      </section>}
      {cycle.events.length > 0 && <section>
        <h4>周期演进</h4>
        <ol className={styles.timeline}>{cycle.events.toSorted((a, b) => a.date.localeCompare(b.date)).map((event, index) => <li key={index}>
          <time dateTime={event.date}>{event.date}{manual && '前后'}</time>
          <div className={styles.event}>
            <strong>{event.kind}</strong>
            <p>{event.detail}</p>
            {event.stocks.length > 0 && <div className={styles.stockRow}>{event.stocks.map((stock, index) => <StockLink key={index} stock={stock} onStock={onStock} />)}</div>}
            <EventEvidence event={event} evidenceById={evidenceById} manual={manual} />
          </div>
        </li>)}</ol>
      </section>}
      {cycle.uncertainty.length > 0 && <details className={styles.evidence}>
        <summary>待核实事项</summary>
        <ul>{cycle.uncertainty.map((item, index) => <li key={index}>{item}</li>)}</ul>
      </details>}
    </article>)}
  </div>
}

function IntradayTracking({ result, intraday, onStock }: { result: CycleDraft; intraday: Intraday; onStock: OpenStock }) {
  const { date, quotes } = intraday
  const ladder = intraday.ladder?.date === date ? intraday.ladder : null
  const stocks = new Map<string, Stock>()
  const add = (stock: Stock | null) => { if (stock && !stocks.has(stock.code)) stocks.set(stock.code, stock) }
  add(result.marketLeader)
  add(result.breakoutLeader ?? null)
  for (const cycle of result.cycles) {
    add(cycle.leader)
    for (const branch of cycle.branches) {
      add(branch.leader)
      branch.followers.forEach(add)
    }
  }
  const sealed = new Map(ladder?.stocks.map(row => [row.code, row]))
  const missed = new Map(ladder?.missedPromotions?.stocks.map(row => [row.code, row]))
  const broken = new Set(ladder?.brokenStocks?.map(row => row.code))
  const currentQuotes = new Map(quotes?.map(row => [row.code, row]))
  const ladderLabel = ladder?.meta.cacheState === 'stale' ? '缓存' : '当前'
  const observations = [...stocks.values()].flatMap(stock => {
    const current = sealed.get(stock.code)
    const promotion = missed.get(stock.code)
    const quote = currentQuotes.get(stock.code)
    const quoteObserved = quote?.changePct != null && Number.isFinite(quote.changePct)
    let boardObservation = null
    if (current) boardObservation = `${ladderLabel} ${current.boards} 板${current.breaks !== null && current.breaks > 0 ? ' · 开板后回封' : ''}`
    else if (broken.has(stock.code) || promotion?.broken === true) boardObservation = ladderLabel + '炸板未封'
    else if (promotion && ladder?.missedPromotions?.confirmed === false) boardObservation = ladderLabel + '尚未晋级'
    return boardObservation || quoteObserved ? [{ stock, boardObservation, quote: quoteObserved ? quote : undefined }] : []
  })
  return <section className={styles.intraday} aria-label="盘中观察">
    <h3>盘中观察 <small>{date}{ladder && ` · 梯队${ladder.meta.cacheState === 'stale' ? '已缓存 ' : '采集于 '}${dateTime(ladder.meta.fetchedAt)}`}</small></h3>
    {observations.length > 0 ? <ul>{observations.map(({ stock, boardObservation, quote }) => <li key={stock.code}>
      <StockLink stock={stock} onStock={onStock} />
      {boardObservation && <span>{boardObservation}</span>}
      {quote && <span title={quote.meta && [quote.meta.sourceName, dateTime(quote.meta.sourceTimestamp ?? quote.meta.fetchedAt)].join(' · ')}>
        {quote.meta?.cacheState === 'stale' ? '缓存涨跌幅' : '盘中涨跌幅'} {percent(quote.changePct)}
      </span>}
    </li>)}</ul> : <p className={styles.note}>当前梯队暂无已跟踪个股的可核实状态。</p>}
  </section>
}

export function TopicCyclePanel({ client, onStock, intraday, market, date, onDate, archiveDates = [], marketEvidence }: {
  client: HanaiClient
  onStock: OpenStock
  intraday?: Intraday | undefined
  market?: ComponentProps<typeof LeaderDesk>['market']
  date: string
  onDate: (date: string) => void
  archiveDates?: string[]
  marketEvidence?: ReactNode
}) {
  const [snapshot, setSnapshot] = useState<{ date: string; view: View } | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [revision, setRevision] = useState(0)
  const [busy, setBusy] = useState(false)
  const [editor, setEditor] = useState<string | null>(null)
  const [pane, setPane] = useState<keyof typeof panes>('judgement')
  const editorId = useId()

  useEffect(() => {
    const controller = new AbortController()
    let pending = false
    const refresh = async () => {
      if (pending) return
      pending = true
      try {
        const view = await client.call('topic-cycle.view', date ? { date } : {}, controller.signal)
        if (!controller.signal.aborted) {
          setSnapshot({ date, view })
          setLoadError(null)
        }
      } catch (error) {
        if (!controller.signal.aborted) setLoadError(error instanceof Error ? error.message : String(error))
      } finally {
        pending = false
      }
    }
    void refresh()
    const timer = window.setInterval(refresh, 15000)
    return () => { controller.abort(); window.clearInterval(timer) }
  }, [client, date, revision])

  const run = async (operation: () => Promise<CycleReview>) => {
    setBusy(true)
    setActionError(null)
    try {
      const review = await operation()
      setSnapshot(current => current?.date === date ? { ...current, view: {
        ...current.view,
        selected: review,
        latestConfirmed: review.status === 'confirmed'
          && (!current.view.latestConfirmed || current.view.latestConfirmed.date < review.date)
          ? review : current.view.latestConfirmed,
      } } : current)
      setRevision(value => value + 1)
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  const view = snapshot?.date === date ? snapshot.view : null
  const selected = view?.selected
  const confirmed = selected?.status === 'confirmed' ? selected : date ? null : view?.latestConfirmed
  const manual = view?.manualReview
  const draft = selected?.status === 'draft' && selected.result ? selected : null
  const reviewFor = (role: LeaderRole) => [manual, confirmed, draft].find(review => review?.result?.[role])
  const marketLeaderReview = reviewFor('marketLeader')
  const breakoutLeaderReview = reviewFor('breakoutLeader')
  const targetDate = date || selected?.date || view?.latestClosingDate
  const generateDate = view?.canGenerate && (!selected || selected.status === 'failed') ? targetDate : null
  const archive = snapshot?.view
  const options = [...new Set([...archiveDates, ...(archive?.dates ?? []), archive?.latestClosingDate, date]
    .filter((day): day is string => typeof day === 'string' && day.length > 0))].sort().reverse()
  const selectDate = (next: string) => {
    onDate(next)
    setEditor(null)
    setActionError(null)
    setLoadError(null)
  }
  const confirm = () => {
    const original = draft?.result
    if (!original) return
    void run(async () => {
      const result = editor === null ? original : cycleDraftSchema.parse(JSON.parse(editor))
      if (result.date !== original.date) throw new Error('复盘日期需与草稿日期一致。')
      const review = await client.call('topic-cycle.confirm', { draft: result })
      setEditor(null)
      setPane('archive')
      return review
    })
  }
  const bj = new Date(Date.now() + 8 * 3_600_000)
  const preopen = !date && bj.getUTCDay() > 0 && bj.getUTCDay() < 6 && (bj.getUTCHours() * 60 + bj.getUTCMinutes()) < 565
  const archivedNode = verifiedNodes(manual ?? confirmed)[0]

  const navigation = <div className={styles.navigation} role="group" aria-label="情绪周期视图">
    {(Object.keys(panes) as Array<keyof typeof panes>).map(key => <button type="button" key={key}
      aria-pressed={pane === key} onClick={() => setPane(key)}>
      {panes[key]}{key === 'review' && selected && selected.status !== 'confirmed' &&
        <span className={styles.reviewBadge}>{statusLabel[selected.status]}</span>}
    </button>)}
  </div>
  const roles = <div className={styles.anchors}>
    <LeaderAnchor role="marketLeader" review={marketLeaderReview} onStock={onStock} />
    <LeaderAnchor role="breakoutLeader" review={breakoutLeaderReview} onStock={onStock} />
  </div>
  const tracked = manual?.result ?? confirmed?.result
  const intradayEvidence = !date && tracked && intraday && (intraday.ladder || intraday.quotes?.length)
    ? <details className={styles.evidence}>
      <summary>跟踪个股行情</summary>
      <IntradayTracking result={tracked} intraday={intraday} onStock={onStock} />
    </details> : undefined

  return <section className={styles.panel} aria-label="题材周期复盘">
    <header className={styles.toolbar}>
      <h1>情绪周期</h1>
      <label>复盘日期 <select value={date} disabled={busy} onChange={event => selectDate(event.target.value)}>
        <option value="">最新</option>
        {options.map(day => <option value={day} key={day}>{day}</option>)}
      </select></label>
    </header>
    {loadError && <p role="alert" className={styles.error}>复盘读取失败 · {loadError} <button className={ui.button} type="button" onClick={() => setRevision(value => value + 1)}>重试</button></p>}
    {actionError && <p role="alert" className={styles.error}>{actionError}</p>}
    {!view && !loadError && <p role="status" className={styles.note}>读取题材周期…</p>}
    {view && <LeaderDesk view={view} confirmed={confirmed} date={date} today={beijingMarketDate()} market={market}
      liveDate={!date ? intraday?.date : undefined} preopen={preopen} onDate={selectDate}
      roles={roles} navigation={navigation} intradayEvidence={intradayEvidence}
      onStock={row => <StockLink stock={row} onStock={onStock} />}
      archived={archivedNode ? { name: archivedNode.cycle, kind: archivedNode.event.kind, date: archivedNode.event.date, fact: archivedNode.change, next: archivedNode.next, manual: Boolean(manual) } : undefined}>
      {pane === 'archive' ? <div className={styles.archive}>
        <section className={styles.sheet} aria-label="已确认的周期">
          <h2>周期档案{confirmed && <small>{confirmed.date} · 已人工确认</small>}</h2>
          {manual && <details className={styles.evidence} open>
            <summary>人工补录 · {manual.date}</summary>
            <CycleResult review={manual} onStock={onStock} />
          </details>}
          {confirmed ? <>
            <CycleNodes review={confirmed} onStock={onStock} />
            <details className={styles.evidence}><summary>完整周期与分支接力</summary>
              <CycleResult review={confirmed} onStock={onStock} />
            </details>
          </> : !manual && <p className={styles.note}>所选日期暂无已确认复盘。</p>}
        </section>
        {marketEvidence}
      </div> : pane === 'review' ? <section className={styles.sheet} aria-label="模型复盘">
        <h2>模型复盘{targetDate && <small>{targetDate}</small>}</h2>
        {selected && <p role="status" className={styles.status}>
          {statusLabel[selected.status]}{selected.model && <span>{selected.model.model}</span>}{selected.error && <span>{selected.error}</span>}
        </p>}
        {generateDate ? <button className={ui.buttonPrimary} type="button" disabled={busy} onClick={() => void run(() => client.call('topic-cycle.generate', { date: generateDate }))}>
          {selected?.status === 'failed' ? '重试起草' : '生成复盘草稿'}
        </button> : !selected && <p className={styles.note}>北京时间 16:10 后，有可核实的收盘行情即可起草。</p>}
        {draft && <>
          {(draft.result?.marketLeader || draft.result?.breakoutLeader) && <div className={styles.anchors}>
            {draft.result?.marketLeader && <LeaderAnchor role="marketLeader" review={draft} onStock={onStock} preview />}
            {draft.result?.breakoutLeader && <LeaderAnchor role="breakoutLeader" review={draft} onStock={onStock} preview />}
          </div>}
          <CycleNodes review={draft} onStock={onStock} preview />
          <CycleResult review={draft} onStock={onStock} />
          {editor !== null && <div className={styles.editor}>
            <label htmlFor={editorId}>修订草稿 JSON</label>
            <textarea id={editorId} value={editor} spellCheck={false} onChange={event => setEditor(event.target.value)} />
          </div>}
          <div className={styles.actions}>
            <button className={ui.button} type="button" disabled={busy} onClick={() => setEditor(editor === null ? JSON.stringify(draft.result, null, 2) : null)}>
              {editor === null ? '修订草稿' : '取消修订'}
            </button>
            <button className={ui.buttonPrimary} type="button" disabled={busy} onClick={confirm}>确认复盘</button>
          </div>
        </>}
      </section> : null}
    </LeaderDesk>}
  </section>
}
