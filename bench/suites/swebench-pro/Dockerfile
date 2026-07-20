# Thin overlay over a per-instance SWE-bench Pro image: adds the pinned agent
# toolchain (node, codex, ultracode, CODEX_HOME templates) with COPY only — no
# RUN, no network — so a build after the base pull takes seconds and cannot
# fail per-instance. Build context is bench/.cache/toolchain (see toolchain.ts).
ARG BASE_IMAGE
FROM ${BASE_IMAGE}
COPY node/          /opt/bench/node/
COPY node-musl/     /opt/bench/node-musl/
COPY node-musl-runtime/ /opt/bench/node-musl-runtime/
COPY node-sel       /opt/bench/node-sel
COPY codex          /opt/bench/bin/codex
COPY ultracode/     /opt/bench/ultracode/
COPY codex-home-a/  /opt/bench/codex-home-a/
COPY codex-home-b/  /opt/bench/codex-home-b/
COPY agents-home-b/ /opt/bench/agents-home-b/
COPY entrypoint.sh  /opt/bench/entrypoint.sh
COPY sanitize-git.sh /opt/bench/sanitize-git.sh
COPY capture-git.sh /opt/bench/capture-git.sh
