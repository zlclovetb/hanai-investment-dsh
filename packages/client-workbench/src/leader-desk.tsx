import { useId, type ReactNode } from 'react'
import type { LeaderCheckpoint, LeaderDecision } from '../../contracts/src/leader-decision.ts'
import type { CycleEndpoints, CycleReview } from '../../contracts/src/topic-cycle.ts'
import { dateTime } from './format.ts'
import styles from './leader-desk.module.css'

type Candidate = LeaderDecision['candidates'][number]
type Journal = LeaderDecision['journal'][number]
type Alert = LeaderDecision['alerts'][number]
type View = CycleEndpoints['topic-cycle.view']['response']
type Evidence = NonNullable<View['decisionEvidence']>[number]
type EvidenceIndex = { sources: Map<string, Evidence>; facts: Map<string, unknown> }
type MarketContext = { date: string; label: string; observedAt: string; cached: boolean; intraday: boolean }
const confidence = { 高: 3, 中: 2, 低: 1 }
const stages = { DORMANT: '试错', IGNITION: '启动', MAIN_RALLY: '主升', DIFFUSION: '扩散', DIVERGENCE: '分歧', EBB: '退潮' }
const advancingStages = new Set(['启动', '主升', '扩散', '高潮', '修复'])
const changePriority = new Map([['撤销', 4], ['降级', 4], ['下调', 3], ['上调', 2], ['纳入试错', 1]])
const metrics: Record<string, string> = {
  boards: '连板', space_boards: '市场空间', turnover_pct: '换手率', breaks: '开板次数', first_seal_minute: '首次封板',
  auction_prev_pct: '竞价量占昨全天', open30_change_pct: '开盘30分钟涨跌幅', volume_ma5_ratio: '成交量 / 前5日均量',
  volume_prev_ratio: '成交量 / 昨日', theme_limit_down: '题材跌停家数', theme_followers: '跟随家数',
  followers_delta: '跟随家数变化', followers_shrink_days: '跟随连续收缩天数', promoted: '晋级',
  failed_unsealed: '断板未回封', first_break: '首次断板', resealed: '开板后回封', countertrend_limit_up: '逆势封板',
  capacity_breakdown: '容量放量破位', followers_limit_down_cluster: '补涨批量跌停',
  market_leader_holds: '总龙仍有承接', front_row_big_loss: '前排中大阴', mid_tier_loss_cluster: '中位股集体负反馈',
  prev_broken: '昨日断板', prev_long_leg: '昨日大长腿涨停', prev_late_seal: '昨日尾盘封板',
  prev_high_volume_one_word: '昨日放量一字', change_pct: '涨跌幅', amount: '成交额', amount_ma5_ratio: '成交额 / 前5日均值',
}
const key = (row: Candidate) => row.theme + '/' + row.code
const journalTheme = (row: Journal) => row.key.slice(0, row.key.lastIndexOf('/'))
const shortDate = (date: string) => date.slice(5).replace('-', '.')
const arrow = (action?: string) => action === '上调' ? '↑' : ['下调', '降级', '撤销'].includes(action ?? '') ? '↓' : '→'
const factValue = (field: string, value: boolean | number) => typeof value === 'boolean' ? (value ? '是' : '否')
  : field === 'first_seal_minute' ? String(Math.floor(value / 60)).padStart(2, '0') + ':' + String(value % 60).padStart(2, '0')
  : field.endsWith('_pct') ? value + '%' : String(value)
function conditionText({ metric, op, value }: Candidate['falsifiers'][number]['all'][number]) {
  const label = metrics[metric] ?? metric
  if (typeof value === 'boolean' && op === '==') return value ? label : label + '未出现'
  return `${label} ${op === '>=' ? '≥' : op === '<=' ? '≤' : op === '==' ? '=' : op} ${factValue(metric, value)}`
}
const evidenceOf = (entry: Journal) => [...new Set([
  ...(entry.evidence ?? []), ...(entry.checks?.flatMap(check => check.evidence) ?? []),
  ...Object.values(entry.metrics ?? {}).flatMap(fact => fact.evidence),
])]

function EvidenceList({ ids, evidence, date }: { ids: string[]; evidence: EvidenceIndex; date: string }) {
  return ids.length > 0 ? <ul className={styles.sources}>{ids.map(id => {
    const source = evidence.sources.get(date + '/' + id)
    const fact = evidence.facts.get(date + '/' + id)
    return <li key={id}>{source?.url && /^https?:\/\//i.test(source.url)
      ? <a href={source.url} target="_blank" rel="noreferrer">{source.label}</a>
      : source?.label ?? id}{source && <small>{source.sourceName} · {dateTime(source.observedAt)}</small>}
      {fact !== undefined && <details><summary>查看冻结原始数据</summary><pre>{JSON.stringify(fact, null, 2)}</pre></details>}
    </li>
  })}</ul> : null
}

function Audit({ entry, day, evidence }: { entry: Journal; day: LeaderDecision; evidence: EvidenceIndex }) {
  return <details className={styles.audit}>
    <summary><time dateTime={day.date}>{shortDate(day.date)}</time> <b>{entry.action}</b>
      {entry.previousConfidence && entry.confidence && entry.previousConfidence !== entry.confidence && ` ${entry.previousConfidence}→${entry.confidence}`} · {entry.reason}</summary>
    {entry.checks?.map(check => <p key={check.condition}>{check.condition} · {check.result}{check.missing.length > 0 && ` · 缺 ${check.missing.map(id => metrics[id] ?? id).join('、')}`}</p>)}
    {entry.weakToStrong && <p>弱转强 · {entry.weakToStrong}　封板质量 · {entry.sealQuality}</p>}
    <EvidenceList ids={evidenceOf(entry)} evidence={evidence} date={day.date} />
    {entry.metrics && <dl className={styles.auditFacts}>{Object.entries(entry.metrics).map(([field, fact]) =>
      <div key={field}><dt>{metrics[field] ?? field}</dt><dd>{factValue(field, fact.value)} · {dateTime(fact.observedAt)}</dd></div>)}</dl>}
  </details>
}

function alertAction(alert: Alert) { return alert.level === 'L3' ? alert.action : alert.verifyNext }

function checkpointFact(checkpoint: LeaderCheckpoint | undefined, code: string) {
  return checkpoint?.resealed.includes(code) ? '开板后回封' : checkpoint?.sealed.includes(code) ? null
    : checkpoint?.broken.includes(code) ? '炸板未回封' : checkpoint?.pending.includes(code) ? '尚未晋级' : null
}

function nextVerification(candidate: Candidate | undefined) {
  const rule = candidate?.falsifiers[0]
  return rule && rule.all.map(conditionText).join(' 且 ')
}

function CandidateCard({ row, day, current, evidence, onStock, checkpoint, preopen }: {
  row: Candidate; day: string; current?: Journal | undefined; evidence: EvidenceIndex;
  onStock: (row: Pick<Candidate, 'code' | 'name'>) => ReactNode; checkpoint?: LeaderCheckpoint | undefined; preopen: boolean
}) {
  const facts = Object.entries(current?.metrics ?? {})
    .sort(([left], [right]) => Number(['boards', 'promoted', 'followers_delta', 'resealed'].includes(right)) - Number(['boards', 'promoted', 'followers_delta', 'resealed'].includes(left)))
    .slice(0, 3)
  const deviation = checkpointFact(checkpoint, row.code)
  const conditions = <section className={styles.falsifiers} aria-label="证伪条件">
    <h4>证伪条件</h4><ul>{row.falsifiers.map(rule => <li key={rule.label}>
      {rule.all.map(conditionText).join(' 且 ')} · <b>{rule.action}</b></li>)}</ul>
  </section>
  return <article className={styles.candidate}>
    <header><h3>{onStock(row)}</h3><span data-tone={arrow(current?.action)}>{arrow(current?.action)} {row.confidence}确信度</span></header>
    <p className={styles.muted}>{row.role} · 权重 {row.weight}/5{current && ` · ${current.action}`}</p>
    {deviation && checkpoint && <p className={styles.deviation}>盘中偏离 · {deviation} <small>{dateTime(checkpoint.observedAt)}</small></p>}
    {preopen && conditions}
    <section><h4>{shortDate(day)} 收盘证据</h4>
      {facts.length ? <ul>{facts.map(([field, fact]) => <li key={field}><details>
        <summary>{metrics[field] ?? field} · {factValue(field, fact.value)}</summary>
        <EvidenceList ids={fact.evidence} evidence={evidence} date={day} />
      </details></li>)}</ul> : <p className={styles.muted}>该候选暂无可展示的当日证据。</p>}
    </section>
    {!preopen && conditions}
  </article>
}

export function LeaderDesk({ view, confirmed, date, today, liveDate, preopen, market, onStock, onDate, archived, roles, navigation, intradayEvidence, children }: {
  view: View; confirmed?: CycleReview | null | undefined; date: string; today: string
  liveDate?: string | undefined; preopen: boolean; market?: MarketContext | undefined
  onStock: (row: Pick<Candidate, 'code' | 'name'>) => ReactNode; onDate: (date: string) => void
  archived?: { name: string; kind: string; date: string; fact: string; next: string; manual: boolean } | undefined
  roles: ReactNode
  navigation: ReactNode
  intradayEvidence?: ReactNode
  children?: ReactNode
}) {
  const scope = useId()
  const reports = (view.decisions ?? []).filter(report => date ? report.date <= date : liveDate ? report.date < liveDate : report.date <= today)
  const focusDate = date || today
  const latest = date ? reports.find(report => report.date === date) : reports[0]
  const settled = latest?.date === focusDate ? latest : undefined
  const checkpoint = liveDate ? view.checkpoint : undefined
  const manual = view.manualReview
  const manualCycles = manual?.result?.cycles ?? []
  const cycles = [...manualCycles, ...(confirmed?.result?.cycles ?? []).filter(cycle => !manualCycles.some(item => item.id === cycle.id || item.name === cycle.name))]
  const themes = [...new Set([
    ...Object.keys(latest?.themes ?? {}),
    ...(latest?.journal.map(journalTheme).filter(Boolean) ?? []),
    ...(latest?.alerts.map(row => row.theme) ?? []),
    ...(latest?.candidates.map(row => row.theme) ?? []),
    ...(latest?.observations.map(row => row.theme) ?? []),
    ...cycles.map(row => row.name),
  ])]
  const evidence: EvidenceIndex = {
    sources: new Map(view.decisionEvidence?.map(row => [row.reviewDate + '/' + row.id, row])),
    facts: new Map(view.decisionFacts?.map(fact => [fact.reviewDate + '/' + fact.id, fact.data])),
  }
  const previous = reports.find(report => report.date === latest?.previousDate && report.date < latest.date)
  const topics = themes.map((name, index) => {
    const cycle = cycles.find(row => row.name === name)
    const context = latest?.themes?.[name]
    const earlier = previous?.themes?.[name]
    const candidates = (latest?.candidates.filter(row => row.theme === name) ?? [])
      .toSorted((a, b) => confidence[b.confidence] - confidence[a.confidence] || b.weight - a.weight)
    const observations = latest?.observations.filter(row => row.theme === name) ?? []
    const entries = (latest?.journal.filter(row => journalTheme(row) === name) ?? [])
      .toSorted((a, b) => (changePriority.get(b.action) ?? 0) - (changePriority.get(a.action) ?? 0))
    const changes = entries.filter(row => changePriority.has(row.action))
    const primary = changes[0]
    const affected = [...candidates, ...(previous?.candidates ?? []), ...(previous?.observations ?? [])]
      .find(row => key(row) === primary?.key)
    const following = latest?.alerts.find(row => row.theme === name && row.level === 'L2' && row.code === affected?.code)
    const themeCheck = following ?? latest?.alerts.find(row => row.theme === name && row.level === 'L2')
    const next = themeCheck?.level === 'L2' ? themeCheck.verifyNext : nextVerification(candidates[0]) ?? cycle?.takeaway
    const phaseChanged = context && earlier && context.state !== earlier.state
    const transition = phaseChanged ? stages[earlier.state] + ' → ' + stages[context.state] : undefined
    const frames = new Map<string, { stage: string; rule?: string; evidence?: string[] }>()
    for (const day of view.stages ?? []) {
      if (day.date > focusDate || (liveDate && day.date >= liveDate)) continue
      const phase = day.cycles.find(row => cycle ? row.id === cycle.id : row.name === name)
      if (phase) frames.set(day.date, { stage: phase.stage })
    }
    for (const day of reports) {
      const phase = day.themes?.[name]
      if (phase) frames.set(day.date, { stage: stages[phase.state], ...(phase.rule ? { rule: phase.rule } : {}), evidence: phase.evidence })
    }
    const userCycle = manualCycles.find(row => row.name === name)
    if (manual && userCycle) frames.set(manual.date, { stage: userCycle.stage })
    const timeline = [...frames].sort(([a], [b]) => a.localeCompare(b))
    const stage = timeline.at(-1)?.[1].stage ?? cycle?.stage ?? '阶段待核验'
    const deviation = candidates.flatMap(row => {
      const fact = checkpointFact(checkpoint, row.code)
      return fact ? [{ row, fact }] : []
    })
    const closeChange = settled && (transition && context ? {
      facts: context.rule ?? context.conclusion,
      decision: transition,
      refs: context.evidence,
      next,
      priority: context.state === 'EBB' ? 6 : 5,
      more: changes.length,
    } : primary ? {
      facts: primary.reason,
      decision: `${affected?.name ?? primary.key.slice(name.length + 1)} · ${primary.action}${primary.previousConfidence && primary.confidence && primary.previousConfidence !== primary.confidence ? ` · ${primary.previousConfidence}→${primary.confidence}` : ''}`,
      refs: evidenceOf(primary),
      next: following?.level === 'L2' ? following.verifyNext
        : (primary.action !== '撤销' ? nextVerification(affected) : undefined) ?? cycle?.takeaway,
      priority: changePriority.get(primary.action) ?? 0,
      more: changes.length - 1,
    } : undefined)
    return { id: scope + '-topic-' + index, name, cycle, context, stage, candidates, observations, next, timeline, deviation, closeChange }
  })
  const risks = [...new Map(latest?.alerts.filter(row => row.level === 'L3').map(row => [row.theme + '/' + row.reason, row])).values()]
  const closedChanges = topics.flatMap(topic => topic.closeChange ? [{ id: topic.id, name: topic.name, ...topic.closeChange }] : [])
    .sort((a, b) => Number(risks.some(risk => risk.theme === b.name)) - Number(risks.some(risk => risk.theme === a.name)) || b.priority - a.priority)
  const observed = topics.filter(topic => topic.deviation.length > 0)
  const tracked = new Set(topics.flatMap(topic => topic.candidates.map(row => row.code)))
  const covered = checkpoint ? new Set([...checkpoint.sealed, ...checkpoint.resealed, ...checkpoint.broken, ...checkpoint.pending]
    .filter(code => tracked.has(code))).size : 0
  const missing = [...new Set(settled?.journal.flatMap(row =>
    row.checks?.filter(check => check.result === '待核验').flatMap(check => check.missing) ?? []))]
  const marketMatches = market && (date ? market.date === date && !market.intraday : liveDate ? market.date === liveDate : true)
  const timeLabel = date ? '历史回看' : liveDate ? '盘中观察' : preopen ? '盘前待验证' : settled ? '收盘已更新' : '等待当日收盘清算'
  const basisDate = latest?.date ?? confirmed?.date
  const marketLeader = (manual?.result?.marketLeader ?? confirmed?.result?.marketLeader)?.code
  const focus = topics.find(topic => topic.name === manualCycles[0]?.name)
    ?? topics.find(topic => topic.name === closedChanges[0]?.name)
    ?? observed[0]
    ?? topics.find(topic => marketLeader && topic.cycle?.leader?.code === marketLeader)
    ?? topics.find(topic => advancingStages.has(topic.stage))
    ?? topics[0]
  const headline = focus?.closeChange?.facts ?? focus?.context?.conclusion ?? focus?.cycle?.takeaway
  const orderedTopics = focus ? [focus, ...topics.filter(topic => topic !== focus)] : topics
  const lastNode = closedChanges.length === 0 && observed.length === 0 && archived && archived.date <= focusDate ? archived : undefined

  return <div className={styles.desk}>
    {risks.length > 0 && <div className={styles.risks} role="note" aria-label="最高级提示">
      {risks.map((risk, i) => <div className={styles.critical} key={risk.theme + ':' + i}>
        <b>L3 · {risk.theme}</b><strong>{risk.reason}</strong><span>{alertAction(risk)}</span><small>{latest?.date} 收盘记录</small>
      </div>)}
    </div>}
    <header className={styles.status}>
      <div className={styles.statusCopy}><p className={styles.eyebrow}>{timeLabel}</p>
        <h2>{focus?.name ?? '等待题材确认'} {focus && <span className={styles.stage}>{focus.stage}</span>}</h2>
        {headline && <p className={styles.conclusion}>{headline}</p>}
        <p className={styles.muted}>
          {manual ? `人工补录 · ${manual.date}` : basisDate ? `判断依据 · ${basisDate} 收盘` : '暂无收盘判断'}
          {!manual && latest && confirmed && latest.date !== confirmed.date && ` · 题材复盘 ${confirmed.date}`}
          {marketMatches && ` · ${market.label} · ${market.cached ? '缓存' : '快照'} ${dateTime(market.observedAt)}`}
          {checkpoint && ` · 个股检查点 ${dateTime(checkpoint.observedAt)}`}
        </p>
      </div>
      {roles}
    </header>
    {navigation}
    {view.decisionError && <p role="alert" className={styles.muted}>{view.decisionError}</p>}

    {children ?? <div className={styles.columns}>
      <section className={styles.feed} aria-label={date ? '当日改判' : '今日改判'}>
        <h2>{date ? '当日节点与改判' : '关键节点与改判'}</h2>
        {lastNode && <article className={styles.node}>
          <p className={styles.eyebrow}>{lastNode.manual ? '人工补录节点' : '最近已确认节点'} · {lastNode.date}{lastNode.manual && '前后'} · {lastNode.name}</p>
          <h3>{lastNode.kind}</h3>
          <p>{lastNode.fact}</p><p className={styles.muted}>跟踪要点 · {lastNode.next}</p>
        </article>}
        {liveDate ? observed.length ? observed.map(topic => <article className={styles.node} key={topic.name}>
          <h3>{topic.name} <span className={styles.stage}>盘中偏离</span></h3>
          <p>{topic.deviation.map(item => item.row.name + ' · ' + item.fact).join('；')}</p>
          <p className={styles.muted}>收盘后复核 · {topic.next ?? '待补下一验证条件'}</p>
        </article>) : <p className={styles.empty}>{tracked.size === 0 ? '暂无可与盘中检查点对照的已归档候选。'
          : !checkpoint ? '等待可核验的盘中检查点。'
            : covered === 0 ? '本检查点暂未覆盖已跟踪候选。' : '本检查点已覆盖的候选暂无偏离。'}</p>
          : closedChanges.length > 0 ? closedChanges.map(change => <article className={styles.node} key={change.name}>
            <h3>{change.name}</h3>
            <dl className={styles.decisionLines}>
              <dt>看到</dt><dd>{change.facts}</dd>
              <dt>改判</dt><dd><strong>{change.decision}</strong></dd>
              <dt>下次验证</dt><dd>{change.next ?? '待补下一验证条件'}</dd>
            </dl>
            <a className={styles.threadLink} href={'#' + change.id} onClick={() => {
              const target = document.getElementById(change.id)
              if (target instanceof HTMLDetailsElement) target.open = true
            }}>查看题材详情{change.more > 0 ? `及另外 ${change.more} 条调整` : ''}</a>
            {change.refs.length > 0 && settled && <details className={styles.audit}>
              <summary>改判证据</summary><EvidenceList ids={change.refs} evidence={evidence} date={settled.date} />
            </details>}
          </article>) : !lastNode && <p className={styles.empty}>{settled ? (date ? '当日无改判。' : '今日无改判。')
            : date ? '该日暂无收盘清算。' : '今日尚无收盘清算。'}</p>}
        {missing.length > 0 && <p className={styles.muted}>待核验证据 · {missing.map(metric => metrics[metric] ?? metric).join('、')}</p>}
        {checkpoint && tracked.size > covered && covered > 0 && <p className={styles.muted}>检查点覆盖 {covered}/{tracked.size} 只候选。</p>}
        {intradayEvidence}
      </section>

      <section className={styles.topics} aria-label="跟踪题材">
        <h2>跟踪题材</h2>
        {!topics.length && <p className={styles.empty}>暂无可核验的题材记录。</p>}
        {orderedTopics.map(topic => <details className={styles.topic} key={topic.name} id={topic.id}>
          <summary><b>{topic.name}</b><span className={styles.stage}>{topic.stage}</span>
            {(topic !== focus || topic.next !== headline) && <span className={styles.next}>{topic.next ?? '待补下一验证条件'}</span>}</summary>
          <div className={styles.topicBody}>
            {topic.context?.conclusion && <p>{topic.context.conclusion}</p>}
            {topic.cycle && <section aria-label="题材角色">
              {topic.cycle.leader && <div>题材龙头 · {onStock(topic.cycle.leader)}</div>}
              {topic.cycle.branches.map(branch => <div key={branch.name}>
                <b>{branch.name}</b>{branch.leader && onStock(branch.leader)}
                <p>{branch.change}</p>
                {branch.followers.length > 0 && <div className={styles.followers}>{branch.followers.map(stock => <span key={stock.code}>{onStock(stock)}</span>)}</div>}
              </div>)}
            </section>}
            {latest && topic.candidates.length > 0 && <section aria-label="候选判断">
              <h3>候选与证伪</h3>
              {topic.candidates.map(row => <CandidateCard key={key(row)} row={row} day={latest.date}
                current={latest.journal.find(entry => entry.key === key(row))} evidence={evidence}
                onStock={onStock} checkpoint={checkpoint} preopen={preopen} />)}
            </section>}
            {topic.observations.length > 0 && <section className={styles.observation}>
              <h3>框架外观察</h3>
              {topic.observations.map(row => <div key={key(row)}>{onStock(row)} {row.verification} · {row.reason}
                <small>次日验证 · {row.admitWhen.map(conditionText).join(' 且 ')}</small></div>)}
            </section>}
            {topic.timeline.length > 0 && <section className={styles.timeline} aria-label="周期状态时间轴">
              <h3>周期时间轴</h3>
              <ol>{topic.timeline.map(([day, item], index) => <li key={day} data-switch={index === 0 || topic.timeline[index - 1]?.[1].stage !== item.stage}>
                <button className={styles.dateLink} type="button" aria-label={`查看 ${day} 周期状态`} onClick={() => onDate(day)}>
                  <time dateTime={day}>{shortDate(day)}</time>
                </button><b>{item.stage}</b>
                {item.rule && <details><summary>{item.rule}</summary><EvidenceList ids={item.evidence ?? []} evidence={evidence} date={day} /></details>}
              </li>)}</ol>
            </section>}
            {reports.map(report => {
              const entries = report.journal.filter(item => journalTheme(item) === topic.name)
              const alerts = report.alerts.filter(item => item.theme === topic.name)
              return entries.length || alerts.length ? <details className={styles.audit} key={report.date}>
                <summary>{report.date} · 纠错与提示</summary>
                {entries.map(entry => <Audit key={entry.key} entry={entry} day={report} evidence={evidence} />)}
                {alerts.map((alert, i) => <details className={styles.notice} key={i} data-level={alert.level}>
                  <summary>{alert.reason} · {alertAction(alert)}</summary>
                  <EvidenceList ids={alert.evidence} evidence={evidence} date={report.date} />
                </details>)}
              </details> : null
            })}
          </div>
        </details>)}
      </section>
    </div>}
  </div>
}
