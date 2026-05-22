import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { Context, Effect, Layer } from "effect"
import { GithubCli } from "../integrations/github-cli.js"
import { RuntimeConfig } from "../runtime-config.js"
import {
  createEmptyWorkflowState,
  getAllRunIds,
  getCompletedRunIds,
  getNewAlerts,
  getNewlySeenRuns,
  isWorkflowStateForTarget,
  parseWorkflowStateText,
  stringifyWorkflowState,
  type WorkflowAlert,
  type WorkflowState,
  type WorkflowTarget,
} from "../workflows.js"
import { getErrorMessage } from "./errors.js"
import type { AlertChannel } from "./types.js"

function buildPublishWorkflowTarget(config: { githubOwner: string; githubRepo: string }) {
  return {
    owner: config.githubOwner,
    repo: config.githubRepo,
    workflow: "publish.yml",
  } satisfies WorkflowTarget
}

function formatTriggeredAlert(alert: WorkflowAlert): string {
  return `\`${alert.actor}\` triggered release\n[View workflow run](<${alert.url}>)`
}

function formatCompletedAlert(alert: WorkflowAlert, tag: string | null): string {
  if (alert.success && tag) {
    return `\`${alert.actor}\` triggered \`${tag}\` release\n[View workflow run](<${alert.url}>)`
  }
  if (alert.success) {
    return `\`${alert.actor}\` triggered release — **published**\n[View workflow run](<${alert.url}>)`
  }
  const verb = alert.conclusion === "cancelled" ? "cancelled" : "failed"
  return `\`${alert.actor}\` triggered release — **${verb}**\n[Open logs](<${alert.url}>)`
}

function formatWorkflowTarget(target: WorkflowTarget) {
  return `${target.owner}/${target.repo} ${target.workflow}`
}

class WorkflowMonitorStateStore extends Context.Service<WorkflowMonitorStateStore, {
  readonly load: () => Effect.Effect<WorkflowState, unknown>
  readonly save: (state: WorkflowState) => Effect.Effect<void, unknown>
}>()("app/WorkflowMonitorStateStore") {
  static readonly layer = Layer.effect(
    this,
    Effect.gen(function* () {
      const config = yield* RuntimeConfig
      const filePath = join(dirname(config.stateFile), "publish-workflow-state.json")

      const load = Effect.fn("WorkflowMonitorStateStore.load")(function* () {
        return yield* Effect.tryPromise({
          try: async () => parseWorkflowStateText(await readFile(filePath, "utf8")),
          catch: (error) => error,
        }).pipe(
          Effect.catchIf(
            (error) => typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT",
            () => Effect.succeed(createEmptyWorkflowState()),
          ),
        )
      })

      const save = Effect.fn("WorkflowMonitorStateStore.save")(function* (state: WorkflowState) {
        yield* Effect.tryPromise({
          try: async () => {
            await mkdir(dirname(filePath), { recursive: true })
            await writeFile(filePath, stringifyWorkflowState(state), "utf8")
          },
          catch: (error) => error,
        })
      })

      return WorkflowMonitorStateStore.of({ load, save })
    }),
  )
}

export class PublishWorkflowMonitor extends Context.Service<PublishWorkflowMonitor, {
  readonly checkOnce: (channel: AlertChannel) => Effect.Effect<void>
  readonly run: (channel: AlertChannel) => Effect.Effect<void>
}>()("app/PublishWorkflowMonitor") {
  static readonly layer = Layer.effect(
    this,
    Effect.gen(function* () {
      const config = yield* RuntimeConfig
      const github = yield* GithubCli
      const stateStore = yield* WorkflowMonitorStateStore
      const publishWorkflow = buildPublishWorkflowTarget(config)

      const checkOnceUnsafe = Effect.fn("PublishWorkflowMonitor.checkOnce")(function* (channel: AlertChannel) {
        const [runs, state] = yield* Effect.all([
          github.listWorkflowDispatchRuns(publishWorkflow),
          stateStore.load(),
        ])

        if (!isWorkflowStateForTarget(state, publishWorkflow)) {
          const allIds = getAllRunIds(runs)
          const completedIds = getCompletedRunIds(runs)
          yield* Effect.sync(() => console.log(
            `Seeding workflow state for ${formatWorkflowTarget(publishWorkflow)} with ${allIds.length} existing run(s).`,
          ))
          yield* stateStore.save({
            ...publishWorkflow,
            seenRunIds: allIds,
            reportedRunIds: completedIds,
          })
          return
        }

        let dirty = false
        let nextSeen = state.seenRunIds
        let nextReported = state.reportedRunIds

        const triggered = getNewlySeenRuns(runs, state)
        for (const alert of triggered) {
          yield* Effect.tryPromise(() => channel.send(formatTriggeredAlert(alert)))
          yield* Effect.sync(() => console.log(`Posted triggered alert: run ${alert.runId} by ${alert.actor}`))
        }
        if (triggered.length > 0) {
          nextSeen = [...nextSeen, ...triggered.map((alert) => alert.runId)].slice(-100)
          dirty = true
        }

        const completed = getNewAlerts(runs, state)
        for (const alert of completed) {
          const tag = alert.success ? yield* github.latestReleaseTag(config.githubOwner, config.githubRepo) : null
          const content = formatCompletedAlert(alert, tag)
          yield* Effect.tryPromise(() => channel.send(content))

          yield* Effect.sync(() => console.log(
            `Posted completion alert: ${alert.conclusion} run ${alert.runId} by ${alert.actor}${tag ? ` (${tag})` : ""}`,
          ))
        }
        if (completed.length > 0) {
          nextReported = [...nextReported, ...completed.map((alert) => alert.runId)].slice(-100)
          dirty = true
        }

        if (dirty) {
          yield* stateStore.save({
            ...publishWorkflow,
            seenRunIds: nextSeen,
            reportedRunIds: nextReported,
          })
        }
      })

      const checkOnce = (channel: AlertChannel) => checkOnceUnsafe(channel).pipe(
        Effect.catch((error) => Effect.sync(() => console.error(`Workflow monitor error: ${getErrorMessage(error)}`))),
      )

      const run = (channel: AlertChannel) => Effect.gen(function* () {
        yield* Effect.sleep("5 seconds")
        while (true) {
          yield* checkOnce(channel)
          yield* Effect.sleep("5 minutes")
        }
      })

      return PublishWorkflowMonitor.of({ checkOnce, run })
    }),
  )

  static readonly defaultLayer = this.layer.pipe(
    Layer.provide(WorkflowMonitorStateStore.layer),
    Layer.provide(GithubCli.layer),
  )
}
