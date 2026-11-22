ARG NODE_IMAGE=node:24.22.3-trixie-slim@sha256:af02d57b57719b9657a45199a79264a9437940cd55b3c7b3fc99615654f124a0

FROM ${NODE_IMAGE} AS build
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable pnpm
WORKDIR /src
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm run build \
 && pnpm pack --out /tmp/agentlane.tgz \
 && mkdir /package /production \
 && tar -xzf /tmp/agentlane.tgz -C /package --strip-components=1 \
 && chmod 755 /package/dist/cli.js \
 && cp package.json pnpm-lock.yaml /production/
WORKDIR /production
RUN pnpm install --prod --frozen-lockfile --ignore-scripts \
 && mv node_modules /package/

FROM ${NODE_IMAGE}
ARG VERSION=0.6.1
LABEL org.opencontainers.image.title="agentlane" \
      org.opencontainers.image.description="Run several AI coding agents on one machine, each with its own ports, dev servers, database and simulator, emulator or browser. Works with Claude Code, Codex, Cursor, GitHub Copilot, Gemini CLI and Antigravity, on web, iOS and Android." \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.source="https://github.com/north-star-hq/agentlane" \
      org.opencontainers.image.url="https://north-star-hq.github.io/agentlane/docs/docker.html" \
      org.opencontainers.image.documentation="https://north-star-hq.github.io/agentlane/docs/docker.html" \
      org.opencontainers.image.licenses="MIT"

ARG DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates git lsof procps tini unzip \
 && rm -rf /var/lib/apt/lists/* \
 && git config --system safe.directory '*' \
 && corepack enable pnpm \
 && mkdir -m 1777 /work

ENV HOME=/home/node \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0

COPY --from=build /package /opt/agentlane
RUN ln -s /opt/agentlane/dist/cli.js /usr/local/bin/agentlane

USER node
RUN agentlane browser install --json > /tmp/browser-install.json \
 && chmod -R a+rX /home/node/.local/share/agentlane \
 && mkdir -p /home/node/.cache \
 && chmod 1777 /home/node /home/node/.local /home/node/.local/share /home/node/.cache

USER root
RUN node "$(node -p 'require("/tmp/browser-install.json").playwrightCore')/cli.js" install-deps chromium \
 && rm -rf /var/lib/apt/lists/* /tmp/browser-install.json

USER node
WORKDIR /work
ENTRYPOINT ["/usr/bin/tini", "--", "agentlane"]
CMD ["mcp"]
