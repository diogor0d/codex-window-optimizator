FROM node:22-bookworm-slim

ARG CODEX_PACKAGE_VERSION=0.142.5

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates git openssh-client tzdata \
  && npm install -g "@openai/codex@${CODEX_PACKAGE_VERSION}" \
  && apt-get clean \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json ./
COPY src ./src
COPY public ./public

RUN useradd --create-home --shell /usr/sbin/nologin app \
  && mkdir -p /data/app /data/codex-home /workspace \
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
