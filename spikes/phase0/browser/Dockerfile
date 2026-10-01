# Verified linux/arm64 manifest for node:26.7.0-bookworm-slim on 2026-09-11.
FROM node:26.7.0-bookworm-slim@sha256:2b028cd57303b2761d24173789c85a013558d6cf20e78f51723385f368b6e34d
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/browsers
WORKDIR /opt/browser-worker
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund \
    && node node_modules/playwright-core/cli.js install --with-deps --only-shell chromium \
    && npm cache clean --force \
    && rm -rf /var/lib/apt/lists/* /tmp/* \
    && mkdir -p /profile \
    && chown 1000:1000 /profile \
    && dpkg-query -W > /opt/browser-worker/image-packages.txt
COPY protocol.mjs worker.mjs ./
USER 1000:1000
ENV HOME=/tmp
ENTRYPOINT ["node", "/opt/browser-worker/worker.mjs"]
