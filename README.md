# OpenCode Changelog X Bot

Polls `anomalyco/opencode` GitHub releases, resolves the git tag range for each unseen release, lets OpenCode inspect the actual code diff, validates the generated X post, publishes it, and records which releases were already handled.

## Stack

- TypeScript
- `@opencode-ai/sdk/v2`
- local `opencode-ai` binary installed via npm dependencies
- `discord.js`
- `twitter-api-v2`
- `twitter-text`

## Hardcoded Model

- provider: `opencode`
- model: `gemini-3.1-pro`
- variant: `high`

## How It Works

1. Fetch recent GitHub releases from `anomalyco/opencode`.
2. Skip releases already recorded in `data/posted-releases.json`.
3. Resolve the previous tag for each release and compute the compare range.
4. Feed that tag range into OpenCode and let it inspect the repository with read-only tools.
5. Print the generated report JSON.
6. Validate the generated post against X Premium long-post limits.
7. Post the single X message when not in dry-run mode.
8. Persist posted release metadata back to `data/posted-releases.json`.

## Discord Preview Bot

- Runs as a separate long-lived process via `npm run discord`.
- Listens only in the hardcoded channel `1472697640880701523`.
- Waits for the exact command `!previewchangelog`.
- Uses the latest GitHub release tag as the baseline.
- Generates a preview post for commits after that release up to the current upstream `HEAD`.
- Creates a Discord thread on the command message and posts the generated post as one or more embeds if needed for Discord limits.

This is intended to be deployed separately from the Twitter release cron. A typical setup is:

- cron/CI runs `npm run bot` for real release posting to X
- a Debian VPS runs `npm run discord` continuously for manual preview requests

## Required Secrets

Shared env for either runtime when a local OpenCode login is not available:

- `OPENCODE_API_KEY`

Twitter release posting:

- `TWITTER_APP_KEY`
- `TWITTER_APP_SECRET`
- `TWITTER_ACCESS_TOKEN`
- `TWITTER_ACCESS_SECRET`

Discord preview daemon:

- `DISCORD_TOKEN`

For local dry runs, you usually do not need `OPENCODE_API_KEY` if your local `opencode` CLI is already logged in.

## Optional Secrets / Env

- `GITHUB_API_TOKEN`
  Use this if you want higher rate limits or access to upstream draft releases.
- `GITHUB_PROCESS_DRAFTS=true`
  Allows processing draft releases when your token can see them.
- `UPSTREAM_REPO_DIR`
  Optional local path to an existing `opencode` checkout. Useful for local development.
- `UPSTREAM_CLONE_URL`
  Override the repository clone URL. Defaults to `https://github.com/anomalyco/opencode.git`.
- `DRY_RUN=true`
  Generate and validate threads without posting them or updating state.
- `--dry-run`
  CLI flag equivalent to `DRY_RUN=true`.
- `--tag v1.1.13`
  Generate for a specific release tag instead of polling unseen releases.
- `GITHUB_OWNER`
  Defaults to `anomalyco`.
- `GITHUB_REPO`
  Defaults to `opencode`.

## Local Usage

```bash
npm install
UPSTREAM_REPO_DIR=../../sst/opencode npm run dry-run -- --tag v1.1.13
```

```bash
DISCORD_TOKEN=... npm run discord
```

Because the project depends on `opencode-ai`, `npm run bot` puts the local `opencode` binary on `PATH`, which is what `@opencode-ai/sdk/v2` spawns.

The Discord bot requires the bot account to have access to the configured channel, permission to create threads, permission to send embeds, and the Message Content intent enabled in the Discord developer portal.

If `UPSTREAM_REPO_DIR` is not set, the bot clones a temporary checkout of the upstream repo for analysis.

For local runs, the spawned `opencode` server uses the same credential sources as your normal CLI:

- your stored auth data
- provider environment variables
- provider config in `opencode.json`

So if `opencode providers list` already shows working credentials for the provider you want, this bot should be able to reuse them locally.

## State

The bot stores posted releases in `data/posted-releases.json`. The workflow commits that file back to the repo after successful posts so scheduled runs stay idempotent.
