<div align="center">

<img src="public/icon-512.png" width="104" alt="Codex Window Runner logo — three schedule slots, the center one lit amber">

# Codex Window Runner

**A station timetable for your Codex fleet.**

Four departures a day. Every account on its own five-hour window.
One private, self-hosted console.

![Node](https://img.shields.io/badge/node-%E2%89%A522-161e28?style=flat-square&labelColor=10161d&color=f5a83c)
![Codex CLI](https://img.shields.io/badge/codex_cli-0.154.0--alpha.3-161e28?style=flat-square&labelColor=10161d&color=f5a83c)
![Docker Compose](https://img.shields.io/badge/runs_with-docker_compose-161e28?style=flat-square&labelColor=10161d&color=f5a83c)

</div>

---

Codex usage resets in roughly five-hour windows. This service keeps a fleet of ChatGPT/Codex accounts inside that rhythm: at every scheduled time it sends a ping into each enabled account's persistent Codex thread, spaced `5h05` apart, so local-message usage stays aligned with the documented windows.

It cannot see OpenAI's internal reset clock. What it does is simple and predictable: fixed local times, no duplicate sends within a minute, and a console that shows exactly what departed, what failed, and when the next train leaves.

## The console

A signal-box dashboard: a live station clock, a split-flap **next send** module, per-account usage windows with reset times, distinct weekly `gpt-reserve` fallback allowances, a fleet-wide quota strip with a 24-hour reset timetable, and a departures board built from actual run history.

```
TODAY'S SENDS                        ✓ done   ✕ failed   ⏸ skipped   ● running

account        08:00    13:05    18:10    23:15
primary           ✓        ✓        ✕        ·
secondary         ✓        ⏸        ·        ·
```

Every cell comes from a real run record for that account, that slot, that day — nothing simulated.

## How it works

1. **Scheduler** ticks every 10 seconds and matches the local `HH:mm` against each account's effective schedule times (timezone-aware).
2. For each matched account it **resumes — or creates — that account's persistent Codex thread** through its own `codex app-server` process.
3. It sends a `turn/start` with the configured prompt, sandbox, and approval policy. If the thread is already mid-turn and *skip if active* is set, the send is skipped instead of queued.
4. Codex events stream back over SSE: turn lifecycle, replies, and per-account rate-limit windows, all attributed to their account in the activity feed.

Each account is fully isolated: its own `CODEX_HOME` (credentials), its own app-server process, its own thread, dashboard, and rate-limit tracking. One account's expired token never blocks the rest.

## Quick start

```bash
mkdir -p workspace
docker compose up -d --build
```

Open the UI:

```text
http://127.0.0.1:8787
```

On iPhone, open the HTTPS URL in Safari, tap **Share**, then **Add to Home Screen**. The installed app uses a standalone, safe-area-aware layout. It immediately shows a privacy-reduced saved fleet snapshot while live data loads; prompts, messages, workspace paths, credentials, and API responses are not stored in that snapshot. Its offline shell can open without a network connection, but account management still requires access to this server.

Then log in: **Account console → Manage selected account → Start device login**. The container runs `codex login --device-auth`; open the shown URL in any browser, sign in, and enter the code. Credentials land in the persistent volume and survive restarts and rebuilds.

## Multiple accounts

- The original login migrates to **Default account**; add more from **Manage selected account** in the Account console.
- Additional credentials live under `/data/codex-accounts/<account-id>/`.
- Enabled accounts are pinged at every configured time; disabled accounts stay logged in but are skipped.
- The server refreshes account authentication and quota windows every five minutes even when no browser is open; visible clients continue polling and can request an immediate refresh.
- Reserve is shown separately from ordinary quota, including its weekly reset date. Its state becomes **active** only when Codex explicitly reports that ordinary usage is unavailable; percentages are never used to infer activation. Available usage-reset credits and every reported expiration are shown for each account.
- **Remove** stops the account's app-server and permanently deletes its Codex home, including `auth.json`. The last remaining account cannot be removed.
- Login, logout, and run-now controls all apply to the selected account.

### Per-account overrides

Under *Account console → Manage selected account → Per-account overrides*. Leave a field empty to inherit the global default from Settings.

| Override | Use it to |
|---|---|
| Schedule times | Stagger accounts across the day instead of firing all at once |
| Prompt template | Give each account its own standing instructions |
| Model override | Run different models per plan or per job |
| Workspace directory | Give simultaneous agents separate sandboxes |

The header's *Next send* covers the union of enabled accounts' schedules.

## Security model

This is a **private admin app** with full control over Codex sessions. Do not expose it to the public internet.

- Bind the port to localhost, or to your LAN only if that network is trusted.
- Put it behind **Cloudflare Tunnel + Cloudflare Access**.
- Set `ADMIN_EMAILS` so the backend only accepts requests carrying a matching Access-authenticated email header. This is defense in depth — if the app is directly exposed, those headers can be spoofed.
- The app never asks for your ChatGPT password and never displays tokens. Treat the data volume like a password store — **backups contain live credentials; encrypt them**.
- `codex login status` reports credential *presence*, not validity. The service therefore verifies authentication through live Codex requests and reports rejected or expired credentials as an **auth issue**. Re-login from the Account console; a successful device login restarts that account's app-server so it uses the new credentials.

## Configuration

Environment variables (defaults shown are the in-container values):

| Name | Default | Purpose |
|---|---|---|
| `TZ` | `Europe/Lisbon` | Container timezone |
| `PORT` | `8080` | HTTP port inside the container |
| `DATA_DIR` | `/data/app` | Service state (`store.json`, history) |
| `CODEX_HOME` | `/data/codex-home` | Default account's Codex home |
| `CODEX_ACCOUNTS_DIR` | `/data/codex-accounts` | Codex homes for additional accounts |
| `WORKSPACE_DIR` | `/workspace` | Codex cwd and writable root |
| `ADMIN_EMAILS` | unset | Optional Cloudflare Access email allowlist |
| `TELEGRAM_BOT_TOKEN` | unset | Telegram bot token; keep only in the server's ignored `.env` |
| `TELEGRAM_CHAT_ID` | unset | Destination user, group, or channel chat ID |

Managed in the web UI under Settings: timezone, schedule times, workspace directory, model, effort, summary, approval policy, network access for scheduled turns, skip-if-active, and the scheduled prompt template. Network access is off by default; the default approval policy is `on-request`.

### Telegram alerts

1. Create a dedicated bot with Telegram's `@BotFather` and start a conversation with it, or add it to the intended private group.
2. Obtain the destination chat ID through Telegram's Bot API, then put `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` in the deployment's ignored `.env` file. Never commit either value.
3. Recreate the container, open **Schedule → Telegram alerts**, send a test alert, then enable the categories you want.

Alerts are disabled by default. The service can notify on configurable quota-warning crossings, fixed 95% and 100% crossings, quota-window resets, Luna Reserve activation/recovery, usage-reset inventory changes and upcoming expirations, and authentication or scheduled-send failures. Quota polling remains every five minutes, so alerts may arrive up to roughly five minutes after a transition. Messages are grouped per account and emitted only when state crosses a boundary; unchanged readings do not repeat alerts. Pending messages are persisted without credentials and retried with exponential backoff after transient Telegram failures. Delivery is at least once: because Telegram has no idempotency key for `sendMessage`, a process crash immediately after Telegram accepts a message can cause that message to be sent again after restart.

Bot credentials remain server-side, are removed from Codex subprocess environments, and are not returned by the API or saved in `store.json`. Telegram still receives account labels and the alert facts included in each message, so use a private destination and choose labels appropriate for that disclosure.

## Operations

```bash
# follow service and Codex activity
docker compose logs -f codex-window-runner

# health check
docker compose exec codex-window-runner \
  node -e "fetch('http://localhost:8080/api/health').then(r=>r.text()).then(console.log)"

# full data backup — contains Codex credentials, encrypt the result
docker compose exec codex-window-runner tar czf - /data > codex-data-backup-$(date +%F).tgz
```

Update:

```bash
git pull && docker compose up -d --build
```

The Codex CLI version is pinned by the `CODEX_PACKAGE_VERSION` build arg, so rebuilds never surprise-upgrade Codex. The current alpha pin is required because the latest stable CLI does not yet expose Reserve usage capabilities. Rollback is `git checkout <ref> && docker compose up -d --build`; the store format migrates forward automatically and old code ignores newer fields.

The bundled compose binds `127.0.0.1:8787:8080`. To listen on another interface, add a `docker-compose.override.yml` (kept out of git) rather than editing the tracked file.

## Known trade-offs

- Node's standard library plus Server-Sent Events instead of a framework stack — same behavior for a single-user service, zero native dependencies.
- `codex app-server` is experimental upstream; a protocol change may require adapter updates.
- Device-code login depends on Codex and your ChatGPT workspace allowing it. Fallback: copy a valid `auth.json` into the account's persistent `CODEX_HOME`.
- A `bubblewrap not found` warning at startup is expected on slim images; Codex uses its bundled copy.

---

*Built for a fleet of one — but the board scales.*
