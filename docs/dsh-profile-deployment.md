# DSH Profile 部署与 upstream 合并指南

本文记录这个 fork 的独立 Profile 工作流，以及与 upstream（`hancao97/hanai-investment-dsh`）合并时需要了解的差异面。分支、插件与 Profile 的名称约定：

| 名称 | 角色 |
| --- | --- |
| `hanai-investment-dsh` | 插件包名（`package.json` 的 `name`） |
| `hanai-investment` | 独立 DSH Profile 名，安装与启动命令使用它 |
| `web` | DSH 官方默认 Profile，保持纯净，不安装本插件 |
| `main` | fork 的主干分支，仅跟踪 `origin/main`，不直接开发 |
| `dsh-profile` | 从 `origin/main` 打出的基线分支：upstream 兼容修复 + 通用加固（熔断、开市轮询） |
| `dsh-plugin` | 从 `main` 打出的功能分支：今日交易数据、复盘分析等大型增量功能 |

## 1. 部署

首次部署（详见 [README「从源码安装」](../README.md#从源码安装)）：

```bash
pnpm install --frozen-lockfile
pnpm run build
pnpm run profile:install -- --package .
pnpm run profile:verify
dsh --profile hanai-investment
```

安装器以 workspace link 方式把仓库装进 `~/.dsh/profiles/hanai-investment`，之后日常开发只需 `pnpm run build` 再重启 DSH，无需重复安装。前端（`lib/client.js`）改动刷新浏览器即可，宿主（`lib/index.js`）改动需重启。

`dsh --profile web` 与本插件无关：如需从默认 Profile 移除历史残留，执行 `dsh plugin --profile web remove hanai-investment-dsh`（会同步清理 manifest 的 dependencies 与 bundles 两处）。

## 2. Windows 支持的既有修复

以下修复已落在 `scripts/` 与 `packages/` 中，属于普适缺陷修复，upstream 也可直接合入；Windows 环境无需额外配置。

| 修复 | 位置 | 根因 |
| --- | --- | --- |
| `spawnSyncShell` 封装 | `scripts/win-spawn.ts` | Windows 上 npm 全局 CLI 是 `.cmd` shim，`spawnSync` 不带 shell 无法执行（ENOENT） |
| 安装锚点探测 | `scripts/profile-contract.ts` | npm Windows 全局布局中 shim 与包分居两处，需探测 bin 目录的 `node_modules/@deepseek-ai/dsh` |
| 跨盘符判定 | `scripts/profile-contract.ts` | Profile 与 DSH 分属不同盘符时 `path.relative` 返回绝对路径，需追加 `isAbsolute` 分支 |

排障细节见 [startup-and-verification.md 第 10 节](startup-and-verification.md#10-常见问题)。

## 3. fork 相对 upstream 的差异面

合并或 rebase upstream 时，先对照下表评估冲突范围：

| 文件 | 类型 | 冲突风险 | 合并策略 |
| --- | --- | --- | --- |
| `packages/domain/src/providers/source-circuit.ts` | 新增 | 无 | 直接保留 |
| `packages/client-workbench/src/market-hours.ts` | 新增 | 无 | 直接保留 |
| `scripts/win-spawn.ts` | 新增 | 无 | 直接保留 |
| `packages/domain/src/providers/index.ts` | 修改（熔断接线） | 低 | diff 限于 `callSource` 包裹，upstream 改动可叠加 |
| `packages/client-workbench/src/app.tsx` | 修改（轮询 gate、冷却按钮） | 中 | 每处 1–3 行语义独立，冲突时优先保留 upstream 主体再补 gate |
| `scripts/install-profile.ts`、`verify-profile.ts`、`profile-contract.ts` | 修改（Windows 修复） | 低 | 修复集中在 spawn 与锚点函数，与 upstream 功能演进正交 |

`dsh-plugin` 分支还包含今日交易数据、复盘分析、快照与 host 级熔断等大型增量，仅在该分支范围内合并，不与 `dsh-profile` 交叉 rebase。

## 4. 合并 upstream 的操作步骤

```bash
git fetch origin
git checkout main && git merge --ff-only origin/main   # main 保持与 upstream 同步
git checkout dsh-profile && git rebase main            # 或 merge，按团队习惯
pnpm run typecheck && pnpm vitest run && pnpm run build
pnpm run profile:install -- --package . && pnpm run profile:verify
dsh --profile hanai-investment --no-open                # 实际启动冒烟，确认 Bundle 与页面正常
```

门禁不通过时优先检查 `providers/index.ts` 与 `app.tsx` 两个中风险点；纯新增文件按表保留即可。通用修复（如 Windows 支持三项）建议以独立 commit cherry-pick 提交 PR 回 upstream，避免与功能分支纠缠。
