"""Harbor 0.17.1 Codex bridge for the SWE-Marathon Arm-B lifecycle."""

from __future__ import annotations

from datetime import UTC, datetime
import json
from pathlib import Path
from time import monotonic
from typing import Any, override

from harbor.agents.installed.codex import Codex
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext
from harbor.models.trial.paths import EnvironmentPaths


ARM_B_PREFIX_PATH = Path(__file__).resolve().parents[1] / "shared" / "arm-b-prefix.txt"
ARM_B_PREFIX = ARM_B_PREFIX_PATH.read_text(encoding="utf-8")


class ArmBCodex(Codex):
    """Arm B with canonical prompting, terminal waiting, and lifecycle evidence."""

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
        self._wait_started_at: str | None = None
        self._wait_ended_at: str | None = None
        self._wait_elapsed_ms = 0

    @override
    def _build_register_mcp_servers_command(self) -> str | None:
        """Install the tracked MCP bridge without choosing model defaults."""
        if not self.model_name:
            raise ValueError("Model name is required")
        model = self.model_name.split("/")[-1]
        effort = self._resolved_flags.get("reasoning_effort")
        worker_config = [
            f"model = {json.dumps(model)}",
            f"web_search = {json.dumps('disabled')}",
        ]
        if isinstance(effort, str):
            worker_config.append(f"model_reasoning_effort = {json.dumps(effort)}")
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
TOML'''

    async def _wait_for_workflows(self, environment: BaseEnvironment) -> None:
        command = f'''/opt/bench/node-sel - <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const home = {json.dumps(self._ULTRACODE_HOME)};
const deadline = Date.now() + Number(process.env.MARATHON_WAIT_SECONDS) * 1000;
function runIds() {{
  const runs = path.join(home, 'runs');
  if (!fs.existsSync(runs)) return [];
  return fs.readdirSync(runs, {{ withFileTypes: true }})
    .filter((entry) => entry.isDirectory()).map((entry) => entry.name);
}}
(async () => {{
  const {{ listRuns }} = await import('file:///opt/bench/ultracode/dist/store/runstore.js');
  const {{ isTerminal }} = await import('file:///opt/bench/ultracode/dist/store/manifest.js');
  function active() {{
    const summaries = new Map(listRuns(home).map((run) => [run.runId, run]));
    return runIds().filter((runId) => {{
      const run = summaries.get(runId);
      return run === undefined || !isTerminal(run.effectiveStatus);
    }});
  }}
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
  const {{ spawnSync }} = require('node:child_process');
  for (const runId of expired) {{
    spawnSync('/opt/bench/node-sel', ['/opt/bench/ultracode/dist/cli/main.js', 'stop', runId],
      {{ stdio: 'inherit', env: {{ ...process.env, ULTRACODE_HOME: home }} }});
  }}
  const stopDeadline = Date.now() + 120_000;
  while (active().length > 0 && Date.now() < stopDeadline) {{
    await new Promise((resolve) => setTimeout(resolve, 5_000));
  }}
  process.exitCode = 1;
}})();
NODE'''
        self._wait_started_at = datetime.now(UTC).isoformat()
        started = monotonic()
        try:
            result = await self.exec_as_agent(
                environment,
                command,
                env={"MARATHON_WAIT_SECONDS": str(self._workflow_wait_seconds)},
                timeout_sec=self._workflow_wait_seconds + 150,
            )
        finally:
            self._wait_elapsed_ms = round((monotonic() - started) * 1_000)
            self._wait_ended_at = datetime.now(UTC).isoformat()
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

    def _host_session_id(self) -> str | None:
        events = self.logs_dir / self._OUTPUT_FILENAME
        try:
            lines = events.read_text(errors="replace").splitlines()
        except OSError:
            return None
        for line in lines:
            try:
                record = json.loads(line)
            except json.JSONDecodeError:
                continue
            if isinstance(record, dict) and record.get("type") == "thread.started":
                thread_id = record.get("thread_id")
                if isinstance(thread_id, str):
                    return thread_id
        return None

    def _workflow_lifecycle(self) -> list[dict[str, Any]]:
        runs = self.logs_dir / "ultracode" / "runs"
        if not runs.is_dir():
            return []
        output: list[dict[str, Any]] = []
        for run in sorted(path for path in runs.iterdir() if path.is_dir()):
            manifest = self._read_json(run / "manifest.json")
            output.append({"run_id": run.name, "status": manifest.get("status", "unknown")})
        return output

    @override
    def populate_context_post_run(self, context: AgentContext) -> None:
        super().populate_context_post_run(context)
        lifecycle = {
            "schema_version": 2,
            "host_session_id": self._host_session_id(),
            "wait_started_at": self._wait_started_at,
            "wait_ended_at": self._wait_ended_at,
            "wait_elapsed_ms": self._wait_elapsed_ms,
            "workflows": self._workflow_lifecycle(),
        }
        (self.logs_dir / "arm_b_lifecycle.json").write_text(
            json.dumps(lifecycle, indent=2) + "\n"
        )
