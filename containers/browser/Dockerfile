# The locally verified Phase 0 image already contains locked Playwright 1.63.0 and Chromium.
# Build from the repository root with --network=none --pull=false; there are no RUN/download steps.
# Setup verifies this local tag is exactly sha256:a32d31643c1ee3c0041d2f41c49e32fea386ea8d84cf579a72c0754ceb6a8817 before/after build.
FROM agent-workspaces-phase0-browser:1.63.0
LABEL io.agent-workspaces.browser.protocol="3"
COPY workers/browser/protocol.mjs workers/browser/files.mjs workers/browser/sandbox.mjs workers/browser/worker.mjs workers/browser/gmail.mjs workers/browser/dom-fence.mjs /opt/browser-worker/
USER 1000:1000
ENV HOME=/tmp
ENTRYPOINT ["node", "/opt/browser-worker/worker.mjs"]
