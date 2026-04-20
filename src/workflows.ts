import { execFile } from "node:child_process"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname } from "node:path"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)

type WorkflowRunJson = {
  databaseId: number
  conclusion: string
  status: string
  actor: { login: string }
  url: string
  displayTitle: string
}

type WorkflowState = {
  seenRunIds: number[]
  reportedRunIds: number[]
}

export type WorkflowAlert = {
  runId: number
  success: boolean
  actor: string
  title: string
  url: string
  conclusion: string
}

type WorkflowRunApiResponse = {
  workflow_runs: Array<{
    id: number
    conclusion: string | null
    status: string
    triggering_actor: { login: string }
    html_url: string
    display_title: string
  }>
}

export async function fetchPublishWorkflowRuns(owner: string, repo: string): Promise<WorkflowRunJson[]> {
  const { stdout } = await execFileAsync("gh", [
    "api", `repos/${owner}/${repo}/actions/workflows/publish.yml/runs?event=workflow_dispatch&per_page=20`,
  ], { timeout: 30_000 })

  const response = JSON.parse(stdout) as WorkflowRunApiResponse

  return response.workflow_runs.map((run) => ({
    databaseId: run.id,
    conclusion: run.conclusion ?? "",
    status: run.status,
    actor: { login: run.triggering_actor.login },
    url: run.html_url,
    displayTitle: run.display_title,
  }))
}

export async function loadWorkflowState(filePath: string): Promise<WorkflowState> {
  try {
    const text = await readFile(filePath, "utf8")
    const state = JSON.parse(text) as Partial<WorkflowState>
    return {
      seenRunIds: Array.isArray(state.seenRunIds) ? state.seenRunIds : [],
      reportedRunIds: Array.isArray(state.reportedRunIds) ? state.reportedRunIds : [],
    }
  } catch (error) {
    if (typeof error === "object" && error && "code" in error && error.code === "ENOENT") {
      return { seenRunIds: [], reportedRunIds: [] }
    }
    throw error
  }
}

export async function saveWorkflowState(filePath: string, state: WorkflowState): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true })
  await writeFile(filePath, `${JSON.stringify(state, null, 2)}\n`, "utf8")
}

export function getAllRunIds(runs: WorkflowRunJson[]): number[] {
  return runs.map((run) => run.databaseId)
}

export function getCompletedRunIds(runs: WorkflowRunJson[]): number[] {
  return runs.filter((run) => run.status === "completed").map((run) => run.databaseId)
}

export function getNewlySeenRuns(runs: WorkflowRunJson[], state: WorkflowState): WorkflowAlert[] {
  return runs
    .filter((run) => !state.seenRunIds.includes(run.databaseId))
    .map((run) => ({
      runId: run.databaseId,
      success: run.conclusion === "success",
      actor: run.actor.login,
      title: run.displayTitle,
      url: run.url,
      conclusion: run.conclusion,
    }))
}

export async function fetchLatestReleaseTag(owner: string, repo: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("gh", [
      "api", `repos/${owner}/${repo}/releases?per_page=1`,
      "--jq", ".[0].tag_name",
    ], { timeout: 30_000 })

    const tag = stdout.trim()
    return tag && tag !== "null" ? tag : null
  } catch {
    return null
  }
}

export function getNewAlerts(runs: WorkflowRunJson[], state: WorkflowState): WorkflowAlert[] {
  return runs
    .filter((run) => run.status === "completed" && !state.reportedRunIds.includes(run.databaseId))
    .map((run) => ({
      runId: run.databaseId,
      success: run.conclusion === "success",
      actor: run.actor.login,
      title: run.displayTitle,
      url: run.url,
      conclusion: run.conclusion,
    }))
}

const BETA_STALE_THRESHOLD_MS = 3 * 60 * 60 * 1000

type NpmPackument = {
  "dist-tags"?: Record<string, string>
  time?: Record<string, string>
}

export type BetaNpmStatus = {
  version: string
  publishedAt: string
  ageMs: number
  stale: boolean
}

export async function fetchLatestBetaFailureUrl(owner: string, repo: string): Promise<string | null> {
  type RunsResponse = {
    workflow_runs: Array<{
      conclusion: string | null
      status: string
      html_url: string
      created_at: string
    }>
  }

  async function fetchRuns(workflow: string, branch?: string) {
    const params = new URLSearchParams({ per_page: "5" })
    if (branch) params.set("branch", branch)

    const { stdout } = await execFileAsync("gh", [
      "api", `repos/${owner}/${repo}/actions/workflows/${workflow}/runs?${params}`,
    ], { timeout: 30_000 })

    return (JSON.parse(stdout) as RunsResponse).workflow_runs
  }

  try {
    const [betaRuns, publishRuns] = await Promise.all([
      fetchRuns("beta.yml"),
      fetchRuns("publish.yml", "beta"),
    ])

    const latestFailure = [...betaRuns, ...publishRuns]
      .filter((run) => run.status === "completed" && run.conclusion !== null && run.conclusion !== "success")
      .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())[0]

    return latestFailure?.html_url ?? null
  } catch {
    return null
  }
}

export async function checkBetaNpmStaleness(packageName: string): Promise<BetaNpmStatus | null> {
  try {
    const response = await fetch(`https://registry.npmjs.org/${packageName}`, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(15_000),
    })
    if (!response.ok) return null

    const data = (await response.json()) as NpmPackument
    const betaVersion = data["dist-tags"]?.beta
    if (!betaVersion) return null

    const publishedAt = data.time?.[betaVersion]
    if (!publishedAt) return null

    const ageMs = Date.now() - new Date(publishedAt).getTime()

    return {
      version: betaVersion,
      publishedAt,
      ageMs,
      stale: ageMs > BETA_STALE_THRESHOLD_MS,
    }
  } catch {
    return null
  }
}
