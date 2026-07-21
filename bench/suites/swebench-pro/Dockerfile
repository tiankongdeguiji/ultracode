# Thin overlay over a per-instance SWE-bench Pro image: adds the pinned agent
# toolchain (node, codex, ultracode, CODEX_HOME templates) with COPY only — no
# RUN, no network — so a build after the base pull takes seconds and cannot
# fail per-instance. Build context is bench/.cache/toolchain (see toolchain.ts).
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
COPY --chown=0:0 --chmod=0555 sanitize-git.sh /opt/bench/sanitize-git.sh
COPY --chown=0:0 --chmod=0555 capture-git.sh /opt/bench/capture-git.sh
