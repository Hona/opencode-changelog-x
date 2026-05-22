# Deploy

## Overview

The Discord bot (`bun run discord`) is the single long-running process on the VPS. It handles:

- `!previewchangelog` command in the hardcoded channel
- Release polling — checks `origin/master:data/posted-releases.json` every 10 minutes and dispatches this repo's `poll.yml` via `gh` CLI only when an upstream release is unposted
- Upstream publish monitoring — checks `anomalyco/opencode` `publish.yml` workflow_dispatch runs every 5 minutes and posts triggered/completed/failed release alerts to Discord

Twitter release posting runs in GitHub Actions (the `poll.yml` workflow), not on the VPS.

Current Discord deployment target:

- Host: `root@cloud.hona.dev`
- App dir: `/repos/opencode-changelog-x`
- Service: `opencode-changelog-discord.service`
- Env file: `/etc/opencode-changelog-discord.env`

The bot posts only to the hardcoded channel:

- `1472697640880701523`

## Prerequisites

Remote host assumptions:

- Debian with `systemd`
- Bun 1.3.14 available at `/root/.bun/bin/bun`
- `gh` CLI installed and authenticated (`gh auth status` should show logged in with `repo` and `workflow` scopes)
- App checked out or copied to `/repos/opencode-changelog-x`
- Discord bot already invited to the server
- Discord bot has Message Content intent enabled

## Required Env

Edit on the VPS:

```bash
nano /etc/opencode-changelog-discord.env
```

Required:

```bash
DISCORD_TOKEN=...
```

Optional:

```bash
OPENCODE_API_KEY=...
GH_TOKEN=...
```

Notes:

- Do not commit secrets into this repo.
- GitHub reads and workflow dispatches go through the `gh` CLI only.
- Prefer a logged-in `gh auth` session on the VPS. `GH_TOKEN` is optional if you want token-based `gh` auth from the service environment.
- Twitter credentials are NOT needed on the VPS. They stay in GitHub Actions secrets.

## First-Time Setup

Copy the repo to the server:

```bash
scp -r src data deploy package.json bun.lock tsconfig.json README.md root@cloud.hona.dev:/repos/opencode-changelog-x/
```

Install dependencies:

```bash
ssh root@cloud.hona.dev "cd /repos/opencode-changelog-x && /root/.bun/bin/bun install --frozen-lockfile"
```

Install the systemd unit:

```bash
ssh root@cloud.hona.dev "install -m 0644 /repos/opencode-changelog-x/deploy/opencode-changelog-discord.service /etc/systemd/system/opencode-changelog-discord.service && systemctl daemon-reload"
```

Create the env file if it does not exist:

```bash
ssh root@cloud.hona.dev "if [ ! -f /etc/opencode-changelog-discord.env ]; then install -m 0600 /repos/opencode-changelog-x/deploy/opencode-changelog-discord.env.example /etc/opencode-changelog-discord.env; fi"
```

## Start And Stop

Enable and start:

```bash
ssh root@cloud.hona.dev "systemctl enable --now opencode-changelog-discord.service"
```

Restart after code or env changes:

```bash
ssh root@cloud.hona.dev "systemctl restart opencode-changelog-discord.service"
```

Stop:

```bash
ssh root@cloud.hona.dev "systemctl stop opencode-changelog-discord.service"
```

## Check Status

Quick status:

```bash
ssh root@cloud.hona.dev "systemctl status opencode-changelog-discord.service --no-pager --full"
```

Machine-readable status:

```bash
ssh root@cloud.hona.dev "systemctl show -p ActiveState -p SubState -p MainPID opencode-changelog-discord.service"
```

Expected healthy startup log:

```text
Discord preview bot ready as OpenAssist#0141
Workflow monitor started.
No unposted release found; skipping release poll dispatch.
```

## Logs

Recent logs:

```bash
ssh root@cloud.hona.dev "journalctl -u opencode-changelog-discord.service -n 120 --no-pager --output=short-iso"
```

Follow live logs:

```bash
ssh root@cloud.hona.dev "journalctl -u opencode-changelog-discord.service -f"
```

Useful log lines:

- `Discord preview bot ready as ...`
- `Workflow monitor started.`
- `No unposted release found; skipping release poll dispatch.`
- `Release poll dispatched for vX.Y.Z.`
- `Starting preview for ...`
- `Preview posted for ...`
- `Posted triggered alert: ...`
- `Posted completion alert: ...`
- `Seeding workflow state for ...`
- `Falling back to cached latest release ...`

## Update Flow

Typical deploy after local changes:

1. Push the commit to GitHub.
2. Copy the updated files to the VPS.
3. Run remote typecheck.
4. Restart the systemd service.
5. Check logs.

Example:

```bash
scp -r src data deploy package.json bun.lock tsconfig.json README.md root@cloud.hona.dev:/repos/opencode-changelog-x/
ssh root@cloud.hona.dev "cd /repos/opencode-changelog-x && /root/.bun/bin/bun run typecheck && systemctl restart opencode-changelog-discord.service && sleep 5 && systemctl status opencode-changelog-discord.service --no-pager --full"
```

## Runtime Files

Useful files on the VPS:

- App code: `/repos/opencode-changelog-x`
- Service unit: `/etc/systemd/system/opencode-changelog-discord.service`
- Env file: `/etc/opencode-changelog-discord.env`
- Posted release state: `/repos/opencode-changelog-x/data/posted-releases.json`
- Cached latest GitHub release: `/repos/opencode-changelog-x/data/latest-github-release.json`
- Workflow monitor state: `/repos/opencode-changelog-x/data/publish-workflow-state.json`

## Monitoring

At minimum, monitor:

- `systemctl status opencode-changelog-discord.service`
- recent `journalctl` output
- whether preview requests produce `Preview posted for ...`

Basic one-liner health check:

```bash
ssh root@cloud.hona.dev "systemctl is-active opencode-changelog-discord.service && journalctl -u opencode-changelog-discord.service -n 20 --no-pager"
```

## Troubleshooting

If previews fail immediately:

- check `DISCORD_TOKEN` in `/etc/opencode-changelog-discord.env`
- confirm the bot is in the server
- confirm Message Content intent is enabled
- confirm the bot can read, react, create threads, send messages, and embed links in channel `1472697640880701523`

If GitHub lookups fail:

- confirm `gh auth status` works for root, or add `GH_TOKEN` to `/etc/opencode-changelog-discord.env`
- restart the service

If release poll dispatch fails:

- confirm `gh auth status` shows logged in with `repo` and `workflow` scopes
- confirm the working directory `/repos/opencode-changelog-x` has a git remote pointing to the repo with `poll.yml`

If workflow monitoring is not posting alerts:

- check that the channel ID is a `TextChannel` (not a thread, voice, or forum channel)
- check `journalctl` for `Workflow monitor error:` lines
- confirm `gh run list --repo anomalyco/opencode --workflow publish.yml` works on the VPS

If the bot starts but previews hang for a while:

- that is often normal during repo analysis and OpenCode generation
- inspect live logs with `journalctl -u opencode-changelog-discord.service -f`

If you suspect stale worker processes:

```bash
ssh root@cloud.hona.dev "ps -eo pid,ppid,etimes,%cpu,%mem,cmd --sort=pid | grep -E 'opencode-changelog|bun.*src/discord|opencode serve'"
```

If needed, stop the service, inspect processes, then start it again:

```bash
ssh root@cloud.hona.dev "systemctl stop opencode-changelog-discord.service"
ssh root@cloud.hona.dev "systemctl start opencode-changelog-discord.service"
```

## Local Validation

Before deploying:

```bash
bun run typecheck
```

Use Bun for local validation and deployment commands.
