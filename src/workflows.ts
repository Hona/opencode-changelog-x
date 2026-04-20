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

export async function fetchPublishWorkflowRuns(owner: string, repo: string): Promise<WorkflowRunJson[]> {
  const { stdout } = await execFileAsync("gh", [
    "run", "list",
    "--repo", `${owner}/${repo}`,
    "--workflow", "publish.yml",
    "--event", "workflow_dispatch",
    "--limit", "20",
    "--json", "databaseId,conclusion,status,actor,url,displayTitle",
  ], { timeout: 30_000 })

  return JSON.parse(stdout) as WorkflowRunJson[]
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
