import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { Context, Effect, Layer, Schema } from "effect"
import { z } from "zod"
import { releaseTagFromString, workflowRunIdFromNumber, type ReleaseTag } from "../domain/value-objects.js"
import type { WorkflowRun, WorkflowTarget } from "../workflows.js"

const execFileAsync = promisify(execFile)

export class GithubCliError extends Schema.TaggedErrorClass<GithubCliError>()("GithubCliError", {
  command: Schema.String,
  cause: Schema.Defect,
}) {}

const workflowRunApiResponseSchema = z.object({
  workflow_runs: z.array(z.object({
    id: z.number(),
    conclusion: z.string().nullable(),
    status: z.string(),
    triggering_actor: z.object({ login: z.string() }),
    html_url: z.string().url(),
  })),
})

function workflowPath(target: WorkflowTarget) {
  return `repos/${target.owner}/${target.repo}/actions/workflows/${encodeURIComponent(target.workflow)}`
}

export type GithubCliService = {
  readonly api: (path: string, args?: string[]) => Effect.Effect<string, GithubCliError>
  readonly listWorkflowDispatchRuns: (target: WorkflowTarget) => Effect.Effect<WorkflowRun[], GithubCliError>
  readonly hasActiveWorkflowDispatchRun: (target: WorkflowTarget) => Effect.Effect<boolean, GithubCliError>
  readonly runWorkflow: (target: WorkflowTarget, inputs: Record<string, string>) => Effect.Effect<void, GithubCliError>
  readonly latestReleaseTag: (owner: string, repo: string) => Effect.Effect<ReleaseTag | null, GithubCliError>
}

export class GithubCli extends Context.Service<GithubCli, GithubCliService>()("app/GithubCli") {
  static readonly layer = Layer.effect(
    this,
    Effect.gen(function* () {
      const api = Effect.fn("GithubCli.api")(function* (path: string, args: string[] = []) {
        const command = `gh api ${path} ${args.join(" ")}`.trim()
        const { stdout } = yield* Effect.tryPromise({
          try: () => execFileAsync("gh", ["api", path, ...args], { timeout: 30_000 }),
          catch: (cause) => new GithubCliError({ command, cause }),
        })
        return stdout.trim()
      })

      const listWorkflowDispatchRuns = Effect.fn("GithubCli.listWorkflowDispatchRuns")(function* (target: WorkflowTarget) {
        const params = new URLSearchParams({ event: "workflow_dispatch", per_page: "20" })
        const stdout = yield* api(`${workflowPath(target)}/runs?${params}`)
        const response = workflowRunApiResponseSchema.parse(JSON.parse(stdout))

        return response.workflow_runs.map((run) => ({
          databaseId: workflowRunIdFromNumber(run.id),
          conclusion: run.conclusion ?? "",
          status: run.status,
          actor: { login: run.triggering_actor.login },
          url: run.html_url,
        }))
      })

      const hasActiveWorkflowDispatchRun = Effect.fn("GithubCli.hasActiveWorkflowDispatchRun")(function* (target: WorkflowTarget) {
        const runs = yield* listWorkflowDispatchRuns(target)
        return runs.some((run) => run.status !== "completed")
      })

      const runWorkflow = Effect.fn("GithubCli.runWorkflow")(function* (target: WorkflowTarget, inputs: Record<string, string>) {
        const inputArgs = Object.entries(inputs).flatMap(([key, value]) => ["-f", `${key}=${value}`])
        const args = [
          "workflow", "run", target.workflow,
          "--repo", `${target.owner}/${target.repo}`,
          ...inputArgs,
        ]
        const command = `gh ${args.join(" ")}`
        yield* Effect.tryPromise({
          try: () => execFileAsync("gh", args, { timeout: 30_000 }),
          catch: (cause) => new GithubCliError({ command, cause }),
        })
      })

      const latestReleaseTag = Effect.fn("GithubCli.latestReleaseTag")(function* (owner: string, repo: string) {
        const tag = yield* api(`repos/${owner}/${repo}/releases?per_page=1`, ["--jq", ".[0].tag_name"])
        const trimmed = tag.trim()
        return trimmed && trimmed !== "null" ? releaseTagFromString(trimmed) : null
      })

      return GithubCli.of({
        api,
        listWorkflowDispatchRuns,
        hasActiveWorkflowDispatchRun,
        runWorkflow,
        latestReleaseTag,
      })
    }),
  )
}
