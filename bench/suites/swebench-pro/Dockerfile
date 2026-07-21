# Thin overlay over a per-instance SWE-bench Pro image: adds the pinned agent
# toolchain and a repository sanitized once by trusted host Git tooling. The
# overlay uses COPY only with no network; each arm gets an isolated writable
# container-layer copy after the trusted entrypoint hides the original /app.
ARG BASE_IMAGE
FROM ${BASE_IMAGE}
COPY --chown=0:0 --chmod=0555 node/          /opt/bench/node/
COPY --chown=0:0 --chmod=0555 node-musl/     /opt/bench/node-musl/
COPY --chown=0:0 --chmod=0555 node-musl-runtime/ /opt/bench/node-musl-runtime/
COPY --chown=0:0 --chmod=0555 node-sel       /opt/bench/node-sel
COPY --chown=0:0 --chmod=0555 codex          /opt/bench/bin/codex
COPY --chown=0:0 --chmod=0555 ultracode/     /opt/bench/ultracode/
COPY --chown=0:0 --chmod=0555 codex-home-a/  /opt/bench/codex-home-a/
COPY --chown=0:0 --chmod=0555 codex-home-b/  /opt/bench/codex-home-b/
COPY --chown=0:0 --chmod=0555 agents-home-b/ /opt/bench/agents-home-b/
COPY --chown=0:0 --chmod=0555 entrypoint.sh  /opt/bench/entrypoint.sh
COPY --chown=0:0 --chmod=0555 session-gate.sh /opt/bench/session-gate.sh
COPY --chown=0:0 --chmod=0555 drop-privileges.mjs /opt/bench/drop-privileges.mjs
COPY --chown=0:0 --chmod=0555 capture-git.sh /opt/bench/capture-git.sh
COPY --chown=0:0 sanitized-repository/ /opt/bench/sanitized-repository/
COPY --chown=0:0 --chmod=0444 git-audit.txt /opt/bench/git-audit.txt
COPY --chown=0:0 --chmod=0444 predirty.z /opt/bench/predirty.z
COPY --chown=0:0 --chmod=0444 pre-status.txt /opt/bench/pre-status.txt
