# OpenCode Changelog X Bot

Polls `anomalyco/opencode` GitHub releases and `v*` git tags, resolves the git tag range for each unseen release, lets OpenCode inspect the actual code diff, validates the generated X post, publishes it, and records which releases were already handled.

## Stack

- TypeScript
- Effect 4
- Bun
- `@opencode-ai/sdk/v2`
- local `opencode-ai` binary installed via Bun dependencies
- `discord.js`
- `twitter-api-v2`
- `twitter-text`

## Hardcoded Model

- provider: `opencode`
- model: `gpt-5.5`
- variant: `high`

## How It Works

1. Fetch GitHub releases and semver `v*` git tags from `anomalyco/opencode`. Tags without a GitHub release (the 2.x line only pushes tags) become tag-only releases when they are newer than every GitHub release of their major version line.
2. Skip releases already recorded in `data/posted-releases.json`. Each major line (1.x, 2.x) advances independently from its highest posted version; a new line starts after the highest posted version overall.
3. Resolve the previous tag for each release as its semver predecessor (not the previous publish time) and compute the compare range. Releases are processed in semver order.
4. Feed that tag range into OpenCode and let it inspect the repository with read-only tools.
5. Print the generated report JSON.
6. Validate the generated post against X Premium long-post limits.
7. Post the single X message when not in dry-run mode.
8. Persist posted release metadata back to `data/posted-releases.json`.

Bundle-size analysis downloads the npm binaries for both sides of the range: `opencode-ai` / `opencode-<platform>` for 1.x and `@opencode/cli` / `@opencode/cli-<platform>` for 2.x. The beta staleness monitor watches the `beta` dist-tag of `@opencode/cli`.

## Discord Preview Bot

- Runs as a separate long-lived process via `bun run discord`.
- Listens only in the hardcoded channel `1472697640880701523`.
- Waits for the exact command `!previewchangelog`.
- Uses the latest release tag of the version line the checked-out `HEAD` belongs to (read from `packages/cli/package.json` or `packages/opencode/package.json`) as the baseline.
- Generates a preview post for commits after that release up to the current upstream `HEAD`.
- Creates a Discord thread on the command message and posts the generated preview as one or more embeds if needed for Discord limits.

This is intended to be deployed separately from the Twitter release cron. A typical setup is:

- cron/CI runs `bun run bot` for real release posting to X
- a Debian VPS runs `bun run discord` continuously for manual preview requests

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

- `GH_TOKEN`
  Optional. GitHub reads and workflow dispatches use the `gh` CLI only; use this when you prefer token-based `gh` auth over a persisted `gh auth login` session.
- `GITHUB_PROCESS_DRAFTS=true`
  Allows processing draft releases when your token can see them.
- `DRY_RUN=true`
  Generate and validate the post without publishing it or updating state.
- `--dry-run`
  CLI flag equivalent to `DRY_RUN=true`.
- `--tag v1.1.13`
  Generate for a specific release tag instead of polling unseen releases.

## Local Usage

```bash
bun install
bun run dry-run -- --tag v1.1.13
```

```bash
DISCORD_TOKEN=... bun run discord
```

Because the project depends on `opencode-ai`, `bun run bot` puts the local `opencode` binary on `PATH`, which is what `@opencode-ai/sdk/v2` spawns.

The Discord bot requires the bot account to have access to the configured channel, permission to create threads, permission to send embeds, and the Message Content intent enabled in the Discord developer portal.

The bot clones a temporary checkout of the upstream repo for analysis.

For local runs, the spawned `opencode` server uses the same credential sources as your normal CLI:

- your stored auth data
- provider environment variables
- provider config in `opencode.json`

So if `opencode providers list` already shows working credentials for the provider you want, this bot should be able to reuse them locally.

## State

The bot stores posted releases in `data/posted-releases.json`. The workflow commits that file back to the repo after successful posts so scheduled runs stay idempotent. Tag-only releases are stored with `releaseId: null`, `source: "git-tag"` and the tag's `commitSha`; the tag is the identity in that case.
