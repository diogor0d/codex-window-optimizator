<div align="center">

<img src="public/icon-512.png" width="104" alt="WindowRelay logo">

# WindowRelay

**Quota windows and scheduled messages for Codex and Claude Code.**

One private, self-hosted console for all your accounts.

![Node](https://img.shields.io/badge/node-%E2%89%A522-161e28?style=flat-square&labelColor=10161d&color=f5a83c)
![Codex CLI](https://img.shields.io/badge/codex_cli-0.154.0--alpha.3-161e28?style=flat-square&labelColor=10161d&color=f5a83c)
![Docker Compose](https://img.shields.io/badge/runs_with-docker_compose-161e28?style=flat-square&labelColor=10161d&color=f5a83c)

</div>

---

WindowRelay tracks quota windows across Codex and Claude Code accounts, sends manual and scheduled messages, resumes each account's conversation, and delivers Telegram alerts.

Choose shared daily send times or per-account overrides. The dashboard shows remaining quota, reported reset times, quota history, and run outcomes. Each scheduled slot is deduplicated per account.

## The console

A compact dashboard inspired by GitHub’s visual language: neutral surfaces, bordered lists, clear account actions, and light and dark themes. Desktop uses an underline navbar in the header; mobile keeps the floating pill dock at the bottom. Both switch between focused views:

- **Overview:** account capacity, search and status filters, reset timelines, a compact six-hour usage chart, and today’s sends. Open an account name to manage that account.
- **Accounts:** visible account naming, run settings, sign-in/sign-out, removal, quota details, and a message composer scoped to the selected account. **Send a message** opens this composer directly.
- **Usage:** comparative quota history, range controls, values beside cursor points, and keyboard/touch inspection.
- **Schedule:** shared daily send times, rendered prompt preview, pause/resume, and the schedule editor.
- **Alerts:** saved notification rules and the independent Telegram editor.
- **Activity:** run outcomes, replies, and account changes.

Navigation supports direct links and browser Back/Forward. Reduced motion, reduced transparency, keyboard focus, and mobile safe areas are respected.

Quota tiles and account bars use green above 70% remaining, yellow from 30–70%, and a slow red pulse below 30%. Upcoming resets pulse blue when less than an hour away. Reported reset credits share a compact document stack in Overview and Accounts. Each number belongs to its card. Hover an exposed edge to expand that document over the others, leaving their edges visible; tap or keyboard selection keeps it open. The stack adapts to its available width, showing at most four readable cards at once; previous/next controls expose additional credits, and keyboard navigation reaches the entire inventory. A gold highlight, shine and expiry pulse apply only to cards expiring within two days. Unknown expiry dates do not trigger an alert; a passed expiry asks for a fresh account reading without changing the reported count. Reduced-motion preferences disable these animations.

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

Existing installations retain the `codex-window-runner` Compose service and container, named volumes, account directories, and browser storage keys. These stable identifiers preserve credentials, saved conversations, and local preferences across the rebrand.

```bash
mkdir -p workspace
docker compose up -d --build
```

Open the UI:

```text
http://127.0.0.1:8787
```

On iPhone, open the HTTPS URL in Safari, tap **Share**, then **Add to Home Screen**. The installed app uses a standalone, safe-area-aware layout. It immediately shows a privacy-reduced saved fleet snapshot while live data loads; prompts, messages, workspace paths, credentials, and API responses are not stored in that snapshot. Its offline shell can open without a network connection, but account management still requires access to this server.

Connect a Codex account from **Accounts → Sign in**. Copy the one-time code, choose **Continue to OpenAI**, and enter the code on the sign-in page. Return to the console for automatic confirmation; technical output stays under **Sign-in diagnostics**. Credentials stay in the persistent server volume and survive restarts and rebuilds.

## Multiple accounts

- The original login migrates to **Default account**; add more with **Add account** in the header. New accounts have scheduled sends paused until you explicitly enable them after connecting.
- Additional credentials live under `/data/codex-accounts/<account-id>/`.
- Enabled accounts are pinged at every configured time; disabled accounts stay logged in but are skipped.
- The server is the sole automatic quota poller and continues when no browser is open. It checks every minute for 10 minutes after detected consumption, then backs off to 2, 5, and finally 10 minutes as the account fleet stays idle. A manual refresh remains available.
- Meaningful 5-hour, weekly, and Reserve changes are retained per account for 30 days plus one boundary baseline, capped at 5,000 samples. **Quota history** appears in **Usage** as separate 5-hour and weekly charts with one line per account. The plots resize without horizontal scrolling; date-aware ticks adapt to the available width. Hover or tap a chart to inspect every account at the same time, including overlapping lines, or focus it and use the arrow keys and Home/End. Account buttons toggle series for comparisons. Missing observations remain gaps; cached snapshots and last-known readings from earlier polls are labeled, while plotted lines stop at their last observation. Range summaries show observed lows, changes, and replenishments without claiming an exact historical reset time. Unchanged reads are not stored.
- Reserve is shown separately from ordinary quota, including its weekly reset date. Its state becomes **active** only when Codex explicitly reports that ordinary usage is unavailable and a current Reserve allowance exists; percentages are never used to infer activation. Available usage-reset credits and every reported expiration are shown for each account.
- **Remove** stops the account's app-server and permanently deletes its Codex home, including `auth.json`. The last remaining account cannot be removed.
- Login, logout, and run-now controls all apply to the selected account.

### Per-account overrides

Under *Accounts → Edit run settings*. Leave a field empty to use the shared default from Schedule.

| Override | Use it to |
|---|---|
| Schedule times | Stagger accounts across the day instead of firing all at once |
| Prompt template | Give each account its own standing instructions |
| Model override | Run different models per plan or per job |
| Workspace directory | Give simultaneous agents separate sandboxes |

The *Next send* bar covers the union of enabled accounts' schedules.

### Claude Code subscriptions

Claude support is opt-in and gated on a live quota pilot for the pinned Claude Code version. The separate worker holds one private CLI home per account and shares only a Unix socket with the dashboard. In **Accounts**, choose **Sign in**, open **Continue to Anthropic**, then paste the one-time code Anthropic shows into the dashboard and choose **Complete sign-in**. No server terminal is needed. The worker runs the native `claude auth login --claudeai` flow and completes first-run setup in its empty, tool-free directory. Claude accounts can send text manually or on the shared schedule, and each account resumes its own conversation. Each Claude account has a short acknowledgment prompt by default and can override it in Accounts. The worker runs with Claude's default model, with tools, customizations, MCP, and browser integration disabled.

The dashboard relays the one-time authorization code to the waiting CLI over the private worker socket. The code, authorization URL, and raw CLI output are never written to the application store or Activity logs. Reusable credentials stay in the worker volume. Sign-in links expire after ten minutes; cancellation, worker restart, or removal invalidates the attempt. Only one operation can run per account while sign-in is in progress. A different subscription identity requires a separate account slot. Passwords are entered only on Anthropic's website.

The worker reads the built-in `/usage` screen in UTC without sending a model prompt. It checks the 5-hour and all-model weekly windows every ten minutes and respects the CLI's backoff. Cached readings and unrecognized screens leave the previous values marked stale. Usage charts and Telegram quota rules use successful observations. The parser depends on the pinned terminal layout, so re-run the pilot after each Claude Code upgrade.

Start the passive pilot in a separate Compose project. Turn off paid usage credits on the subscription before testing sends.

```sh
docker compose --env-file /dev/null -p cwr-claude-pilot --profile claude up -d --build claude-worker
```

What it does: builds and starts only the Claude worker, with isolated volumes and no published port. Requires a running Docker daemon and network access to build the image.

```sh
docker compose --env-file /dev/null -p cwr-claude-pilot --profile claude exec claude-worker node src/claude-worker.mjs login acct_000000000001
```

What it does: signs into your own subscription and writes credentials to this pilot account's private volume, then opens Claude Code setup. Complete the official sign-in and setup in your terminal, open `/usage`, then exit.

```sh
docker compose --env-file /dev/null -p cwr-claude-pilot --profile claude exec claude-worker node src/claude-worker.mjs inspect acct_000000000001
```

What it does: opens a fresh, tool-free Claude Code terminal in the same home. Complete any first-run setup for its empty work directory, open `/usage`, note both windows and reset times, then exit.

```sh
docker compose --env-file /dev/null -p cwr-claude-pilot --profile claude exec claude-worker node src/claude-worker.mjs pilot acct_000000000001
```

What it does: runs the passive reader and prints only normalized quota values. Compare both windows with the manual read, then repeat after quota changes in another Claude session. The pilot must pick up the new values without a model turn.

After the passive pilot passes, set `CLAUDE_QUOTA_VERIFIED_VERSION` to the tested image's Claude Code version in an isolated dashboard deployment and run Compose with the `claude` profile. Use a separate project, container name, loopback port, and workspace if another dashboard is running on the same host. Add a Claude Code account in the dashboard and complete its browser sign-in steps. The terminal commands above remain available for manual pilot checks; run them from the Compose project directory, or include the project's absolute `-f` path and any project-specific `-p` options. Verify one manual send, one scheduled send, and a quota refresh. Back up the existing runner store before enabling Claude in your regular deployment. Restoring a release that predates provider support requires the pre-upgrade store.

The November 8, 2026 pilot on Linux arm64 / Node 22 verified Claude Code `2.1.303` against its live `/usage` screen, including both quota percentages and displayed reset times. Manual and scheduled acknowledgments completed in the same saved conversation. A passive refresh after a separate native CLI conversation preserved the dashboard session. That small external test did not move the displayed whole-percent usage values, so a live consumption delta was not measurable. The CLI's displayed reset times varied by one minute between reads. The parser waits for `Refreshing…` to disappear and records the displayed minute precision.

Back up the worker's account volume separately if you want to preserve its credentials and conversations. Treat that backup as a password store. The shared worker socket is an admin interface for the dashboard.

## Account analytics

**Usage** has Quota & projections, Tokens, and Costs views. Provider and account filters apply to the Usage workspace. Collection is independent of scheduled sends and uses the existing services; no device collectors are required.

Codex account totals come from `account/usage/read` without a thread ID, using each account's isolated app-server. They are provider-reported account activity, including work outside WindowRelay, rather than totals of dashboard runs. Reads happen at startup, after sign-in, every ten minutes through the quota refresh loop, and on manual refresh (with a one-minute minimum interval). Concurrent reads are coalesced; failures back off up to an hour. A token-report failure does not clear quota state or send a model request.

The current CLI pin supports this method, but the backend may return null summaries or no daily buckets for an account. Missing values and dates stay unknown. The latest lifetime summary and up to 365 daily buckets are persisted under each account's `metrics` in `store.json`; provider revisions replace matching dates. Lifetime totals can cover more history than the retained daily chart. Daily date labels are preserved, with UTC calendar dates used to select ranges. Today's values can be partial.

Metrics bind to the provider account ID when supplied, otherwise to a digest of the reported sign-in identity. Changed identities archive the previous report separately (up to five archives). Confirmed duplicate backend account IDs count once in fleet totals, using the freshest slot. An email alone does not prove that two workspace scopes are duplicates. Unavailable accounts remain visible in coverage counts, so a partial reported total is never labelled as complete fleet usage.

Claude Pro/Max does not expose a documented account-wide token report through this integration. Its token counters stay **Unavailable**. The existing passive `/usage` reader collects quota and, when explicitly displayed, extra-usage money spent and limits. A balance or an `Unlimited` row without a spend amount is not treated as spending. Amounts with no stated reporting period remain visible per account but are excluded from period totals. No local Claude session tokens or API-cost estimates are substituted for account totals.

Subscription fees are optional, user-entered monthly amounts, with a currency, billing day and effective date. Saving a change retains earlier dated entries; saving the same effective date corrects that entry. Billing days beyond a month's length use its last day. Fee commitments and reported extra usage are separate, currencies are not converted, and cost-per-million comparisons require a fully reported completed billing period with an unchanged fee. Subscription fees can cover products beyond coding, so this comparison is not a billed coding rate.

The API-cost calculator is a separate scenario: choose a model, token volume, input/output mix and cache proportions. Rates are editable and use a dated snapshot of [OpenAI's standard text API pricing](https://developers.openai.com/api/docs/pricing) and [Anthropic's pricing](https://platform.claude.com/docs/en/about-claude/pricing). Tool charges, tax, regional uplifts, context-length tiers and speed discounts/premiums are excluded. Scenarios never contribute to reported spend or quota. Reasoning is already part of output, and cache reads/writes are disjoint portions of input.

Quota projections use raw window percentages independently. Five-hour trends use the latest hour; weekly/Reserve trends use up to 24 hours. Each needs three readings spanning thirty minutes. Unchanged readings get ten-minute heartbeats; replenishment, material reset-time changes and gaps over thirty minutes start a new trend. Claude's minute-level reset jitter is tolerated. Stale readings suppress forecasts, and reported blocks take precedence. Dashed lines end at exhaustion or reset. All projections mean **If recent usage continues**, and do not change scheduling or send alerts.

Codex's monthly outlook needs at least three consecutive completed provider days, using up to seven. With complete month-to-date history it estimates month-end usage; otherwise it shows a 30-day pace scenario. Today's partial bucket is excluded from the daily baseline, while its observed volume remains a minimum in month-end estimates. No Claude tokens are forecast from quota percentages.

`GET /api/usage-metrics` accepts `provider=codex|claude`, `accountId`, and `range=today|7d|30d|90d|lifetime` (default `30d`). It returns account summaries, daily buckets, coverage, costs and projections. `PATCH /api/accounts/:id` accepts a `billing` entry `{ amountMinor, currency, billingDay, effectiveFrom }`. These routes use the existing admin access controls. Metric updates invalidate the display through the existing SSE connection.

Before releasing this feature, back up the existing store and perform passive reads for every signed-in account. Check returned summary/daily availability and reporting lag, then confirm that normal activity from another coding client appears when the provider report updates. Do not generate model requests just to test counters. Automated tests use synthetic reports; they do not establish live provider coverage.

## Security model

WindowRelay is a **private admin app** with access to your Codex and Claude Code accounts. Do not expose it to the public internet.

- Bind the port to localhost, or to your LAN only if that network is trusted.
- Put it behind **Cloudflare Tunnel + Cloudflare Access**.
- Set `ADMIN_EMAILS` so the backend only accepts requests carrying a matching Access-authenticated email header. This is defense in depth — if the app is directly exposed, those headers can be spoofed.
- State-changing API requests must be same-origin: the backend rejects them when the browser reports another site (`Sec-Fetch-Site`, or a mismatched `Origin`), so a page on another domain cannot drive the console through your Access session. Non-browser clients that send neither header are unaffected.
- Pages are served with a Content Security Policy that only allows same-origin scripts, plus `nosniff` and frame denial.
- `GET /api/health` answers without an Access identity so container health checks work when `ADMIN_EMAILS` is set. It returns only `ok` and a timestamp.
- The app never asks for your ChatGPT password and never displays tokens. Treat the data volume like a password store — **backups contain live credentials; encrypt them**.
- `codex login status` reports credential *presence*, not validity. The service therefore verifies authentication through live Codex requests and reports rejected or expired credentials as an **auth issue**. Re-login from Accounts; a successful device login restarts that account's app-server so it uses the new credentials.

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
| `CLAUDE_WORKER_SOCKET` | `/run/claude-worker/worker.sock` in Compose | Private socket shared with the optional Claude worker |
| `CLAUDE_QUOTA_VERIFIED_VERSION` | unset | Enable Claude only when it matches the CLI version that passed the live quota pilot |
| `ADMIN_EMAILS` | unset | Optional Cloudflare Access email allowlist |
| `TELEGRAM_BOT_TOKEN` | unset | Telegram bot token; keep only in the server's ignored `.env` |
| `TELEGRAM_CHAT_ID` | unset | Destination user, group, or channel chat ID |

Manage timezone, send times, prompts, and run settings in **Schedule → Edit schedule**. Manage Telegram notifications independently in **Alerts → Configure alerts**, also accessible from the Alerts navigation link. Each editor saves or cancels its own draft. Network access is off by default; the default approval policy is `on-request`.

The **Model** dropdown in Schedule settings defaults to **Automatic · prefer lowest cost**. It selects from each account's Codex `model/list` catalog, preferring GPT-6 Luna, then GPT-5.6 Luna when the newer model is absent. Remaining known models follow published Standard credit rates; unknown catalogs fall back to their default model. Catalogs are cached for five minutes, and a listed model's account access is confirmed only by a completed turn. The dropdown in account overrides can select a different model or inherit the global setting. An explicit model missing from an account's catalog fails with an actionable message instead of silently choosing another model.

The selected model is sent explicitly when creating/resuming threads and starting turns, so an old thread or CLI default cannot restore retired GPT-5.5. Scheduled and manual turns use Standard speed to avoid inherited Fast pricing. GPT-5.5 is excluded from the picker following its October 14, 2026 retirement for ChatGPT sign-in. Existing explicit overrides remain visible as unavailable until changed. Model availability depends on the pinned CLI and account; upgrading the CLI may expose newer choices. See [OpenAI's model guidance](https://learn.chatgpt.com/docs/models) and [Standard credit rates](https://learn.chatgpt.com/docs/pricing).

### Telegram alerts

1. Create a dedicated bot with Telegram's `@BotFather` and start a conversation with it, or add it to the intended private group.
2. Obtain the destination chat ID through Telegram's Bot API, then put `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` in the deployment's ignored `.env` file. Never commit either value.
3. Recreate the container, open **Alerts → Configure alerts**, send a test alert, then enable the categories you want.

Alerts are disabled by default. Under **Alerts → Configure alerts**, expand a category to customize its triggers, notification count, and timing. Remove every entry in a list to disable that alert. Each list supports up to 10 distinct values.

| Category | Controls |
| --- | --- |
| Quota warnings | Choose every used-quota percentage (1–100), watched quota windows, and notification times after each crossing. There are no mandatory 95% or 100% warnings. |
| Quota resets | Choose before-reset reminders independently for the 5-hour, weekly, and Reserve windows, plus notification times after a reported reset. |
| Reset credits | Separately control credit-count changes and reminders before unused credits expire. |
| Reserve status | Independently configure activation and recovery notifications. |
| Failures | Independently configure authentication failures and failed scheduled Codex sends/turns. |

Before-reset/expiry reminders use hours (1–720). After-event notifications use minutes (0–10080): **0** sends immediately; **0, 10, 60** sends three notifications, immediately and after 10 and 60 minutes. New events use the saved schedule. Removing a notification time or disabling its event also cancels pending notifications for it. The shared quota-window selection applies to warnings and quota reset alerts; Reserve status has its own independent controls.

New installations default to used-quota warnings at **80%, 95%, and 100%**, one immediate notification for each event, no before-quota-reset reminders, and **one reminder 48 hours / 2 days before reset-credit expiry**. Upgrades preserve the old warning threshold together with its previously fixed 95%/100% warnings, category switches, and saved credit-expiry lead times. These migrated values are all editable.

Reminders require a reported future reset/expiry date. They are checked every minute even when scheduled Codex sends are paused, and immediately after quota reads or settings changes. Reminder receipts and queued notifications persist across restarts. After downtime or late discovery, only the most urgent overdue before-date reminder is queued. Small projected changes to quota reset dates do not start a new notification cycle. Pending alerts are rechecked before delivery: warnings stop after quota recovery or a new cycle, Reserve follow-ups stop after its status changes, count follow-ups stop when inventory changes again, authentication follow-ups stop after recovery/sign-out, and scheduled-failure follow-ups stop after a later successful turn. Credit reminders stop when credits are no longer reported or expire. These checks use the latest reported state; a credit used since the last successful read may still appear available until the next read.

Adaptive polling ranges from one minute during active consumption to ten minutes after long idle periods, so detection can lag by that interval; app-server notifications are processed immediately. Notification schedules are checked every minute. A future notification never holds up one that is due now. Messages include the account and event; delayed follow-ups include the original event's report time. Pending messages are persisted without credentials and retried with exponential backoff after transient Telegram failures. Delivery is at least once: a crash immediately after Telegram accepts a message can cause it to be sent again after restart, because Telegram has no idempotency key for `sendMessage`.

Bot credentials remain server-side, are removed from Codex subprocess environments, and are not returned by the API or saved in `store.json`. Telegram still receives account labels and the alert facts included in each message, so use a private destination and choose labels appropriate for that disclosure.

## Operations

```bash
# follow service and Codex activity
docker compose logs -f codex-window-runner

# health (the compose file also runs this probe as a container healthcheck)
docker compose ps codex-window-runner
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

If `store.json` cannot be parsed at startup, the service keeps it as `store.json.corrupt-<timestamp>` in the data directory and starts with defaults instead of overwriting it. Account credentials stay in their own directories; restore the store from that file or a backup.

The bundled compose binds `127.0.0.1:8787:8080`. To listen on another interface, add a `docker-compose.override.yml` (kept out of git) rather than editing the tracked file.

## Known trade-offs

- The Codex dashboard uses Node's standard library and Server-Sent Events. The optional Claude worker uses a native pseudo-terminal module and a headless terminal emulator.
- `codex app-server` is experimental upstream; a protocol change may require adapter updates.
- Device-code login depends on Codex and your ChatGPT workspace allowing it. Fallback: copy a valid `auth.json` into the account's persistent `CODEX_HOME`.
- A `bubblewrap not found` warning at startup is expected on slim images; Codex uses its bundled copy.

---

*Built for a fleet of one — but the board scales.*

## Frontend verification

`npm run check` checks JavaScript syntax. After installing the locked dependencies with `npm ci`, `npm test` runs the unit and local integration tests with simulated CLIs.

`npm run test:e2e` uses Playwright to launch the real server with a temporary data directory and a simulated Codex app-server. It never uses your account credentials or sends Telegram alerts. Install Playwright separately with its Chromium and WebKit browsers:

```sh
npm install --no-save --package-lock=false playwright
npx --no-install playwright install chromium webkit
npm run test:e2e
```

What it does: installs local test tooling and browser binaries, then checks desktop, iPhone-sized, narrow, and landscape layouts, both themes, settings persistence, account selection, chart controls, activity outcomes over SSE, safe-area dock geometry, and offline recovery. Temporary test data is removed afterward. The schedule editor covers keyboard tabs, adding/removing individual times, save/cancel, and drafts retained after Escape and refresh. The account workflow also covers add/cancel, naming, draft preservation, failed sign-in and retry, completed sign-in, sign-out, and confirmed removal of a disposable fixture account. Clipboard writes are simulated so tests do not alter the host clipboard.

For an existing tooling installation, set `PLAYWRIGHT_MODULE` to its `playwright/index.mjs` path. Optional `CHROMIUM_EXECUTABLE_PATH` and `WEBKIT_EXECUTABLE_PATH` select installed browser executables. `E2E_CASE` filters viewport names and `E2E_OUTPUT_DIR` saves visual previews. Browser emulation does not verify a physical iPhone's home indicator or Safari chrome.

Account removal uses an in-page confirmation for the named account, locks while pending, and reconciles a lost acknowledgement before offering a retry. Browser coverage injects failed requests and refreshes to verify that a successful removal never needs a second DELETE. The server regression checks delayed Codex shutdown, cleanup, overlapping requests, and protection of the last account.
