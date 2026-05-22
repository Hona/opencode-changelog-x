export type WorkflowTarget = {
  owner: string
  repo: string
  workflow: string
}

export type WorkflowRun = {
  databaseId: number
  conclusion: string
  status: string
  actor: { login: string }
  url: string
}

export type WorkflowState = {
  owner?: string
  repo?: string
  workflow?: string
  seenRunIds: number[]
  reportedRunIds: number[]
}

export type WorkflowAlert = {
  runId: number
  success: boolean
  actor: string
  url: string
  conclusion: string
}

function readRunIds(value: unknown) {
  return Array.isArray(value) ? value.filter((id): id is number => Number.isInteger(id)) : []
}

export function createEmptyWorkflowState(): WorkflowState {
  return {
    seenRunIds: [],
    reportedRunIds: [],
  }
}

export function parseWorkflowStateText(text: string): WorkflowState {
  const state = JSON.parse(text) as Partial<WorkflowState>
  return {
    owner: typeof state.owner === "string" ? state.owner : undefined,
    repo: typeof state.repo === "string" ? state.repo : undefined,
    workflow: typeof state.workflow === "string" ? state.workflow : undefined,
    seenRunIds: readRunIds(state.seenRunIds),
    reportedRunIds: readRunIds(state.reportedRunIds),
  }
}

export function isWorkflowStateForTarget(state: WorkflowState, target: WorkflowTarget) {
  return state.owner === target.owner && state.repo === target.repo && state.workflow === target.workflow
}

export function stringifyWorkflowState(state: WorkflowState) {
  return `${JSON.stringify(state, null, 2)}\n`
}

export function getAllRunIds(runs: WorkflowRun[]): number[] {
  return runs.map((run) => run.databaseId)
}

export function getCompletedRunIds(runs: WorkflowRun[]): number[] {
  return runs.filter((run) => run.status === "completed").map((run) => run.databaseId)
}

export function getNewlySeenRuns(runs: WorkflowRun[], state: WorkflowState): WorkflowAlert[] {
  return runs
    .filter((run) => !state.seenRunIds.includes(run.databaseId))
    .map((run) => ({
      runId: run.databaseId,
      success: run.conclusion === "success",
      actor: run.actor.login,
      url: run.url,
      conclusion: run.conclusion,
    }))
}

export function getNewAlerts(runs: WorkflowRun[], state: WorkflowState): WorkflowAlert[] {
  return runs
    .filter((run) => run.status === "completed" && !state.reportedRunIds.includes(run.databaseId))
    .map((run) => ({
      runId: run.databaseId,
      success: run.conclusion === "success",
      actor: run.actor.login,
      url: run.url,
      conclusion: run.conclusion,
    }))
}
