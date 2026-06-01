import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { Context, Effect, Layer } from "effect"
import { z } from "zod"
import { isoDateStringFromString, type IsoDateString } from "../domain/value-objects.js"
import { GithubCli } from "../integrations/github-cli.js"
import { NpmRegistry, OPENCODE_NPM_PACKAGE } from "../integrations/npm-registry.js"
import { RuntimeConfig } from "../runtime-config.js"
import type { AlertChannel } from "./types.js"

const BETA_STALE_THRESHOLD_MS = 3 * 60 * 60 * 1000

type BetaNpmStatus = {
  version: string
  publishedAt: IsoDateString
  ageMs: number
  stale: boolean
}

const workflowRunsResponseSchema = z.object({
  workflow_runs: z.array(z.object({
    conclusion: z.string().nullable(),
    status: z.string(),
    html_url: z.string().url(),
    created_at: z.string().transform(isoDateStringFromString),
  })),
})

const betaMonitorStateSchema = z.object({
  messageId: z.string().min(1),
  stale: z.boolean(),
})

type BetaMonitorState = z.infer<typeof betaMonitorStateSchema>

function formatBetaAge(ageMs: number): string {
  const hours = Math.floor(ageMs / (60 * 60 * 1000))
  const mins = Math.floor((ageMs % (60 * 60 * 1000)) / (60 * 1000))
  return hours > 0 ? `${hours}h ${mins}m` : `${mins}m`
}

function formatBetaStaleAlert(status: BetaNpmStatus, failureUrl: string | null): string {
  let msg = `**Beta release is stale** — last published ${formatBetaAge(status.ageMs)} ago (\`${OPENCODE_NPM_PACKAGE}@${status.version}\`)`
  if (failureUrl) {
    msg += `\n[Last failure](<${failureUrl}>)`
  }
  return msg
}

function formatBetaResolvedAlert(status: BetaNpmStatus): string {
  return `~~Beta release was stale~~ — resolved (\`${OPENCODE_NPM_PACKAGE}@${status.version}\`)`
}

export class BetaMonitor extends Context.Service<BetaMonitor, {
  readonly checkOnce: (channel: AlertChannel) => Effect.Effect<void, unknown>
  readonly run: (channel: AlertChannel) => Effect.Effect<void, unknown>
}>()("app/BetaMonitor") {
  static readonly layer = Layer.effect(
    this,
    Effect.gen(function* () {
      const config = yield* RuntimeConfig
      const github = yield* GithubCli
      const npm = yield* NpmRegistry
      const statePath = join(dirname(config.stateFile), "beta-monitor-state.json")

      const loadState = Effect.fn("BetaMonitor.loadState")(function* () {
        return yield* Effect.tryPromise({
          try: async () => {
            try {
              return betaMonitorStateSchema.parse(JSON.parse(await readFile(statePath, "utf8")))
            } catch (error) {
              if (error instanceof Error && "code" in error && error.code === "ENOENT") return null
              throw error
            }
          },
          catch: (error) => error,
        })
      })

      const saveState = Effect.fn("BetaMonitor.saveState")(function* (state: BetaMonitorState) {
        yield* Effect.tryPromise({
          try: async () => {
            await mkdir(dirname(statePath), { recursive: true })
            await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8")
          },
          catch: (error) => error,
        })
      })

      const checkBetaNpmStaleness = Effect.fn("BetaMonitor.checkBetaNpmStaleness")(function* () {
        const data = yield* npm.packument(OPENCODE_NPM_PACKAGE)
        const betaVersion = data["dist-tags"]?.beta
        if (!betaVersion) {
          return yield* Effect.fail(new Error(`${OPENCODE_NPM_PACKAGE} has no beta dist-tag`))
        }

        const rawPublishedAt = data.time?.[betaVersion]
        if (!rawPublishedAt) {
          return yield* Effect.fail(new Error(`${OPENCODE_NPM_PACKAGE}@${betaVersion} is missing publish time`))
        }

        const publishedAt = isoDateStringFromString(rawPublishedAt)
        const now = yield* Effect.sync(() => Date.now())
        const ageMs = now - new Date(publishedAt).getTime()

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
        return workflowRunsResponseSchema.parse(JSON.parse(stdout)).workflow_runs
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
        const state = yield* loadState()

        if (status.stale) {
          const failureUrl = yield* fetchLatestBetaFailureUrl()
          const content = formatBetaStaleAlert(status, failureUrl)

          if (state) {
            yield* Effect.tryPromise(() => channel.edit(state.messageId, content))
            if (!state.stale) {
              yield* saveState({ ...state, stale: true })
              yield* Effect.sync(() => console.log(`Beta stale alert: ${status.version} is ${formatBetaAge(status.ageMs)} old`))
            }
          } else {
            const message = yield* Effect.tryPromise(() => channel.send(content))
            yield* saveState({ messageId: message.id, stale: true })
            yield* Effect.sync(() => console.log(`Beta stale alert: ${status.version} is ${formatBetaAge(status.ageMs)} old`))
          }
          return
        }

        if (state?.stale) {
          yield* Effect.tryPromise(() => channel.edit(state.messageId, formatBetaResolvedAlert(status)))
          yield* saveState({ ...state, stale: false })
          yield* Effect.sync(() => console.log(`Beta stale alert resolved: ${status.version}`))
        }
      })

      const checkOnce = checkOnceUnsafe

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

  static readonly defaultLayer = this.layer.pipe(
    Layer.provide(GithubCli.layer),
    Layer.provide(NpmRegistry.layer),
  )
}
