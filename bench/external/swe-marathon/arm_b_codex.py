"""Harbor 0.17.1 Codex bridge for the SWE-Marathon ultracode arm."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, override

from harbor.agents.installed.codex import Codex
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext
from harbor.models.trial.paths import EnvironmentPaths


ARM_B_PREFIX = (
    "ultracode: route the task below through a multi-agent workflow. "
    "The ultracode MCP tools (workflow_start/workflow_status/workflow_result) "
    "are available. Use backend \"codex\" and permission \"danger\" "
    "(this container is the sandbox).\n\n"
)
TERMINAL_WORKFLOW_STATES = {"completed", "failed", "stopped", "orphaned"}


class ArmBCodex(Codex):
    """Arm B with canonical triggering, lifecycle waiting, and full telemetry."""

    _ULTRACODE_HOME = "/tmp/swe-marathon-ultracode"
    _WORKER_CODEX_HOME = "/tmp/swe-marathon-worker-codex"

    def __init__(
        self,
        *args: Any,
        workflow_wait_seconds: int | str = 3_300,
        **kwargs: Any,
    ) -> None:
        super().__init__(*args, **kwargs)
        try:
            self._workflow_wait_seconds = int(workflow_wait_seconds)
        except (TypeError, ValueError) as exc:
            raise ValueError("workflow_wait_seconds must be an integer") from exc
        if self._workflow_wait_seconds < 1:
            raise ValueError("workflow_wait_seconds must be positive")

    @override
    def _build_register_mcp_servers_command(self) -> str | None:
        """Install the tracked MCP bridge without choosing a model or effort."""
        if not self.model_name:
            raise ValueError("Model name is required")
        model = self.model_name.split("/")[-1]
        effort = self._resolved_flags.get("reasoning_effort")
        worker_config = [
            f"model = {json.dumps(model)}",
            f"web_search = {json.dumps('disabled')}",
        ]
        if isinstance(effort, str):
            worker_config.append(
                f"model_reasoning_effort = {json.dumps(effort)}"
            )
        worker_config_text = "\n".join(worker_config)
        return f'''set -e
rm -rf {self._WORKER_CODEX_HOME}
mkdir -p {self._WORKER_CODEX_HOME}
cp -L "$CODEX_HOME/auth.json" {self._WORKER_CODEX_HOME}/auth.json
chmod 600 {self._WORKER_CODEX_HOME}/auth.json
cat >{self._WORKER_CODEX_HOME}/config.toml <<'WORKER_TOML'
{worker_config_text}
WORKER_TOML
cat >>"$CODEX_HOME/config.toml" <<TOML

[mcp_servers.ultracode]
command = "/opt/bench/node-sel"
args = ["/opt/bench/ultracode/dist/cli/main.js", "mcp"]
tool_timeout_sec = 3600
default_tools_approval_mode = "approve"

[mcp_servers.ultracode.env]
CODEX_HOME = "{self._WORKER_CODEX_HOME}"
ULTRACODE_HOME = "{self._ULTRACODE_HOME}"
ULTRACODE_CODEX_BIN = "/usr/local/bin/codex"
PATH = "/opt/bench:/usr/local/bin:/usr/local/sbin:/usr/bin:/bin"
HOME = "$HOME"
TOML
cat >"$CODEX_HOME/AGENTS.md" <<'AGENTS'
<!-- ultracode:begin -->
## ultracode (dynamic workflow orchestration)

Only when the user writes "ultracode" as their request, read the ultracode
skill and route the task through a multi-agent workflow. The keyword arms the
mode for the session. If ULTRACODE_INSIDE_RUN is set, you are a worker: never
start another workflow; do the assigned task directly and return.
<!-- ultracode:end -->
AGENTS'''

    async def _wait_for_workflows(self, environment: BaseEnvironment) -> None:
        command = f'''/opt/bench/node-sel - <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const home = {json.dumps(self._ULTRACODE_HOME)};
const deadline = Date.now() + Number(process.env.MARATHON_WAIT_SECONDS) * 1000;
const terminal = new Set({json.dumps(sorted(TERMINAL_WORKFLOW_STATES))});
function runIds() {{
  const runs = path.join(home, 'runs');
  if (!fs.existsSync(runs)) return [];
  return fs.readdirSync(runs, {{ withFileTypes: true }})
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
}}
function active() {{
  const runs = path.join(home, 'runs');
  return runIds().filter((runId) => {{
    try {{
      const manifest = JSON.parse(fs.readFileSync(path.join(runs, runId, 'manifest.json'), 'utf8'));
      return !terminal.has(String(manifest.status));
    }} catch {{
      return true;
    }}
  }});
}}
(async () => {{
  if (runIds().length === 0) {{
    process.stderr.write('Arm B did not start an ultracode run\\n');
    process.exitCode = 1;
    return;
  }}
  while (active().length > 0 && Date.now() < deadline) {{
    await new Promise((resolve) => setTimeout(resolve, 5_000));
  }}
  const expired = active();
  if (expired.length === 0) return;
  process.stderr.write(`workflow wait expired; stopping: ${{expired.join(', ')}}\n`);
  const {{ spawnSync }} = require('node:child_process');
  for (const runId of expired) {{
    spawnSync(
      '/opt/bench/node-sel',
      ['/opt/bench/ultracode/dist/cli/main.js', 'stop', runId],
      {{ stdio: 'inherit', env: {{ ...process.env, ULTRACODE_HOME: home }} }},
    );
  }}
  const stopDeadline = Date.now() + 120_000;
  while (active().length > 0 && Date.now() < stopDeadline) {{
    await new Promise((resolve) => setTimeout(resolve, 5_000));
  }}
  const remaining = active();
  if (remaining.length > 0) {{
    process.stderr.write(`workflows did not stop: ${{remaining.join(', ')}}\n`);
  }}
  process.exitCode = 1;
}})();
NODE'''
        result = await self.exec_as_agent(
            environment,
            command,
            env={"MARATHON_WAIT_SECONDS": str(self._workflow_wait_seconds)},
            timeout_sec=self._workflow_wait_seconds + 150,
        )
        if result.return_code != 0:
            raise RuntimeError(
                "Arm B workflow wait command failed with return code "
                f"{result.return_code}"
            )

    async def _preserve_artifacts(self, environment: BaseEnvironment) -> None:
        agent_dir = EnvironmentPaths.agent_dir.as_posix()
        result = await self.exec_as_agent(
            environment,
            f'''set -e
test -d {self._WORKER_CODEX_HOME}/sessions
test -d {self._ULTRACODE_HOME}/runs
mkdir -p {agent_dir}/sessions
cp -a {self._WORKER_CODEX_HOME}/sessions/. {agent_dir}/sessions/
rm -f {self._WORKER_CODEX_HOME}/auth.json
rm -rf {agent_dir}/ultracode
cp -a {self._ULTRACODE_HOME} {agent_dir}/ultracode
rm -rf {self._WORKER_CODEX_HOME}''',
        )
        if result.return_code != 0:
            raise RuntimeError(
                "Arm B artifact preservation failed with return code "
                f"{result.return_code}"
            )

    @override
    async def run(
        self,
        instruction: str,
        environment: BaseEnvironment,
        context: AgentContext,
    ) -> None:
        try:
            await super().run(ARM_B_PREFIX + instruction, environment, context)
        finally:
            wait_error: BaseException | None = None
            try:
                await self._wait_for_workflows(environment)
            except BaseException as exc:
                wait_error = exc
                self.logger.exception(
                    "Ultracode workflows did not reach terminal state before verification"
                )
            try:
                await self._preserve_artifacts(environment)
            except BaseException:
                self.logger.exception("Failed to preserve Arm B sessions and run store")
                raise
            if wait_error is not None:
                raise RuntimeError(
                    "Arm B workflow lifecycle did not finish cleanly"
                ) from wait_error

    @staticmethod
    def _read_json(path: Path) -> dict[str, Any]:
        try:
            value = json.loads(path.read_text(errors="replace"))
        except (OSError, json.JSONDecodeError):
            return {}
        return value if isinstance(value, dict) else {}

    @classmethod
    def _read_json_lines(cls, path: Path) -> list[dict[str, Any]]:
        try:
            lines = path.read_text(errors="replace").splitlines()
        except OSError:
            return []
        records: list[dict[str, Any]] = []
        for line in lines:
            try:
                value = json.loads(line)
            except json.JSONDecodeError:
                continue
            if isinstance(value, dict):
                records.append(value)
        return records

    def _host_session_id(self) -> str | None:
        for record in self._read_json_lines(self.logs_dir / self._OUTPUT_FILENAME):
            if record.get("type") != "thread.started":
                continue
            thread_id = record.get("thread_id")
            if isinstance(thread_id, str):
                return thread_id
        return None

    def _workflow_metadata(
        self,
    ) -> tuple[list[dict[str, Any]], dict[str, str]]:
        workflows: list[dict[str, Any]] = []
        session_backends: dict[str, str] = {}
        runs_dir = self.logs_dir / "ultracode" / "runs"
        if not runs_dir.is_dir():
            return workflows, session_backends

        for run_dir in sorted(path for path in runs_dir.iterdir() if path.is_dir()):
            config = self._read_json(run_dir / "config.json")
            manifest = self._read_json(run_dir / "manifest.json")
            output = self._read_json(run_dir / "output.json")
            configured_backend = config.get("backend")
            backends: set[str] = set()
            if isinstance(configured_backend, str):
                backends.add(configured_backend)
            for result_path in sorted((run_dir / "agents").glob("*/result.json")):
                result = self._read_json(result_path)
                backend = result.get("backend")
                session_id = result.get("sessionId")
                if isinstance(backend, str):
                    backends.add(backend)
                    if isinstance(session_id, str):
                        session_backends[session_id] = backend
            result_total = output.get("totalTokens")
            observed_total = result_total if isinstance(result_total, int) else 0
            billable = any(backend != "mock" for backend in backends)
            workflows.append(
                {
                    "run_id": run_dir.name,
                    "status": manifest.get("status", "unknown"),
                    "backends": sorted(backends),
                    "billable": billable,
                    "observed_total_tokens": observed_total,
                    "billable_total_tokens": observed_total if billable else 0,
                }
            )
        return workflows, session_backends

    def _collect_arm_b_metrics(self) -> dict[str, Any]:
        host_session_id = self._host_session_id()
        workflows, session_backends = self._workflow_metadata()
        sessions: list[dict[str, Any]] = []
        observed_totals = {
            "input_tokens": 0,
            "cached_input_tokens": 0,
            "output_tokens": 0,
            "reasoning_output_tokens": 0,
        }
        billable_totals = dict(observed_totals)

        for rollout in sorted((self.logs_dir / "sessions").rglob("rollout-*.jsonl")):
            total_usage: dict[str, Any] = {}
            context_peak = 0
            context_window: int | None = None
            session_id: str | None = None
            event_compactions = 0
            record_compactions = 0
            prompt_samples: list[int] = []

            for record in self._read_json_lines(rollout):
                if record.get("type") == "compacted":
                    record_compactions += 1
                    continue
                payload = record.get("payload")
                if not isinstance(payload, dict):
                    continue
                if record.get("type") == "session_meta":
                    value = payload.get("session_id", payload.get("id"))
                    if isinstance(value, str):
                        session_id = value
                    continue
                if record.get("type") != "event_msg":
                    continue
                if payload.get("type") == "context_compacted":
                    event_compactions += 1
                    continue
                if payload.get("type") != "token_count":
                    continue
                info = payload.get("info")
                if not isinstance(info, dict):
                    continue
                current_total = info.get("total_token_usage")
                if isinstance(current_total, dict):
                    total_usage = current_total
                last = info.get("last_token_usage")
                if isinstance(last, dict):
                    prompt = last.get("input_tokens")
                    output = last.get("output_tokens")
                    if isinstance(prompt, int):
                        prompt_samples.append(prompt)
                        context_peak = max(
                            context_peak,
                            prompt + (output if isinstance(output, int) else 0),
                        )
                window = info.get("model_context_window")
                if isinstance(window, int):
                    context_window = window

            resolved_session_id = session_id or rollout.stem
            role = "host" if resolved_session_id == host_session_id else "worker"
            backend = "codex" if role == "host" else session_backends.get(
                resolved_session_id, "unknown"
            )
            billable = backend != "mock"
            for key in observed_totals:
                value = total_usage.get(key)
                if isinstance(value, int):
                    observed_totals[key] += value
                    if billable:
                        billable_totals[key] += value
            compactions = max(event_compactions, record_compactions)
            inferred_drops = sum(
                current < previous * 0.25
                for previous, current in zip(prompt_samples, prompt_samples[1:])
            )
            sessions.append(
                {
                    "session_id": resolved_session_id,
                    "role": role,
                    "backend": backend,
                    "billable": billable,
                    "compactions": compactions,
                    "inferred_prompt_drops": inferred_drops,
                    "context_peak": context_peak,
                    "context_window": context_window,
                    "last_prompt_tokens": prompt_samples[-1]
                    if prompt_samples
                    else 0,
                    "usage": total_usage,
                    "rollout": str(rollout.relative_to(self.logs_dir)),
                }
            )

        return {
            "schema_version": 1,
            "host_session_id": host_session_id,
            "session_count": len(sessions),
            "compaction_events": sum(session["compactions"] for session in sessions),
            "inferred_prompt_drops": sum(
                session["inferred_prompt_drops"] for session in sessions
            ),
            "context_peak": max(
                (session["context_peak"] for session in sessions), default=0
            ),
            "context_window": next(
                (
                    session["context_window"]
                    for session in sessions
                    if session["context_window"]
                ),
                None,
            ),
            "totals": billable_totals,
            "observed_totals": observed_totals,
            "mock_workflow_count": sum(
                not workflow["billable"] for workflow in workflows
            ),
            "workflows": workflows,
            "sessions": sessions,
        }

    @override
    def populate_context_post_run(self, context: AgentContext) -> None:
        metrics = self._collect_arm_b_metrics()
        (self.logs_dir / "arm_b_metrics.json").write_text(
            json.dumps(metrics, indent=2) + "\n"
        )
        totals = metrics["totals"]
        context.n_input_tokens = totals["input_tokens"]
        context.n_cache_tokens = totals["cached_input_tokens"]
        context.n_output_tokens = totals["output_tokens"]
        context.cost_usd = self._compute_cost_from_pricing(
            prompt_tokens=totals["input_tokens"],
            completion_tokens=totals["output_tokens"],
            cached_tokens=totals["cached_input_tokens"],
        )
        metadata = dict(context.metadata or {})
        metadata.update(
            {
                "arm_b_metrics": "arm_b_metrics.json",
                "mock_workflows_excluded_from_billing": metrics[
                    "mock_workflow_count"
                ],
            }
        )
        context.metadata = metadata
