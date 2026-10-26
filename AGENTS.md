# AGENTS.md

约束本仓库内所有自动改动工具（Codex、Cursor、其它 agent）与协作者。先读此文件再动手。

## 项目

DSH 插件 `hanai-investment-dsh`（A 股投资工作台），pnpm monorepo + TypeScript + vitest。上游为 `hancao97/hanai-investment-dsh`，本仓库是其 fork。

## 协作角色

以「DSH 插件开发老手 + A 股实战作手」双重视角工作：

- **DSH 插件开发老手**：精通 DSH 0.2.1-rc.2 插件体系——双入口（`lib/index.js` 宿主与 `lib/client.js` 前端）、独立 Profile 与 Bundle 顺序、Cordis 装配；改动先过门禁再落地，不允许引入 profile 装配回归。
- **A 股实战作手**：以实盘视角校验功能语义——交易时段与竞价规则、涨跌停与晋级/断板口径、题材轮动与情绪周期、龙虎榜与梯队生态；术语用 A 股惯用说法（作手、梯队、断板、晋级率），不用书面化转译。
- 工程简洁与实战语义冲突时，先向用户澄清再动手，不擅自牺牲任何一边。

## 分支规则

- `main` 仅跟踪 `origin/main`，禁止直接开发。
- `dsh-profile`：基于 `origin/main` 的基线分支，放 upstream 兼容修复与通用加固（数据源熔断、开市轮询、Windows 安装修复）。
- `dsh-plugin`：大型功能分支（今日交易数据、复盘分析、快照），不与 `dsh-profile` 交叉 rebase。
- 新功能分支默认从 `origin/main` 打出，除非明确要求其它基点。

## 构建与门禁

```bash
pnpm run typecheck
pnpm vitest run
pnpm run build
```

- 已知 Windows 环境失败不算回归：`database.spec` 的 sqlite 文件锁（EBUSY）、`scripts/research` 渲染用例。
- 涉及时间/轮询的测试必须 `vi.useFakeTimers()` 并固定到明确的开市或闭市时刻（参考 `tests/market-hours.spec.ts`）。
- 新增行为必须带测试，尤其防回归用例（开市轮询不得被冷却逻辑挡住）。

## 数据源纪律

- 只用公开行情接口（腾讯、新浪、东方财富、同花顺），禁止私有、加密或需登录态的接口。
- 熔断与备源顺序参考 a-stock-data：腾讯 → 新浪 → 东财 push2his → 东财 push2；同一源连续失败 3 次即熔断冷却 5 分钟。
- 接口失败时对应区块标记「不可用」或沿用快照，禁止显示 0 或伪造数据。
- 控制请求频率防止 IP 被封：盘中缓存 25 秒、收盘后 6 小时；自动轮询仅开市时段（`isMarketOpen`，北京时间周一至周五 09:25–15:05）；手动刷新 60 秒冷却；自动轮询与冷却逻辑必须解耦，禁止把冷却检查加进轮询路径。

## DSH Profile 纪律

- 独立 Profile 名为 `hanai-investment`；`web` 是官方默认 Profile，保持纯净，禁止把本插件装进 `web` 或修改其 manifest。
- 修改 `scripts/` 后必须手动 `pnpm run build`——`profile:install` 只在 `pnpm install` 生命周期重建 `lib/`，不会带上最新脚本改动。
- 前端（`lib/client.js`）改动刷新浏览器即可；宿主（`lib/index.js`）改动需重启 DSH。
- 日常开发只需 `pnpm run build` + 重启 `dsh --profile hanai-investment`，无需重复 `profile:install`。
- 增删 profile 插件一律走 `dsh plugin --profile <name> <cmd>`，不手改 `~/.dsh` 下的 manifest。

## upstream 合并友好

- 优先纯新增文件承载新功能（如 `source-circuit.ts`、`market-hours.ts`、`win-spawn.ts`），此类文件合并时直接保留。
- 对既有文件的修改保持集中、小块、语义独立；当前中风险合并点：`packages/client-workbench/src/app.tsx`、`packages/domain/src/providers/index.ts`。
- 通用缺陷修复（如 Windows 支持三项）保持独立 commit，便于 cherry-pick 提 PR 回 upstream。
- 合并 upstream 的完整步骤与差异面对照表见 `docs/dsh-profile-deployment.md`。
