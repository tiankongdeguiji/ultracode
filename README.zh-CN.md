# ultracode

[English](README.md) · **简体中文**

[![ci](https://github.com/tiankongdeguiji/ultracode/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/tiankongdeguiji/ultracode/actions/workflows/ci.yml)
[![license](https://img.shields.io/github/license/tiankongdeguiji/ultracode)](LICENSE)
[![stars](https://img.shields.io/github/stars/tiankongdeguiji/ultracode)](https://github.com/tiankongdeguiji/ultracode/stargazers)

**一句话，唤来一支舰队。** 可移植的 **ultracode**——动态多 agent 工作流编排——为那些原生不支持它的编码 agent 而生：OpenAI Codex CLI、Qoder、Gemini CLI 等等。它忠实于 Claude Code Workflow 方言，因此同一份 `*.workflow.js` 脚本能在 Claude Code（原生）、Qoder（原生）以及本引擎上运行。

*Linux 与 macOS · 尚未发布到 npm——需从源码构建。*

在你的编码 agent 里输入 `ultracode`，它便不再困守于单一上下文：**skill** 负责编写一份确定性的 JS 工作流；**引擎** 把每个 `agent()` 当作子进程来运行。

```text
"ultracode: audit src/ for auth bugs"      <- the keyword arms the skill
    |
    v
your agent authors audit.workflow.js      <- deterministic JS; agent() is
    |                                         the only side-effect channel
    v   ultracode run ...   or   MCP workflow_start
ultracode engine: sandboxed script + scheduler + journal
    |
    +--> codex worker   +--> claude worker   +--> gemini worker   ...
    |        real coding-agent subprocesses, fanned out concurrently
    v
.ultracode/runs/<id>/ --> watch | status | logs | stop | resume
```

## 为什么用 ultracode

一个 agent、一个上下文窗口、一条线性的对话记录——这就是天花板。`ultracode` 把它换成一支协同作战的舰队：一批拥有全新上下文的子 agent 并行工作，只把各自的结论回传给你。

### 这支舰队为你带来什么

- **分而治之**——输入关键词 `ultracode` 会激活一个 skill（方法论），由它引导 *你的* agent 把一个大任务拆解成一条由许多小 `agent()` 调用组成的工作流，每个调用都是一个拥有独立全新上下文的子进程。
- **扇出，但有边界**——一个任务铺开到许多子 agent 上：默认可达几十个（软上限 `50`），每次运行最多 `1000` 个（硬上限），同时并发约 10 个——并发数与软上限都由你掌控，分别通过 `--max-concurrency` 和 `--max-agents` 调整。
- **不会淹没你的会话**——只有子 agent 的最终返回值（一个结构化对象，或它的最后一条消息）会回来；它完整的对话记录——每一次工具调用、每一次文件读取、每一个流式 token——都留在各自的 run 目录里，永不回流。
- **交叉验证，设计使然**——`parallel()` 和 `pipeline()` 都是一等公民，方法论还教你一套质量模式：对抗式验证（让相互独立的怀疑者受命反驳，多数意见即可否决一条发现）、评审团、多视角复审、循环直到再无新发现。内置的 `uc-review` 工作流走的正是并行查找 → 对抗式验证 → 综合汇总。
- **发起后就可以走开**——每一次运行都是一个脱离会话、独立运行的操作系统进程（没有守护进程），所以哪怕启动它的 CLI、MCP 服务器或宿主 agent 挂掉，它照样继续执行；你可以从任意 shell 去 watch、stop 或续跑它。
- **可复用的资产，而非一次性脚本**——工作流就是朴素的确定性 JS：读得懂、用 `--dry-run` 免费演练、存进 `.ultracode/workflows/`，还能用 `workflow()` 把一个嵌进另一个（仅一层）。

### 支撑它的引擎

- **一种方言，三个引擎**——同一份 `*.workflow.js` 文本能在 Claude Code（原生）、Qoder（原生）以及本引擎上运行；`ultracode lint` 确保它落在可移植子集内，`ultracode sync` 则把工作流镜像到 `.claude/workflows/` 和 `.qoder/workflows/`。
- **真实的 agent，而非模拟**——在四个真实后端（`codex`、`qoder`、`claude`、`gemini`）上，每个 `agent()` 都是一个真实的编码 agent 子进程；第五个后端 `mock` 是进程内的测试替身，正是它撑起了那些免费的 `--dry-run` 演练。
- **基于 journal 的续跑**——确定性脚本加上哈希链式的 journal，让 `ultracode resume <runId>` 能免费重放 `agent()` 调用中最长的、未变更且成功的前缀，再把剩下的实时跑完——即便脚本改动过也行（第一处差异就是缓存前缀的终点）。
- **实时舰队面板**——前台运行会直接显示它，`ultracode watch` 还能从任意 shell 重新接入：逐个 agent 的 token 数与耗时，用方向键选中某个 agent，展开它的 prompt/活动/结果详情（在 `watch` 里，Ctrl-C 只是脱离，绝不会停掉运行）。
- **预算与超时限制均为可选**——没有默认上限（不设即无限制）；`--budget 500k` 在派发关口强制生效——越过上限就不再启动新的 agent——超时限制也是同样的机制。
- **结构化输出，糙模型也扛得住**——给 `agent()` 一个 `JSON Schema`，它就返回一个经过校验的对象；不合规的回复最多有两次 schema 修复重试的机会，之后才算失败。
- **MCP 控制面**——`workflow_start` / `workflow_status` / `workflow_result` 三件套驱动着位于 `.ultracode/runs/` 的共享运行记录存储，`workflow_start` 会在一秒内交回一个 `runId`，让受沙箱限制的宿主可以跨轮次做发起后无需值守的编排。

## 快速上手

```bash
npm install && npm run build && npm link   # 构建，然后链接出一个全局的 `ultracode`
ultracode doctor                  # 有哪些后端可用 + 各自的鉴权方式
```

### 搭配你的编码 agent 使用

日常推荐路径——装好 skill 与宿主接线：

```bash
ultracode install codex           # skill + AGENTS.md 触发器 + MCP 注册
                                  # 其他宿主：`install qoder` · `install generic`
```

然后在 Codex（或 Qoder、Gemini CLI、Claude Code）里输入这个关键词：

```text
"ultracode: 审查这个仓库有没有鉴权漏洞"
```

关键词会激活这个模式：你的 agent 编写并运行一份工作流——在 Qoder/Claude Code 上是原生的，在 Codex 上走 MCP，其他地方则通过 `ultracode` CLI。在 shell 里跟踪运行：

```bash
ultracode watch <runId>
```

```text
⏺ uc-audit-routes   running · 6m05s
  ⏺ Find (1/1)
    ⎿ ✓ #1                       12.4k tok · 18s · model-name
  ⠧ Audit (12/14)
    ⎿ … +9 done (1.37m tok)
    ⎿ ✓ src/routes/billing.ts    148.7k tok · 3m02s · model-name
    ⎿ ✓ src/routes/webhooks.ts   132.1k tok · 2m48s · model-name
    ⎿ ✓ src/routes/uploads.ts    121.9k tok · 2m35s · model-name
    ⎿ ⠧ src/routes/auth.ts       96.3k tok · 2m41s · model-name
    ⎿ ⠧ src/routes/admin.ts      88.9k tok · 2m37s · model-name
agents 13/15 · 2 running | tokens 2.0m | elapsed 6m05s
↑/↓ select · ⏎ details · esc clear · q detach · ctrl-c detach
```

### 直接驱动引擎

通常这些都由 skill 替你完成；同一套接口也开放给你手写和调试工作流。一份工作流就是一小段确定性的 JS 脚本：

```js
export const meta = { name: 'uc-audit-routes', description: 'Audit route handlers for missing auth', phases: [{ title: 'Find' }, { title: 'Audit' }] }

phase('Find')
const { files } = await agent('List every route file under src/. Return JSON.', {
  schema: { type: 'object', properties: { files: { type: 'array', items: { type: 'string' } } }, required: ['files'] },
})

phase('Audit')
const audits = await pipeline(files, (f) => agent(`Audit ${f} for missing auth checks. Be self-contained.`, { label: f }))
return { audits: audits.filter(Boolean) }
```

接口大体就这些了——剩下的是 `parallel()`、`log()`、`args`、`budget`，以及一层 `workflow()` 嵌套。熵被禁用（`Date.now()` / `Math.random()` 会抛错），所以每次运行都能重放——完整的方言参考见 `skill/ultracode/references/dialect.md`。

```bash
ultracode validate my.workflow.js
ultracode run my.workflow.js --dry-run          # 免费演练（mock 后端）
ultracode run my.workflow.js --backend codex    # 前台实时面板；--detach 转后台
ultracode resume <runId> [--script edited.js]   # 未变更的 journal 前缀免费重放
```

## 命令

| | 命令 | 功能 |
|---|---|---|
| 编写 | `validate <script>` | 检查 meta 块、方言约束和可编译性 |
| | `lint <script>` | 跨引擎可移植性检查（Claude Code / Qoder 原生 / ultracode） |
| 运行 | `run <script>` | 运行一份工作流：前台显示实时面板，`--detach` 转后台，`--dry-run` 做一次免费的 mock 演练 |
| | `resume <runId>` | 未变更且成功的 journal 前缀免费重放（也支持 `--script edited.js`），其余部分实时运行 |
| | `stop <runId>` | 停止一个正在运行的工作流（SIGTERM → 7s → SIGKILL） |
| 观察 | `watch <runId>` | 实时面板：各阶段、每个 agent 的 token/耗时；↑/↓ 选中某个 agent，⏎ 展开详情，q 脱离 |
| | `status <runId>` | 显示运行状态：阶段、agent、预算（`--watch` 持续轮询直到终态） |
| | `logs <runId>` | 打印运行事件（`--follow` 持续跟踪） |
| | `list` | 运行记录存储里最近的运行（`--all` 列出全部） |
| 集成 | `install <codex\|qoder\|generic>` | skill + 宿主触发器（AGENTS.md 片段 / Qoder 规则）；codex 用户级安装还会注册 MCP 服务器 |
| | `doctor` | 探测后端：可用性、版本、鉴权拓扑 |
| | `mode [on\|off]` | 读取或设置常驻的 ultracode 模式标记（`.ultracode/mode`） |
| | `sync` | 把权威的 `.ultracode/workflows` 镜像成 `.claude/` 和 `.qoder/` 副本 |
| | `mcp` | stdio MCP 服务器：`workflow_start` / `workflow_status` / `workflow_result`（外加 stop/list） |

## 文档

- `docs/architecture.md`——为什么把 skill + 引擎 + 插件分层设计、Qoder 原生引擎策略、v1 范围，以及哪些已端到端验证过。
- `docs/threat-model.md`——信任模型、对沙箱能力的诚实交代、并发与鉴权，以及 worker 可写的运行记录存储。
- `skill/ultracode/references/dialect.md`——完整的工作流方言参考；同目录的 `portability.md` 讲解跨引擎子集。
- `docs/design/judge.md`——设计历程：综合而成的架构 + 里程碑计划（3 位架构师 + 评审），建立在源码级研究之上（Claude Code 的 ultracode 机制、Codex/Qoder CLI 内部实现、MCP 长时运行工具的约束、JS 沙箱的取舍）。
- `SUPPORTED_VERSIONS.md`——锁定的 CLI 版本、平台说明、实测门禁。

## 项目状态

内部优先：尚未发布到 npm。仅支持 Linux 和 macOS——Windows 是有意不支持的（依赖 POSIX 进程组）。范围与暂缓事项见 `docs/architecture.md`。
