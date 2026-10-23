<div align="center">

<img src="public/icon-512.png" width="104" alt="Codex Window Runner logo — three schedule slots, the center one lit amber">

# Codex Window Runner

**A clear view of your Codex account windows.**

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

A Liquid Glass-inspired dashboard with translucent floating navigation, native system typography, light and dark themes, and clear data surfaces. Fleet quota, history, reset horizons, account controls, schedules, and activity share one responsive layout. Reduced motion, reduced transparency, keyboard focus, and mobile safe areas are respected.

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

Connect an account from **Account console → Sign in**. Copy the one-time code, choose **Continue to OpenAI**, and enter the code on the sign-in page. Return to the console for automatic confirmation; technical output stays under **Sign-in diagnostics**. Credentials stay in the persistent server volume and survive restarts and rebuilds.

## Multiple accounts

- The original login migrates to **Default account**; add more with **Add account** in the Account console. New accounts have scheduled sends paused until you explicitly enable them after connecting.
- Additional credentials live under `/data/codex-accounts/<account-id>/`.
- Enabled accounts are pinged at every configured time; disabled accounts stay logged in but are skipped.
- The server is the sole automatic quota poller and continues when no browser is open. It checks every minute for 10 minutes after detected consumption, then backs off to 2, 5, and finally 10 minutes as the account fleet stays idle. A manual refresh remains available.
- Meaningful 5-hour, weekly, and Reserve changes are retained per account for 30 days plus one boundary baseline, capped at 5,000 samples. **Quota history** appears in **Fleet overview** as separate 5-hour and weekly charts with one line per account. The plots resize without horizontal scrolling; date-aware ticks adapt to the available width. Hover or tap a chart to inspect every account at the same time, including overlapping lines, or focus it and use the arrow keys and Home/End. Account buttons toggle series for comparisons. Missing observations remain gaps; cached snapshots and last-known readings from earlier polls are labeled, while plotted lines stop at their last observation. Range summaries show observed lows, changes, and replenishments without claiming an exact historical reset time. Unchanged reads are not stored.
- Reserve is shown separately from ordinary quota, including its weekly reset date. Its state becomes **active** only when Codex explicitly reports that ordinary usage is unavailable and a current Reserve allowance exists; percentages are never used to infer activation. Available usage-reset credits and every reported expiration are shown for each account.
- **Remove** stops the account's app-server and permanently deletes its Codex home, including `auth.json`. The last remaining account cannot be removed.
- Login, logout, and run-now controls all apply to the selected account.

### Per-account overrides

Under *Account console → Account settings → Custom run settings*. Leave a field empty to use the shared default from Schedule.

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

Managed in **Schedule → Edit schedule**, with tabs for timing, run settings, and alerts: timezone, schedule times, workspace directory, model, effort, summary, approval policy, network access for scheduled turns, skip-if-active, and the scheduled prompt template. Network access is off by default; the default approval policy is `on-request`.

The **Model** dropdown in Schedule settings defaults to **Automatic · prefer lowest cost**. It selects from each account's Codex `model/list` catalog, preferring GPT-6 Luna, then GPT-5.6 Luna when the newer model is absent. Remaining known models follow published Standard credit rates; unknown catalogs fall back to their default model. Catalogs are cached for five minutes, and a listed model's account access is confirmed only by a completed turn. The dropdown in account overrides can select a different model or inherit the global setting. An explicit model missing from an account's catalog fails with an actionable message instead of silently choosing another model.

The selected model is sent explicitly when creating/resuming threads and starting turns, so an old thread or CLI default cannot restore retired GPT-5.5. Scheduled and manual turns use Standard speed to avoid inherited Fast pricing. GPT-5.5 is excluded from the picker following its October 14, 2026 retirement for ChatGPT sign-in. Existing explicit overrides remain visible as unavailable until changed. Model availability depends on the pinned CLI and account; upgrading the CLI may expose newer choices. See [OpenAI's model guidance](https://learn.chatgpt.com/docs/models) and [Standard credit rates](https://learn.chatgpt.com/docs/pricing).

### Telegram alerts

1. Create a dedicated bot with Telegram's `@BotFather` and start a conversation with it, or add it to the intended private group.
2. Obtain the destination chat ID through Telegram's Bot API, then put `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` in the deployment's ignored `.env` file. Never commit either value.
3. Recreate the container, open **Schedule → Edit schedule → Alerts**, send a test alert, then enable the categories you want.

Alerts are disabled by default. The service can notify on configurable quota-warning crossings, fixed 95% and 100% crossings, quota-window resets, Luna Reserve activation/recovery, usage-reset inventory changes and upcoming expirations, and authentication or scheduled-send failures. Adaptive polling ranges from one minute during active consumption to ten minutes after long idle periods, so polling-based alerts have the same bounded delay; app-server quota notifications are processed immediately. Messages are grouped per account and emitted only when state crosses a boundary; unchanged readings do not repeat alerts. Pending messages are persisted without credentials and retried with exponential backoff after transient Telegram failures. Delivery is at least once: because Telegram has no idempotency key for `sendMessage`, a process crash immediately after Telegram accepts a message can cause that message to be sent again after restart.

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

## Frontend verification

`npm run check` checks JavaScript syntax. `npm test` runs the unit and local HTTP integration tests.

`npm run test:e2e` uses Playwright to launch the real server with a temporary data directory and a simulated Codex app-server. It never uses your account credentials or sends Telegram alerts. Install Playwright separately with its Chromium and WebKit browsers; production remains dependency-free:

```sh
npm install --no-save --package-lock=false playwright
npx --no-install playwright install chromium webkit
npm run test:e2e
```

What it does: installs local test tooling and browser binaries, then checks desktop, iPhone-sized, narrow, and landscape layouts, both themes, settings persistence, account selection, chart controls, activity outcomes over SSE, safe-area dock geometry, and offline recovery. Temporary test data is removed afterward. The schedule editor covers keyboard tabs, adding/removing individual times, save/cancel, and drafts retained after Escape and refresh. The account workflow also covers add/cancel, naming, draft preservation, failed sign-in and retry, completed sign-in, sign-out, and confirmed removal of a disposable fixture account. Clipboard writes are simulated so tests do not alter the host clipboard.

For an existing tooling installation, set `PLAYWRIGHT_MODULE` to its `playwright/index.mjs` path. Optional `CHROMIUM_EXECUTABLE_PATH` and `WEBKIT_EXECUTABLE_PATH` select installed browser executables. `E2E_CASE` filters viewport names and `E2E_OUTPUT_DIR` saves visual previews. Browser emulation does not verify a physical iPhone's home indicator or Safari chrome.

Account removal uses an in-page confirmation for the named account, locks while pending, and reconciles a lost acknowledgement before offering a retry. Browser coverage injects failed requests and refreshes to verify that a successful removal never needs a second DELETE. The server regression checks delayed Codex shutdown, cleanup, overlapping requests, and protection of the last account.
