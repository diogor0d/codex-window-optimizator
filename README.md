<div align="center">

<img src="public/icon-512.png" width="104" alt="Codex Window Runner logo — three schedule slots, the center one lit amber">

# Codex Window Runner

**A station timetable for your Codex fleet.**

Four departures a day. Every account on its own five-hour window.
One private, self-hosted console.

![Node](https://img.shields.io/badge/node-%E2%89%A522-161e28?style=flat-square&labelColor=10161d&color=f5a83c)
![Codex CLI](https://img.shields.io/badge/codex_cli-0.142.5-161e28?style=flat-square&labelColor=10161d&color=f5a83c)
![Docker Compose](https://img.shields.io/badge/runs_with-docker_compose-161e28?style=flat-square&labelColor=10161d&color=f5a83c)

</div>

---

Codex usage resets in roughly five-hour windows. This service keeps a fleet of ChatGPT/Codex accounts inside that rhythm: at every scheduled time it sends a ping into each enabled account's persistent Codex thread, spaced `5h05` apart, so local-message usage stays aligned with the documented windows.

It cannot see OpenAI's internal reset clock. What it does is simple and predictable: fixed local times, no duplicate sends within a minute, and a console that shows exactly what departed, what failed, and when the next train leaves.

## The console

A signal-box dashboard: a live station clock, a split-flap **next send** module, per-account usage windows with reset times, a fleet-wide quota strip with a 24-hour reset timetable, and a departures board built from actual run history.

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

Then log in: **Accounts → Start device login**. The container runs `codex login --device-auth`; open the shown URL in any browser, sign in, and enter the code. Credentials land in the persistent volume and survive restarts and rebuilds.

## Multiple accounts

- The original login migrates to **Default account**; add more from the Accounts panel.
- Additional credentials live under `/data/codex-accounts/<account-id>/`.
- Enabled accounts are pinged at every configured time; disabled accounts stay logged in but are skipped.
- **Remove** stops the account's app-server and permanently deletes its Codex home, including `auth.json`. The last remaining account cannot be removed.
- Login, logout, run-now, and goal controls all apply to the selected account.

### Per-account overrides

Under *Accounts → Per-account overrides*. Leave a field empty to inherit the global default from Settings.

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
- `codex login status` reports credential *presence*, not validity. A revoked session keeps showing "Logged in" while sends fail with `unauthorized` in the activity feed — if pings start failing, re-login from the Accounts panel.

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

Managed in the web UI under Settings: timezone, schedule times, workspace directory, model, effort, summary, approval policy, network access for scheduled turns, skip-if-active, and the scheduled prompt template. Network access is off by default; the default approval policy is `on-request`.

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

The Codex CLI version is pinned by the `CODEX_PACKAGE_VERSION` build arg, so rebuilds never surprise-upgrade Codex. Rollback is `git checkout <ref> && docker compose up -d --build`; the store format migrates forward automatically and old code ignores newer fields.

The bundled compose binds `127.0.0.1:8787:8080`. To listen on another interface, add a `docker-compose.override.yml` (kept out of git) rather than editing the tracked file.

## Known trade-offs

- Node's standard library plus Server-Sent Events instead of a framework stack — same behavior for a single-user service, zero native dependencies.
- `codex app-server` is experimental upstream; a protocol change may require adapter updates.
- Device-code login depends on Codex and your ChatGPT workspace allowing it. Fallback: copy a valid `auth.json` into the account's persistent `CODEX_HOME`.
- A `bubblewrap not found` warning at startup is expected on slim images; Codex uses its bundled copy.

---

*Built for a fleet of one — but the board scales.*
