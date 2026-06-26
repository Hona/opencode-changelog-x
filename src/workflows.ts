import { z } from "zod"
import { workflowRunIdFromNumber, type IsoDateString, type WorkflowRunId } from "./domain/value-objects.js"

export type WorkflowTarget = {
  owner: string
  repo: string
  workflow: string
}

export type WorkflowRun = {
  databaseId: WorkflowRunId
  conclusion: string
  status: string
  actor: { login: string }
  url: string
  createdAt: IsoDateString
  updatedAt: IsoDateString
  attempt: number
  headBranch: string
  headSha: string
  event: string
}

export type WorkflowState = {
  owner: string
  repo: string
  workflow: string
  seenRunIds: WorkflowRunId[]
  reportedRunIds: WorkflowRunId[]
}

export type WorkflowAlert = {
  runId: WorkflowRunId
  success: boolean
  actor: string
  url: string
  conclusion: string
}

const workflowStateSchema = z.object({
  owner: z.string().min(1),
  repo: z.string().min(1),
  workflow: z.string().min(1),
  seenRunIds: z.array(z.number().transform(workflowRunIdFromNumber)),
  reportedRunIds: z.array(z.number().transform(workflowRunIdFromNumber)),
}).strict()

export function parseWorkflowStateText(text: string): WorkflowState {
  return workflowStateSchema.parse(JSON.parse(text))
}

export function isWorkflowStateForTarget(state: WorkflowState, target: WorkflowTarget) {
  return state.owner === target.owner && state.repo === target.repo && state.workflow === target.workflow
}

export function stringifyWorkflowState(state: WorkflowState) {
  return `${JSON.stringify(state, null, 2)}\n`
}

export function findUnexpectedHistoricalRuns(runs: WorkflowRun[], state: WorkflowState): WorkflowRun[] {
  const knownIds = [...state.seenRunIds, ...state.reportedRunIds]
  if (knownIds.length === 0) return []

  const watermark = Math.max(...knownIds)
  const known = new Set(knownIds)
  return runs.filter((run) => !known.has(run.databaseId) && run.databaseId <= watermark)
}

export function selectWorkflowDispatchRuns(runs: WorkflowRun[]): WorkflowRun[] {
  return runs
    .filter((run) => run.event === "workflow_dispatch")
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
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
