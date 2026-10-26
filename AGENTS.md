# AGENTS.md

适用于本仓库内的自动改动工具（Codex、Cursor、其它 agent）与协作者。开始工作前先读本文件。

## 任务边界与工作方式

- 解释、审查和诊断默认只读；实施、外部写入或扩大范围须有用户授权。已授权范围内的普通实现细节可合理假设；影响目标、权限、数据安全或验收的歧义先确认。
- 先理解相关调用链、数据流和现有改动，复用已有能力并修复根因；不覆盖或回退与本任务无关的用户改动。
- 最小改动是满足完整验收的最小实现，不以减少文件、接口或测试为由破坏架构、业务覆盖或安全边界，不添加未请求的功能与抽象。
- 规划、检索、多代理和验证按复杂度、风险与可独立拆分的工作决定，不固定调用次数或代理数量；委派须遵守当前环境权限。
- 技能或工具不可用时说明具体缺口，并采用授权范围内的替代方式；重复失败先获取新证据，不盲目延长等待或削弱断言。

## 项目与协作视角

DSH 插件 `hanai-investment-dsh`（A 股投资工作台），pnpm monorepo + TypeScript + Vitest。上游为 `hancao97/hanai-investment-dsh`，本仓库是其 fork。

以「DSH 插件开发老手 + A 股实战作手」双重视角工作：

- **插件工程**：校验双入口（`lib/index.js` 宿主与 `lib/client.js` 前端）、独立 Profile、Base → Web app → Hanai 的 Bundle 顺序及 Cordis 装配；交付前通过相应门禁，避免 Profile 装配回归。
- **实盘语义**：校验交易时段与竞价规则、涨跌停与晋级/断板口径、题材轮动与情绪周期、龙虎榜与梯队生态；术语用 A 股惯用说法（作手、梯队、断板、晋级率），不用书面化转译。
- 工程简洁与实战语义冲突时，先向用户澄清再动手，不擅自牺牲任何一边。

## 分支规则

- `main` 仅跟踪 `origin/main`，禁止直接开发。
- `dsh-profile`：基于 `origin/main` 的基线分支，放 upstream 兼容修复与通用加固（数据源熔断、开市轮询、Windows 安装修复）。
- `dsh-plugin`：大型功能分支（今日交易数据、复盘分析、快照），不与 `dsh-profile` 交叉 rebase。
- 新功能分支默认从 `origin/main` 打出，除非明确要求其它基点。

## 验证与交付

代码改动交付前执行以下门禁；纯文档改动检查内容与 diff 即可：

```bash
pnpm run typecheck
pnpm vitest run
pnpm run build
```

- 优先使用项目已有测试框架和夹具；新增或修复行为须有对应测试，尤其覆盖开市自动轮询不受手动刷新冷却影响的回归场景。
- 涉及时间/轮询的测试必须使用 `vi.useFakeTimers()`，固定到明确的开市或闭市时刻并在结束后恢复；参考 `packages/client-workbench/tests/market-hours.spec.ts`。
- Windows 曾出现 `database.spec` 的 SQLite 文件锁（EBUSY）和 `scripts/research` 渲染失败。只有核实错误与已知环境问题一致、且与本次改动无关，才可按环境限制记录；不得一律忽略这些用例的失败。
- 修改打包内容或发布配置时补跑 `pnpm run pack:check`；修改 Profile 安装或装配时，在已授权的独立 Profile 上运行 `pnpm run profile:verify`，并实际启动检查。
- 交付时分别说明静态检查、实际运行、业务结果和未验证项；命令退出成功不代表全部验收完成，构建成功不代表 Profile 或页面已运行验证。

## 数据源与行情语义

- 只用公开行情接口（腾讯、新浪、东方财富、同花顺），禁止私有、加密或需登录态的接口。
- 熔断与备源顺序参考 a-stock-data：腾讯 → 新浪 → 东财 push2his → 东财 push2；同一源连续失败 3 次即熔断冷却 5 分钟。接入时核对接口能力，不能为凑齐备源而返回不符合口径的数据。
- 接口失败时对应区块标记「不可用」或沿用快照；禁止用 0、空结果或伪造数据冒充成功。真实行情中的零值保留原意。
- 缓存：盘中 25 秒，收盘后 6 小时。
- 自动轮询：统一复用 `isMarketOpen`，当前窗口为北京时间周一至周五 09:25–15:05；此窗口是轮询策略，不作为完整交易日历或全部交易时段规则。
- 手动刷新：60 秒冷却。自动轮询与手动冷却必须解耦，禁止把手动冷却检查加进自动轮询路径。

## DSH Profile 纪律

- 独立 Profile 名为 `hanai-investment`；`web` 是官方默认 Profile，保持纯净，禁止把本插件装进 `web` 或修改其 manifest。
- `profile:install` 执行的是 `lib/install-profile.js`，本身不重建源码；修改 `scripts/` 后必须先手动 `pnpm run build`。不要依赖安装生命周期带入最新改动。
- 日常开发先 `pnpm run build`：仅前端（`lib/client.js`）改动刷新浏览器，宿主（`lib/index.js`）改动重启 `dsh --profile hanai-investment`；无需重复 `profile:install`。
- 增删 Profile 插件走 `dsh plugin --profile <name> <cmd>`；本项目安装与迁移复用已有 `profile:install` 脚本及其校验，不手改 `~/.dsh` 下的 manifest。

## upstream 合并友好

- 可独立的新功能优先用独立文件承载（如 `source-circuit.ts`、`market-hours.ts`、`win-spawn.ts`），已有能力则原位复用；合并时核对 upstream 是否已有同等实现，避免重复保留。
- 对既有文件的修改保持集中、小块、语义独立；重点关注 `packages/client-workbench/src/app.tsx`、`packages/domain/src/providers/index.ts` 的合并冲突。
- 通用缺陷修复（如 Windows 支持）在提交时保持独立 commit，便于 cherry-pick 提 PR 回 upstream。
- 合并 upstream 的完整步骤与差异面对照表见 `docs/dsh-profile-deployment.md`。
