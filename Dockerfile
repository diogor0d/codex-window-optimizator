FROM node:22-bookworm-slim AS base

WORKDIR /app
RUN useradd --create-home --shell /usr/sbin/nologin app \
  && install -d -o app -g app -m 0700 /run/claude-worker

FROM base AS claude-deps
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
COPY package*.json ./
RUN npm_config_nodedir=/usr/local npm ci --omit=dev

FROM base AS claude-worker
ARG CLAUDE_PACKAGE_VERSION=2.1.303
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates tzdata \
  && npm install -g "@anthropic-ai/claude-code@${CLAUDE_PACKAGE_VERSION}" \
  && rm -rf /var/lib/apt/lists/* \
  && install -d -o app -g app -m 0700 /claude/accounts
COPY --from=claude-deps /app/node_modules ./node_modules
COPY --chown=app:app src/claude-client.mjs src/claude-usage.mjs src/claude-login.mjs src/claude-worker.mjs ./src/
USER app
ENV NODE_ENV=production
CMD ["node", "src/claude-worker.mjs"]

FROM base AS runner

ARG CODEX_PACKAGE_VERSION=0.154.0-alpha.3

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates git openssh-client tzdata \
  && npm install -g "@openai/codex@${CODEX_PACKAGE_VERSION}" \
  && apt-get clean \
  && rm -rf /var/lib/apt/lists/*

COPY package.json ./
COPY src ./src
COPY public ./public

RUN mkdir -p /data/app /data/codex-home /workspace \
  && chown -R app:app /app /data /workspace

USER app

ENV NODE_ENV=production
ENV PORT=8080
ENV TZ=Europe/Lisbon
ENV DATA_DIR=/data/app
ENV CODEX_HOME=/data/codex-home
ENV WORKSPACE_DIR=/workspace

EXPOSE 8080

CMD ["node", "src/server.mjs"]
