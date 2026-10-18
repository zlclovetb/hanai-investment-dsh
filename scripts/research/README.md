# Research scripts

本目录包含 K 线变盘点、量价扫描、缠论重放、回测报告和周期投研报告脚本。权威的变盘脚本分类、输入输出关系、行情来源、统一 cutoff 与完整复现命令见[变盘点、扫描与回测研究总索引](../../docs/turning-point-research-index.md)。

维护约定：

- `current-*`、`production-turning-point-*` 和 `render-turning-point-*` 构成当前生产规则审计链；
- `full-market-*` 用于全市场候选发现；
- `kline-*`、`ma-volume-*` 是固定样本基线、周期研究和历史策略实验；
- `chan-*` 依赖固定 commit 的外部 `chan.py`，用于点位生命周期和年度稳定性；
- `a-share-cycle-market-snapshot.ts` 冻结点时估值、标准化前复权日线、逐条件事件、20/60/120日相对强弱、非重叠条件历史频率、市场/板块宽度与国债机会成本；
- `complete-a-share-cycle-outlook.ts` 在历史结构化底稿上补齐主题五维评分、六股质量/估值/技术证据和机械门禁，默认生成独立的 `*-pre-council-*` 冻结输入；
- `run-a-share-expert-council.ts` 把最新冻结事实包送入五个已打包专家 Skill，保存完整提示词、原始 DSH 输出、解析结果和提示词 / Skill / AGENTS / 脚本哈希；未冻结的具体模型与reasoning配置必须显式披露；
- `finalize-a-share-cycle-council.ts` 校验前置输入 SHA 后，将全状态专家复核聚合到另一个最终 JSON；AI票只作为会商门，不能覆盖事实硬门，也不得原地覆盖专家实际读取的输入；
- `render-a-share-cycle-outlook.ts` 读取人工策展的周期投研 JSON，校验三情景、六指标、五票与来源引用后生成自包含 HTML；报告不计算或展示未经校准的情景概率；
- 周期展望主 JSON 不是模型输出的无损转录；2026-08-25完整版本由市场快照、结构化补全、Round 4、会商聚合和HTML渲染按顺序生成。研究方法变化时应新增版本与产物，不覆盖旧日期；
- `/tmp` 下的行情缓存、中间年度产物和 manifest 不属于源码，运行前必须核对 cutoff、证券宇宙、失败数和哈希；
- `--max-symbols`、`--exchange` 等子集参数只用于诊断，不能标记为全量研究。

变盘点冻结研究仍以 2026-08-20 为统一行情截止；周期展望完成版另使用2026-08-25点时市场快照，并以不同日期产物隔离。新时间样本必须使用新的版本 / 日期，不应把 cutoff 后数据混回旧产物。

周期展望报告复现：

```bash
pnpm exec tsx scripts/research/a-share-cycle-market-snapshot.ts
pnpm exec tsx scripts/research/complete-a-share-cycle-outlook.ts
pnpm exec tsx scripts/research/run-a-share-expert-council.ts
pnpm exec tsx scripts/research/finalize-a-share-cycle-council.ts
pnpm exec tsx scripts/research/render-a-share-cycle-outlook.ts
```

2026-10-18 投资报告使用独立的数据链，不经过历史周期报告的专家会商：

```bash
# 用已经冻结的公开数据重建 HTML；无网络、无额外依赖。
node scripts/research/render-a-share-investment.mjs
node scripts/research/render-a-share-investment.mjs --check
```

- `collect-a-share-investment.ts` 通过软件原有 MarketDataService 收集 20 家公司的公开行情、财报、前复权价格和价值大师数值摘要，并记录五个方法 Skill 的 SHA256。只支持抓取当日的新快照，不读取个人自选、账户或对话，不覆盖已有日期文件。
- `docs/research-data/a-share-investment-2026-10-18.json` 保存软件快照；`a-share-investment-theses-2026-10-18.json` 保存人工策展的方向、来源、价格假设、经营前提和反证。公告仅链接，不存储完整财报或价值大师曲线。
- 渲染器验证公司身份、5 × 4 覆盖、行情日期、无未来数据、来源、Skill 哈希、内部锚点与 HTML 确定性；`--check` 已接入 Pages 发布流程。PE / PB / 股息率门槛是报告假设，不是 DCF 公允价值或模型买入信号。
- 新一期报告应新建日期产物、更新来源与所有经营假设，并明确新的模型数据日期；不能只替换报价沿用旧结论。冻结报告保持可复核。
