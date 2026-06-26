import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { Context, Effect, Layer } from "effect"
import { GithubCli } from "../integrations/github-cli.js"
import { RuntimeConfig } from "../runtime-config.js"
import {
  getNewAlerts,
  getNewlySeenRuns,
  findUnexpectedHistoricalRuns,
  isWorkflowStateForTarget,
  parseWorkflowStateText,
  stringifyWorkflowState,
  type WorkflowAlert,
  type WorkflowRun,
  type WorkflowState,
  type WorkflowTarget,
} from "../workflows.js"
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

export function formatUnexpectedRunsDiagnostic(runs: WorkflowRun[], state: WorkflowState) {
  const watermark = Math.max(...state.seenRunIds, ...state.reportedRunIds)
  const unexpected = findUnexpectedHistoricalRuns(runs, state)
  return JSON.stringify({
    event: "workflow-monitor-rejected-historical-response",
    target: {
      owner: state.owner,
      repo: state.repo,
      workflow: state.workflow,
    },
    watermark,
    seenRunIds: state.seenRunIds,
    reportedRunIds: state.reportedRunIds,
    unexpectedRunIds: unexpected.map((run) => run.databaseId),
    returnedRunCount: runs.length,
    returnedRuns: runs.map((run) => ({
      id: run.databaseId,
      createdAt: run.createdAt,
      updatedAt: run.updatedAt,
      status: run.status,
      conclusion: run.conclusion,
      actor: run.actor.login,
      attempt: run.attempt,
      headBranch: run.headBranch,
      headSha: run.headSha,
      url: run.url,
    })),
  })
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
        })
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
  readonly checkOnce: (channel: AlertChannel) => Effect.Effect<void, unknown>
  readonly run: (channel: AlertChannel) => Effect.Effect<void, unknown>
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
          return yield* Effect.fail(new Error(
            `Workflow state target mismatch: expected ${formatWorkflowTarget(publishWorkflow)}, found ${formatWorkflowTarget({
              owner: state.owner,
              repo: state.repo,
              workflow: state.workflow,
            })}`,
          ))
        }

        const unexpectedHistoricalRuns = findUnexpectedHistoricalRuns(runs, state)
        if (unexpectedHistoricalRuns.length > 0) {
          yield* Effect.sync(() => console.error(formatUnexpectedRunsDiagnostic(runs, state)))
          return
        }

        let dirty = false
        let nextSeen = state.seenRunIds
        let nextReported = state.reportedRunIds

        const triggered = getNewlySeenRuns(runs, state)
        if (triggered.length > 0) {
          nextSeen = [...nextSeen, ...triggered.map((alert) => alert.runId)].slice(-100)
          dirty = true
        }

        const completed = getNewAlerts(runs, state)
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

        for (const alert of triggered) {
          yield* Effect.tryPromise(() => channel.send(formatTriggeredAlert(alert)))
          yield* Effect.sync(() => console.log(`Posted triggered alert: run ${alert.runId} by ${alert.actor}`))
        }

        for (const alert of completed) {
          const tag = alert.success ? yield* github.latestReleaseTag(config.githubOwner, config.githubRepo) : null
          const content = formatCompletedAlert(alert, tag)
          yield* Effect.tryPromise(() => channel.send(content))

          yield* Effect.sync(() => console.log(
            `Posted completion alert: ${alert.conclusion} run ${alert.runId} by ${alert.actor}${tag ? ` (${tag})` : ""}`,
          ))
        }
      })

      const checkOnce = checkOnceUnsafe

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
