# 输入与数据映射

需要 Python 3.11 或以上，仅标准库。以下脚本路径相对技能目录。命令把 JSON 写到标准输出，状态文件按交易日单独留存。

```powershell
python scripts/track.py --export-hanai "$env:USERPROFILE/.hanai-investment-dsh/db/hanai.sqlite" --date 2026-11-18
python scripts/track.py first.json --baseline
python scripts/track.py today.json --previous previous-close.json
python scripts/track.py today.json --previous previous-close.json --publish-hanai "$env:USERPROFILE/.hanai-investment-dsh"
```

导出只读查询指定交易日的 `topic_cycle_daily.input`，可复用收盘梯队、昨日涨停反馈、市场宽度、已跟踪股原始日线与报价。归档未冻结时用用户提供的同期事实。历史日期沿原归档，避免用当前行情回填。冻结梯队有样本上限，未入样不能推断断板或未参与。市场跌停数不可代替题材跌停数。

发布把已完成的收盘 JSON 写入 Hanai 数据根的 `exports/leader-evolution/YYYY-MM-DD.json`，供「情绪周期」读取。用实际部署的 Hanai 数据根；默认路径如上。发布后同一文件也可作为下一交易日的 `--previous` 输入。重复发布相同内容成功，已有不同的同日档案会报冲突。盘中结果单独保存。

## 标准化快照

- 顶层填 `date`、`previousDate`、带时区的 `asOf`、`mode`（`close` 或 `intraday`）和 `facts`。收盘使用真实收盘事实，北京时间 15:00 后运行；盘中使用实际采样时点。规则适用时可按 09:25、09:35、10:00、11:30、14:00、15:00 取已存在的快照并保留原时间。
- 收盘可附 `themes`，以题材名为键，值含 `state`、一句话 `conclusion`、可选的切换 `rule` 和 `evidence` 引用数组。阶段取 `DORMANT`、`IGNITION`、`MAIN_RALLY`、`DIFFUSION`、`DIVERGENCE`、`EBB`。依据不足时省略该题材的阶段记录。
- `facts` 按 `题材/股票代码` 建键，输入值为 `{ "value": 3, "observedAt": "2026-11-18T15:00:00+08:00", "evidence": ["ladder:2026-11-18"] }`。时间取事实所对应的交易时刻，抓取时刻另随来源留档。组合或变化值附上相关证据。缺失字段省略或填 `null`。布尔 `false` 表示已核实不成立。
- 初次基线用 `candidates`。后续由 `--previous` 传入上一交易日收盘输出。新增提议用 `proposals`，字段与候选一致，另含 `reason` 和至少两项 `admitWhen` 指标，收盘用次日证据验收。因数据缺失未通过的观察可继续核验，报告须明确它仍在观察层。
- 候选含 `code`（六位字符串）、`name`、`theme`（题材内保持同一名称）、`role`（总龙候选、次龙/卡位候选、中军/容量、补涨/跟风）、`weight`（1–5）、`confidence`（低／中／高）、`falsifiers`。
- 单条证伪含 `label`、`action`（撤销或降级）、`all`。同条 `all` 内为且，多个证伪条件各自独立。降级另给 `toRole` 和新角色 `afterFalsifiers`，避免撤销旧假设后继续套用旧的证伪条件。

```json
{
  "label": "题材跌停至少两家且候选断板未回封",
  "action": "撤销",
  "all": [
    {"metric": "theme_limit_down", "op": ">=", "value": 2},
    {"metric": "failed_unsealed", "op": "==", "value": true}
  ]
}
```

## 可用指标

| 指标 | 取数口径 |
| --- | --- |
| `boards`、`breaks`、`turnover_pct` | 当前连板数、开板次数、实际换手百分数。冻结梯队字段为 `boards`、`breaks`、`turnover` |
| `space_boards`、`theme_followers` | 同期全市场空间高度、按同一题材口径核实的跟随家数 |
| `change_pct`、`open30_change_pct` | 当前或收盘涨跌幅、09:30 后满 30 分钟时相对昨收的涨跌幅 |
| `amount`、`amount_ma5_ratio`、`capacity_breakdown` | 同口径成交额、对前五个交易日成交额均值的比率、容量股是否按已有趋势标准放量破位 |
| `first_seal_minute` | 首次封板时钟换成北京时间当日分钟数，如 09:40 为 580；需带首封时间的原始快照 |
| `auction_prev_pct`、`volume_prev_ratio`、`volume_ma5_ratio` | 竞价成交量 ÷ 昨全天成交量 × 100、今日全天量 ÷ 昨量、今日全天量 ÷ 前五个交易日均量，统一股数单位 |
| `prev_broken`、`prev_long_leg`、`prev_late_seal`、`prev_high_volume_one_word` | 昨日断板、大长腿、14:30 及以后首次封板、放量一字板。前两项需完整梯队或分时确认，大长腿要求已有可靠阈值或来源，放量一字要求同时具备板型和量能 |
| `promoted`、`failed_unsealed`、`first_break`、`resealed` | 对照相邻交易日或明确的日内快照。收盘断板或回封以完整梯队／未晋级证据确认；「首次」还需此前没有断板的完整序列 |
| `followers_delta`、`followers_shrink_days`、`countertrend_limit_up` | 同一题材同一统计口径的跟随家数变化、连续收缩天数、总龙分歧时同题材次龙逆势封板。关联、回封先后或跟随因果需额外证据 |
| `theme_limit_down`、`front_row_big_loss`、`mid_tier_loss_cluster`、`followers_limit_down_cluster`、`market_leader_holds` | 按事先定义的题材成员和角色分别核对跌停数、前排中大阴线、中位股集体负反馈、补涨梯队批量跌停、总龙仍有承接。引用成员、表现和覆盖范围，个别股票走弱不足以构成集体负反馈 |

默认盘后判据：昨日四种弱势任一成立后，今日竞价达昨日全天量 5% 以上（5%–10% 为典型量级），开盘半小时内首封且全天缩量，板块跌停不足两家且前排无中大阴。板块负反馈使信号作废。14:30 及以后首次封板，或开板至少两次且量达前五日均量 2.5 倍，均否决升级。这是试跑阈值。前五日均量 1.5–2 倍可作为温和放量观察，证据和题材背景另附。

退潮 L3 要求相关证据齐全。组合一要求断板未回封、换手大于 40%、中位股集体负反馈、题材跌停至少两家。组合二要求补涨集体跌停时总龙仍有承接。盘中同样事实只报偏离，收盘复核后才清算。
