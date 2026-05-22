import { Context, Effect, Layer } from "effect"
import { GithubCli } from "../integrations/github-cli.js"
import { RuntimeConfig } from "../runtime-config.js"
import { getErrorMessage } from "./errors.js"
import type { AlertChannel } from "./types.js"

const BETA_NPM_PACKAGE = "opencode-ai"
const BETA_STALE_THRESHOLD_MS = 3 * 60 * 60 * 1000

type NpmPackument = {
  "dist-tags"?: Record<string, string>
  time?: Record<string, string>
}

type BetaNpmStatus = {
  version: string
  publishedAt: string
  ageMs: number
  stale: boolean
}

type WorkflowRunsResponse = {
  workflow_runs: Array<{
    conclusion: string | null
    status: string
    html_url: string
    created_at: string
  }>
}

function formatBetaAge(ageMs: number): string {
  const hours = Math.floor(ageMs / (60 * 60 * 1000))
  const mins = Math.floor((ageMs % (60 * 60 * 1000)) / (60 * 1000))
  return hours > 0 ? `${hours}h ${mins}m` : `${mins}m`
}

function formatBetaStaleAlert(status: BetaNpmStatus, failureUrl: string | null): string {
  let msg = `**Beta release is stale** — last published ${formatBetaAge(status.ageMs)} ago (\`${BETA_NPM_PACKAGE}@${status.version}\`)`
  if (failureUrl) {
    msg += `\n[Last failure](<${failureUrl}>)`
  }
  return msg
}

function formatBetaResolvedAlert(status: BetaNpmStatus): string {
  return `~~Beta release was stale~~ — resolved (\`${BETA_NPM_PACKAGE}@${status.version}\`)`
}

export class BetaMonitor extends Context.Service<BetaMonitor, {
  readonly checkOnce: (channel: AlertChannel) => Effect.Effect<void>
  readonly run: (channel: AlertChannel) => Effect.Effect<void>
}>()("app/BetaMonitor") {
  static readonly layer = Layer.effect(
    this,
    Effect.gen(function* () {
      const config = yield* RuntimeConfig
      const github = yield* GithubCli
      let wasStale = false

      const checkBetaNpmStaleness = Effect.fn("BetaMonitor.checkBetaNpmStaleness")(function* () {
        const response = yield* Effect.tryPromise(() => fetch(`https://registry.npmjs.org/${BETA_NPM_PACKAGE}`, {
          headers: { Accept: "application/json" },
          signal: AbortSignal.timeout(15_000),
        }))
        if (!response.ok) {
          return yield* Effect.fail(new Error(`NPM packument request failed for ${BETA_NPM_PACKAGE} (${response.status} ${response.statusText})`))
        }

        const data = (yield* Effect.tryPromise(() => response.json())) as NpmPackument
        const betaVersion = data["dist-tags"]?.beta
        if (!betaVersion) {
          return yield* Effect.fail(new Error(`${BETA_NPM_PACKAGE} has no beta dist-tag`))
        }

        const publishedAt = data.time?.[betaVersion]
        if (!publishedAt) {
          return yield* Effect.fail(new Error(`${BETA_NPM_PACKAGE}@${betaVersion} is missing publish time`))
        }

        const ageMs = Date.now() - new Date(publishedAt).getTime()

        return {
          version: betaVersion,
          publishedAt,
          ageMs,
          stale: ageMs > BETA_STALE_THRESHOLD_MS,
        } satisfies BetaNpmStatus
      })

      const fetchRuns = Effect.fn("BetaMonitor.fetchRuns")(function* (workflow: string, branch?: string) {
        const params = new URLSearchParams({ per_page: "5" })
        if (branch) params.set("branch", branch)

        const stdout = yield* github.api(
          `repos/${config.githubOwner}/${config.githubRepo}/actions/workflows/${workflow}/runs?${params}`,
        )
        return (JSON.parse(stdout) as WorkflowRunsResponse).workflow_runs
      })

      const fetchLatestBetaFailureUrl = Effect.fn("BetaMonitor.fetchLatestBetaFailureUrl")(function* () {
        const [betaRuns, publishRuns] = yield* Effect.all([
          fetchRuns("beta.yml"),
          fetchRuns("publish.yml", "beta"),
        ])

        const latestFailure = [...betaRuns, ...publishRuns]
          .filter((run) => run.status === "completed" && run.conclusion !== null && run.conclusion !== "success")
          .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())[0]

        return latestFailure?.html_url ?? null
      })

      const checkOnceUnsafe = Effect.fn("BetaMonitor.checkOnce")(function* (channel: AlertChannel) {
        const status = yield* checkBetaNpmStaleness()

        if (status?.stale) {
          const failureUrl = yield* fetchLatestBetaFailureUrl()
          const content = formatBetaStaleAlert(status, failureUrl)

          if (!wasStale) {
            yield* Effect.tryPromise(() => channel.send(content))
            wasStale = true
            yield* Effect.sync(() => console.log(`Beta stale alert: ${status.version} is ${formatBetaAge(status.ageMs)} old`))
          }
          return
        }

        if (status && wasStale) {
          yield* Effect.tryPromise(() => channel.send(formatBetaResolvedAlert(status)))
          wasStale = false
          yield* Effect.sync(() => console.log(`Beta stale alert resolved: ${status.version}`))
        }
      })

      const checkOnce = (channel: AlertChannel) => checkOnceUnsafe(channel).pipe(
        Effect.catch((error) => Effect.sync(() => console.error(`Beta monitor error: ${getErrorMessage(error)}`))),
      )

      const run = (channel: AlertChannel) => Effect.gen(function* () {
        yield* Effect.sleep("15 seconds")
        while (true) {
          yield* checkOnce(channel)
          yield* Effect.sleep("10 minutes")
        }
      })

      return BetaMonitor.of({ checkOnce, run })
    }),
  )

  static readonly defaultLayer = this.layer.pipe(Layer.provide(GithubCli.layer))
}
