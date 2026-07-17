# ultracode

[English](README.md) · **简体中文**

[![ci](https://github.com/tiankongdeguiji/ultracode/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/tiankongdeguiji/ultracode/actions/workflows/ci.yml)
[![license](https://img.shields.io/github/license/tiankongdeguiji/ultracode)](LICENSE)
[![stars](https://img.shields.io/github/stars/tiankongdeguiji/ultracode)](https://github.com/tiankongdeguiji/ultracode/stargazers)

**一句话，唤来一支智能体舰队。** 可移植的 **ultracode** 为 OpenAI Codex CLI、Qoder、Gemini CLI 等编码 agent 补上动态多 agent 工作流编排能力。它兼容 Claude Code Workflow 方言，因此同一份 `*.workflow.js` 脚本可以在 Claude Code（原生）、Qoder（原生）和 ultracode 引擎上运行。

*支持 Linux 与 macOS · 需从源码构建。*

在编码 agent 中输入 `ultracode`，它就不再局限于单个上下文：**skill** 负责生成一份确定性的 JS 工作流，**引擎** 则把每个 `agent()` 作为独立子进程运行。

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

## 为什么选择 ultracode

单个 agent、单个上下文窗口、一条线性的对话记录，能做的事情终究有限。`ultracode` 将它扩展为一支协同工作的舰队：多个拥有独立全新上下文的子 agent 并行执行任务，只把最终结论汇总回来。

### 这支舰队能带来什么

* **分而治之**——输入关键词 `ultracode` 会激活一个 skill（工作方法），引导你的 agent 将大型任务拆成由多个小型 `agent()` 调用组成的工作流。每个调用都是一个拥有独立全新上下文的子进程。
* **可控的任务分派**——一个任务可以分派给多个子 agent：默认软上限为 `50` 个，每次运行的硬上限为 `1000` 个，默认同时并发约 10 个。并发数和软上限分别通过 `--max-concurrency` 与 `--max-agents` 调整。
* **主会话保持精简**——子 agent 只返回最终结果：一个结构化对象，或它的最后一条消息。完整对话记录，包括工具调用、文件读取和流式 token，都会保存在对应的 run 目录中，不会回流到主会话。
* **支持交叉验证**——`parallel()` 和 `pipeline()` 都是一等能力，skill 还提供多种质量控制模式：让多个独立 agent 专门尝试推翻某项发现的对抗式验证、评审团、多视角复审，以及循环检查直到不再出现新问题。内置的 `uc-review` 工作流采用的正是“并行查找 → 对抗式验证 → 综合汇总”流程。
* **无需驻守**——每次运行都是一个独立、脱离会话的操作系统进程，不依赖守护进程。即使启动它的 CLI、MCP 服务器或宿主 agent 退出，工作流仍会继续执行；你可以从任意 shell 中重新查看、停止或续跑。
* **工作流可沉淀复用**——工作流就是普通的确定性 JS：便于阅读，可以通过 `--dry-run` 免费演练，能够保存在 `.ultracode/workflows/` 中，也可以通过 `workflow()` 嵌入另一个工作流，支持一层嵌套。

### 驱动舰队的引擎

* **一套方言，三个引擎**——同一份 `*.workflow.js` 可以在 Claude Code（原生）、Qoder（原生）和 ultracode 引擎上运行。`ultracode lint` 用于确保脚本位于跨引擎可移植子集内，`ultracode sync` 则会将工作流同步到 `.claude/workflows/` 和 `.qoder/workflows/`。
* **基于 journal 的续跑**——确定性脚本结合哈希链式 journal，使 `ultracode resume <runId>` 可以直接重放最长的、未发生变化且已成功执行的 `agent()` 调用前缀，再继续运行剩余部分。即使脚本已经修改，也可以从第一处差异开始重新执行。
* **实时运行面板**——前台运行时会直接显示面板，`ultracode watch` 也可以从任意 shell 重新接入。面板会展示每个 agent 的 token 数和耗时；使用方向键选中 agent 后，可以查看它的 prompt、当前活动和最终结果。在 `watch` 中按 Ctrl-C 只会退出查看，不会停止工作流。
* **预算与超时可按需启用**——默认不设置任何上限；未配置即不限制。`--budget 500k` 会在任务派发时强制执行：达到上限后不再启动新的 agent。超时限制采用相同的控制方式。
* **结构化输出容错**——为 `agent()` 提供 `JSON Schema` 后，引擎会返回经过校验的对象。若模型输出不符合 schema，最多会自动进行两次修复重试，之后才将该调用判定为失败。

## 快速上手

```bash
npm install && npm run build && npm link   # 构建项目，并链接出全局 `ultracode` 命令
ultracode doctor                           # 查看可用后端及其鉴权方式
```

### 配合编码 agent 使用

推荐的日常使用方式，是先安装 skill 和宿主集成：

```bash
ultracode install codex           # skill + AGENTS.md 触发器 + MCP 注册
                                  # 其他宿主：`install qoder` · `install generic`
```

然后在 Codex（或 Qoder、Gemini CLI、Claude Code）中输入：

```text
"ultracode: 审查这个仓库有没有鉴权漏洞"
```

这个关键词会启用 ultracode 模式：你的 agent 会生成并运行一份工作流。在 Qoder 和 Claude Code 中使用原生工作流，在 Codex 中通过 MCP，在其他宿主中则通过 `ultracode` CLI。你可以在 shell 中查看运行进度：

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

### 直接使用引擎

通常这些步骤都会由 skill 自动完成；为了方便手动编写和调试工作流，引擎也提供了同一套接口。一份工作流就是一小段确定性的 JS 脚本：

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

主要接口就是这些；除此之外还有 `parallel()`、`log()`、`args`、`budget`，以及一层 `workflow()` 嵌套。为了保证工作流可以重放，脚本中禁用了熵源：调用 `Date.now()` 或 `Math.random()` 会直接抛出异常。完整的方言参考见 `skill/ultracode/references/dialect.md`。

```bash
ultracode validate my.workflow.js
ultracode run my.workflow.js --dry-run          # 使用 mock 后端免费演练
ultracode run my.workflow.js --backend codex    # 前台显示实时面板；使用 --detach 转入后台
ultracode resume <runId> [--script edited.js]   # 直接重放未变化的 journal 前缀
```

## 命令

|    | 命令                                | 功能                                                                                    |
| -- | --------------------------------- | ------------------------------------------------------------------------------------- |
| 编写 | `validate <script>`               | 检查 meta 块、方言约束以及脚本是否可编译                                                               |
|    | `lint <script>`                   | 检查工作流在 Claude Code、Qoder 原生引擎和 ultracode 之间的可移植性                                      |
| 运行 | `run <script>`                    | 运行工作流：前台显示实时面板，使用 `--detach` 转入后台，使用 `--dry-run` 进行免费的 mock 演练                        |
|    | `resume <runId>`                  | 直接重放未变化且已成功的 journal 前缀，也支持 `--script edited.js`；剩余部分继续实时运行                           |
|    | `stop <runId>`                    | 停止正在运行的工作流（SIGTERM → 等待 7 秒 → SIGKILL）                                                |
| 查看 | `watch <runId>`                   | 打开实时面板，查看阶段、各 agent 的 token 数和耗时；↑/↓ 选择 agent，⏎ 查看详情，q 退出查看                           |
|    | `status <runId>`                  | 显示运行状态，包括阶段、agent 和预算；`--watch` 会持续轮询直到运行结束                                           |
|    | `logs <runId>`                    | 输出运行事件；`--follow` 会持续跟踪新日志                                                            |
|    | `list`                            | 列出运行记录存储中的最近任务；使用 `--all` 查看全部记录                                                      |
| 集成 | `install <codex\|qoder\|generic>` | 安装 skill 和宿主触发器（AGENTS.md 片段或 Qoder 规则）；以用户级方式安装 Codex 时，还会注册 MCP 服务器                 |
|    | `doctor`                          | 探测各后端的可用性、版本和鉴权方式                                                                     |
|    | `mode [on\|off]`                  | 读取或设置常驻的 ultracode 模式标记（`.ultracode/mode`）                                            |
|    | `sync`                            | 将 `.ultracode/workflows` 中的权威版本同步到 `.claude/` 和 `.qoder/`                             |
|    | `mcp`                             | 启动 stdio MCP 服务器，提供 `workflow_start`、`workflow_status`、`workflow_result`，以及 stop/list |

## 文档

* `docs/architecture.md`——介绍为何将 skill、引擎和插件分层设计，Qoder 原生引擎策略、v1 范围，以及已经完成的端到端验证。
* `docs/threat-model.md`——说明信任模型、沙箱能力边界、并发与鉴权机制，以及 worker 可写的运行记录存储。
* `skill/ultracode/references/dialect.md`——完整的工作流方言参考；同目录下的 `portability.md` 介绍跨引擎可移植子集。
* `docs/design/judge.md`——记录设计过程：由 3 位架构师提出方案、再由评审综合形成架构与里程碑计划。相关设计建立在源码级研究之上，包括 Claude Code 的 ultracode 机制、Codex/Qoder CLI 内部实现、MCP 长时间运行工具的约束，以及 JS 沙箱的取舍。
* `SUPPORTED_VERSIONS.md`——列出锁定的 CLI 版本、平台说明和实际测试门禁。

## 项目状态

目前尚未发布到 npm。仅支持 Linux 和 macOS；由于依赖 POSIX 进程组，暂不支持 Windows。完整范围与暂缓事项见 `docs/architecture.md`。
