import { useEffect, useId, useRef, useState, type ReactNode, type SyntheticEvent } from 'react'
import type { SearchResult } from '../../contracts/src/index.ts'
import type { MarketLadderData } from '../../contracts/src/market-ladder.ts'
import { LADDER_BOARD_TYPE_METHOD, ladderThemes, limitBoardType } from '../../contracts/src/market-ladder.ts'
import { PanelHead } from './panel-head.tsx'
import { MarketPanelStatus } from './market-panel-status.tsx'
import styles from './styles.module.css'

const percentage = (numerator: number | null | undefined, denominator: number | null | undefined) => numerator == null || denominator == null || denominator === 0 ? '—' : `${(numerator / denominator * 100).toFixed(1)}%`

export function MarketLadderPanels({ data, historical, failed, pending, onStock }: {
  data: MarketLadderData | null; historical: boolean; failed: boolean; pending: boolean; onStock: (stock: SearchResult) => void
}) {
  const ladderBody = useRef<HTMLDivElement>(null)
  const [columns, setColumns] = useState(1)
  const [expandedBoards, setExpandedBoards] = useState<ReadonlySet<number>>(new Set())
  const [themesExpanded, setThemesExpanded] = useState(false)
  const tooltipId = useId()
  const [tooltip, setTooltip] = useState<{ key: string; anchor: HTMLElement; content: ReactNode } | null>(null)
  const openStock = ({ code, name }: Pick<SearchResult, 'code' | 'name'>) => {
    const shanghai = code.startsWith('6')
    onStock({ secId: `${shanghai ? '1' : '0'}.${code}`, code, name, exchange: shanghai ? 'SH' : 'SZ', pinyinFull: '', pinyinInitial: '', price: null, changePct: null })
  }
  const hideTooltip = () => setTooltip(null)
  const tooltipProps = (key: string, content: ReactNode) => {
    const show = (event: SyntheticEvent<HTMLElement>) => setTooltip({ key, anchor: event.currentTarget, content })
    return {
      'aria-describedby': tooltip?.key === key ? tooltipId : undefined,
      onMouseEnter: show, onMouseLeave: hideTooltip,
      onFocus: show, onBlur: hideTooltip,
    }
  }
  useEffect(() => { setExpandedBoards(new Set()); setThemesExpanded(false); setTooltip(null) }, [data?.date, historical])
  const stocks = data?.stocks ?? []
  const highest = stocks.length === 0 ? 0 : Math.max(...stocks.map(row => row.boards))
  const missed = data?.missedPromotions
  const displayHighest = Math.max(highest, ...(missed?.stocks.map(stock => stock.boards + 1) ?? []))
  useEffect(() => {
    const grid = ladderBody.current?.querySelector<HTMLElement>(`.${styles['ladderStocks']}`)
    if (!grid) return
    const measure = () => {
      const tracks = getComputedStyle(grid).gridTemplateColumns.match(/-?\d+(?:\.\d+)?px/g)
      setColumns(Math.max(1, tracks?.length ?? 0))
    }
    measure()
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure)
    observer?.observe(grid)
    window.addEventListener('resize', measure)
    return () => {
      observer?.disconnect()
      window.removeEventListener('resize', measure)
    }
  }, [displayHighest])
  const first = stocks.filter(row => row.boards === 1)
  const themes = data === null ? [] : ladderThemes(data)
  const yesterday = data?.yesterdayPerformance
  const change = (value: number | null | undefined) => value == null ? '—' : `${value > 0 ? '+' : ''}${value.toFixed(2)}%`
  const changeStyle = (value: number | null | undefined) => value == null || value === 0 ? styles['flat'] : value > 0 ? styles['up'] : styles['down']
  const empty = historical ? '该日期未保存涨停梯队' : pending ? '涨停梯队加载中' : '涨停梯队暂不可用'
  const status = (topic: boolean) => {
    const issues = data?.issues.filter(issue => /题材/.test(issue) === topic) ?? []
    if (!topic && !historical && data?.missedPromotions === null) issues.push('昨日梯队明细暂不可用')
    return <MarketPanelStatus historical={historical} items={[{ label: topic ? '题材归因' : '涨停池', meta: data?.meta, failed: failed || (!historical && issues.length > 0), ...(issues.length ? { message: issues.join('；') } : {}) }]} />
  }
  return <div className={`${styles['dashboardMainGrid']} ${styles['ladderGrid']}`}>
    <article className={`${styles['card']} ${styles['ladderCard']}`} aria-label="涨停梯队" onScrollCapture={hideTooltip} onKeyDown={event => { if (event.key === 'Escape') hideTooltip() }}>
      <PanelHead title="涨停梯队" hint="连续涨停 · 池内统计" meta={status(false)} />
      <dl className={styles['ladderSummary']} aria-label="今日梯队摘要">
        <div className={styles['ladderSummaryTitle']}><dt>今日梯队</dt><dd hidden>情绪摘要</dd></div>
        <div><dt>涨停</dt><dd>{data === null ? '—' : stocks.length}<small> 只</small></dd></div>
        <div><dt>连板</dt><dd>{data === null ? '—' : stocks.length - first.length}<small> 只</small></dd></div>
        <div><dt>最高板</dt><dd>{data === null ? '—' : highest}<small> 板</small></dd></div>
        <div tabIndex={0} {...tooltipProps('promotion', '昨日涨停股中，今日仍涨停的比例；零样本时不计算')}><dt>晋级率</dt><dd>{percentage(data?.promotion?.promoted, data?.promotion?.eligible)}{data?.promotion && <small> · {data.promotion.promoted}/{data.promotion.eligible}</small>}</dd></div>
        <div tabIndex={0} {...tooltipProps('broken', '当前未封板的炸板股 ÷（当前涨停股＋当前未封板的炸板股），不按炸板次数累计')}><dt>炸板率</dt><dd>{percentage(data?.broken, data?.broken == null ? null : data.broken + stocks.length)}</dd></div>
      </dl>
      <dl className={styles['ladderSummary']} aria-label="昨日涨停今日表现">
        <div className={styles['ladderSummaryTitle']}><dt>昨日涨停</dt><dd hidden>昨日涨停股的今日涨幅</dd></div>
        <div><dt>样本</dt><dd>{yesterday?.sample ?? '—'}<small> 只</small></dd></div>
        <div><dt>平均</dt><dd className={changeStyle(yesterday?.average)}>{change(yesterday?.average)}</dd></div>
        <div><dt>中位</dt><dd className={changeStyle(yesterday?.median)}>{change(yesterday?.median)}</dd></div>
        <div tabIndex={0} {...tooltipProps('yesterday', yesterday ? `翻红 ${yesterday.up}只 · 翻绿 ${yesterday.down}只 · 平盘 ${yesterday.flat}只` : '昨日样本的今日涨幅暂不可用')}><dt>翻红率</dt><dd>{percentage(yesterday?.up, yesterday?.sample)}{yesterday && <small> · {yesterday.up}/{yesterday.sample}</small>}</dd></div>
      </dl>
      <div ref={ladderBody} className={styles['ladderBody']} tabIndex={0} aria-label="涨停梯队明细">
        {data === null ? <p className={styles['ladderEmpty']}>{empty}</p> : displayHighest === 0 ? <p className={styles['ladderEmpty']}>当前涨停池为空</p> : Array.from({ length: displayHighest }, (_, i) => displayHighest - i).map(board => {
          const rows = stocks.filter(stock => stock.boards === board)
          const missedRows = missed?.stocks.filter(stock => stock.boards + 1 === board) ?? []
          const expanded = expandedBoards.has(board)
          const collapsedLimit = 2 * columns
          const hidden = rows.length + missedRows.length - collapsedLimit
          const visibleRows = expanded ? rows : rows.slice(0, collapsedLimit)
          const visibleMissed = expanded ? missedRows : missedRows.slice(0, Math.max(0, collapsedLimit - rows.length))
          return <section className={styles['ladderRow']} key={board} aria-label={board === 1 ? '首板梯队' : `${board}板梯队`}>
            <div className={styles['ladderLevel']}><b>{board === 1 ? '首板' : `${board}板`}</b>{(rows.length > 0 || missedRows.length === 0) && <small>{rows.length}只</small>}</div>
            <div className={styles['ladderStocks']}>
              {rows.length === 0 && missedRows.length === 0 ? <span className={styles['ladderGap']}>暂无个股 · 梯队断层</span> : <>
                {visibleRows.map(stock => <button key={stock.code} className={styles['ladderStock']} type="button" onClick={() => openStock(stock)}
                  {...tooltipProps(`sealed:${stock.code}`, <>
                    <div><b>{stock.name}</b> <span>{stock.code}</span></div>
                    <div>{stock.reason ?? `所属行业：${stock.industry}；涨停原因暂缺`}</div>
                    <div>首次封板 {stock.firstSeal} · 最后封板 {stock.lastSeal}</div>
                    <div>炸板 {stock.breaks ?? '—'} 次 · 换手率 {stock.turnover == null ? '—' : `${stock.turnover.toFixed(2)}%`}</div>
                    <div className={styles['ladderTooltipHint']}>点击查看个股 · 板型以来源标注为准</div>
                  </>)}>
                  <strong>{stock.name}</strong><span>{limitBoardType(stock.boardType) ?? '板型待确认'}</span><small>{stock.reason?.split(/[+＋]/)[0] || `行业：${stock.industry}`}</small>
                </button>)}
                {visibleMissed.map(stock => <button type="button" key={stock.code} onClick={() => openStock(stock)} className={`${styles['ladderStock']} ${styles['ladderMissed']}`}
                  {...tooltipProps(`missed:${stock.code}`, <>
                    <div><b>{stock.name}</b> <span className={changeStyle(stock.changePct)}>{change(stock.changePct)}</span></div>
                    <div>{stock.code} · {stock.industry}</div>
                    <div>昨日 {stock.boards} 板{stock.broken === true && ' · 炸板'}</div>
                    {stock.brokenTiming && ('lastTouch' in stock.brokenTiming
                      ? <><div>首封 {stock.brokenTiming.firstTouch} · 炸板 {stock.brokenTiming.lastTouch}</div><div className={styles['ladderTooltipHint']}>同花顺 · 炸板时间取末次触板</div></>
                      : <div>首次封板 {stock.brokenTiming.firstSeal}</div>)}
                    <div className={styles['ladderTooltipHint']}>点击查看个股</div>
                  </>)}>
                  {stock.broken === true && <span className={styles['ladderBrokenBadge']} role="img" aria-label="炸板" />}
                  <strong><del>{stock.name}</del></strong><span className={changeStyle(stock.changePct)}>{change(stock.changePct)}</span>
                  <small>{stock.industry}</small>
                </button>)}
                {hidden > 0 && <button type="button" className={styles['ladderExpand']} aria-expanded={expanded} onClick={() => {
                  hideTooltip()
                  setExpandedBoards(current => {
                    const next = new Set(current)
                    if (next.has(board)) next.delete(board)
                    else next.add(board)
                    return next
                  })
                }}>{expanded ? (board === 1 ? '收起首板' : `收起 ${board} 板`) : `展开其余 ${hidden} 只`}</button>}
              </>}
            </div>
          </section>
        })}
      </div>
      {tooltip && <div id={tooltipId} role="tooltip" className={styles['ladderTooltip']} ref={element => {
        if (!element) return
        const anchor = tooltip.anchor.getBoundingClientRect()
        const left = Math.max(8, Math.min(anchor.left, window.innerWidth - element.offsetWidth - 8))
        const top = anchor.bottom + 6 + element.offsetHeight <= window.innerHeight - 8
          ? anchor.bottom + 6 : Math.max(8, anchor.top - 6 - element.offsetHeight)
        element.style.left = `${left}px`
        element.style.top = `${top}px`
      }}>{tooltip.content}</div>}
      {historical && data !== null && missed == null && <p className={styles['ladderFootnote']}>该日未保存昨日梯队明细。</p>}
      <p className={styles['ladderFootnote']}>按来源涨停池筛选；与市场宽度口径不同，多题材家数不累加。</p>
    </article>
    <article className={`${styles['card']} ${styles['ladderCard']}`} aria-label="题材连板分布">
      <PanelHead title="题材连板分布" hint="按涨停原因聚合 · 可多题材" meta={status(true)} />
      <div className={styles['ladderThemes']} tabIndex={0} aria-label="题材连板明细">
        {themes.length === 0 ? <p className={styles['ladderEmpty']}>{data === null ? empty : stocks.length === 0 ? '当前无涨停题材' : '题材归因暂不可用，梯队仍可查看'}</p> : themes.slice(0, themesExpanded ? themes.length : 8).map((theme, i) => <div className={styles['ladderTheme']} key={theme.name}>
          <span>{String(i + 1).padStart(2, '0')}</span><div><b>{theme.name}</b><small>最高 {theme.height} 板 · {theme.stocks.slice(0, 3).map(stock => stock.name).join('、')}</small></div><strong>{theme.count}<small> 只</small></strong>
        </div>)}
        {themes.length > 8 && <button className={styles['ladderExpand']} aria-expanded={themesExpanded} onClick={() => setThemesExpanded(value => !value)}>{themesExpanded ? '收起题材' : `查看其余 ${themes.length - 8} 个题材`}</button>}
      </div>
    </article>
  </div>
}
