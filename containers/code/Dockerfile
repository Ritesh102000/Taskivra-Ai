# setup.mjs verifies this local tag resolves to the retained immutable Phase 0 ID.
# COPY-only; no network, package manager, or implicit image downloads.
FROM agent-workspaces-phase0-code:2026-09-11
LABEL io.agent-workspaces.code.protocol="4"
LABEL io.agent-workspaces.code.packages="[]"
COPY --chmod=0555 workers/code /opt/agent-code
WORKDIR /opt/agent-code
ENTRYPOINT ["python3","-I","/opt/agent-code/supervisor.py","init"]
