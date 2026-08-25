# Codex Window Runner

Containerized single-user service that sends scheduled messages into one persistent Codex CLI thread at:

- `08:00`
- `13:05`
- `18:10`
- `23:15`

Default timezone: `Europe/Lisbon`.

The point is to keep Codex local-message usage aligned with its documented five-hour windows. This app cannot guarantee OpenAI's internal reset timing; it only spaces sends by `5h05` and avoids duplicate sends in the same local minute.

## What It Does

- Runs a local web UI for status, activity, settings, and account management.
- Uses `codex login --device-auth` for a headless Ubuntu server.
- Lets you complete Codex login from your normal remote browser.
- Persists each Codex account in its own Docker-volume-backed Codex home.
- Starts `codex app-server --listen stdio://` per logged-in account and sends `turn/start` requests to each account's stored thread.
- Streams service and Codex activity to the browser.
- Supports manual run-now messages, scheduled prompt editing, scheduler pause/resume, and Codex goal set/clear.

## Security Model

This is a private admin app. Do not expose it directly to the public internet.

Recommended setup:

- Bind the container to localhost only.
- Put it behind Cloudflare Tunnel + Cloudflare Access.
- Set `ADMIN_EMAILS` so the backend only accepts requests with a matching Cloudflare Access authenticated email header.

Important limits:

- `ADMIN_EMAILS` is defense in depth, not a replacement for Cloudflare Access. If the app is directly exposed, a client can spoof headers.
- The app never asks for your ChatGPT password.
- The app never displays `auth.json` or access tokens.
- Treat the Docker volume containing `/data/codex-home/auth.json` like a password store.

## Quick Start

Create the workspace directory used by Codex:

```bash
mkdir -p workspace
```

Start the service:

```bash
docker compose up -d --build
```

Open the UI from the server or through your private tunnel:

```text
http://127.0.0.1:8787
```

## Headless Codex Login

1. Open the web UI.
2. Go to `Accounts`.
3. Click `Start device login`.
4. The app runs this inside the container:

```bash
codex login --device-auth
```

5. The UI shows the official login URL and one-time code.
6. Open the URL in your normal browser, sign in, and enter the code.
7. The container writes credentials to:

```text
/data/codex-home/auth.json
```

The first migrated account uses `/data/codex-home`. Additional accounts use:

```text
/data/codex-accounts/<account-id>/auth.json
```

Because `/data` is a Docker volume, logins survive container restarts and rebuilds.

## Multiple Accounts

- The existing single-account login is migrated to `Default account`.
- Add accounts from the `Accounts` panel.
- Remove accounts with the `Remove` button. This stops the account's app-server and permanently deletes its Codex home directory, including its `auth.json` credentials.
- Each account has separate credentials, thread state, and rate-limit/window tracking.
- Enabled accounts receive scheduled pings at every configured schedule time.
- Disabled accounts remain logged in but are skipped by the scheduler.
- `Run now`, device login, logout, and goal controls apply to the selected account.

### Per-Account Overrides

Under `Accounts` > `Per-account overrides`, each account can override:

- Schedule times
- Scheduled prompt template
- Model override
- Workspace directory

Leave a field empty to inherit the global default from `Settings`. Overridden schedule times let accounts ping at different times instead of all at once; the `Next run` indicator covers the union of enabled accounts' schedules.

## Cloudflare Access

Example `docker-compose.yml` setting:

```yaml
environment:
  ADMIN_EMAILS: "you@example.com"
```

Keep the port bound to localhost:

```yaml
ports:
  - "127.0.0.1:8787:8080"
```

Then point Cloudflare Tunnel at:

```text
http://127.0.0.1:8787
```

## Configuration

Environment variables:

| Name | Default | Purpose |
|---|---:|---|
| `TZ` | `Europe/Lisbon` | Container local timezone. |
| `PORT` | `8080` | HTTP port inside the container. |
| `DATA_DIR` | `/data/app` | Service state directory. |
| `CODEX_HOME` | `/data/codex-home` | Codex config and auth directory. |
| `CODEX_ACCOUNTS_DIR` | `/data/codex-accounts` | Codex homes for additional accounts. |
| `WORKSPACE_DIR` | `/workspace` | Directory Codex uses as its cwd and writable root. |
| `ADMIN_EMAILS` | unset | Optional comma-separated Cloudflare Access email allowlist. |

Settings managed in the web UI:

- Timezone
- Schedule times
- Workspace directory
- Model override
- Effort
- Approval policy
- Summary mode
- Network access for scheduled turns
- Skip scheduled sends while a turn is already active
- Scheduled prompt template

## Operational Notes

- Scheduled sends run for every enabled account.
- Scheduled sends are skipped for an account if its stored thread is active and `skipIfActive` is enabled.
- Network access is disabled for scheduled turns by default.
- The default approval policy is `on-request`.
- The service stores event history in `/data/app/store.json`.
- If `codex app-server` exits, the next run or login completion will start it again.
- If the saved thread cannot be resumed, the service creates a new thread and records the failure in activity.

## Useful Commands

View logs:

```bash
docker compose logs -f codex-window-runner
```

Check login status inside the container:

```bash
docker compose exec codex-window-runner codex login status
```

Force a Codex logout:

```bash
docker compose exec codex-window-runner codex logout
```

Back up service state:

```bash
docker compose exec codex-window-runner tar czf - /data > codex-window-runner-data.tgz
```

The backup contains Codex credentials. Encrypt it.

## Known Trade-Offs

- This implementation uses Node's standard library plus Server-Sent Events instead of Fastify, React, WebSocket, and SQLite. The behavior is the same for this single-user service, but deployment is simpler and avoids native dependencies.
- `codex app-server` is documented as experimental. If the protocol changes, the app-server adapter may need updates.
- Device-code login depends on Codex and your ChatGPT account or workspace allowing device auth. If unavailable, copy `auth.json` into the persistent `CODEX_HOME` volume as a fallback.
