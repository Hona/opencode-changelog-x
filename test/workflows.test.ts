import { describe, expect, test } from "bun:test"
import { isoDateStringFromString, workflowRunIdFromNumber } from "../src/domain/value-objects.js"
import { formatUnexpectedRunsDiagnostic } from "../src/discord/publish-workflow-monitor.js"
import { findUnexpectedHistoricalRuns, type WorkflowRun, type WorkflowState } from "../src/workflows.js"

function run(id: number): WorkflowRun {
  return {
    databaseId: workflowRunIdFromNumber(id),
    conclusion: "success",
    status: "completed",
    actor: { login: "Hona" },
    url: `https://github.com/anomalyco/opencode/actions/runs/${id}`,
    createdAt: isoDateStringFromString("2026-05-01T00:00:00Z"),
    updatedAt: isoDateStringFromString("2026-05-01T00:30:00Z"),
    attempt: 1,
    headBranch: "dev",
    headSha: "abc123",
  }
}

function state(ids: number[]): WorkflowState {
  return {
    owner: "anomalyco",
    repo: "opencode",
    workflow: "publish.yml",
    seenRunIds: ids.map(workflowRunIdFromNumber),
    reportedRunIds: ids.map(workflowRunIdFromNumber),
  }
}

describe("findUnexpectedHistoricalRuns", () => {
  test("rejects unseen run IDs below the observed watermark", () => {
    const current = state([28126434451, 28167303470])

    expect(findUnexpectedHistoricalRuns([run(28167303470), run(25468200151)], current))
      .toEqual([run(25468200151)])
  })

  test("allows known historical runs and unseen newer runs", () => {
    const current = state([28126434451, 28167303470])

    expect(findUnexpectedHistoricalRuns([run(28167303470), run(28230000000)], current)).toEqual([])
  })

  test("diagnostic logs every returned run field and persisted ID", () => {
    const current = state([28126434451, 28167303470])
    const diagnostic = JSON.parse(formatUnexpectedRunsDiagnostic([run(25468200151)], current))

    expect(diagnostic).toEqual({
      event: "workflow-monitor-rejected-historical-response",
      target: { owner: "anomalyco", repo: "opencode", workflow: "publish.yml" },
      watermark: 28167303470,
      seenRunIds: [28126434451, 28167303470],
      reportedRunIds: [28126434451, 28167303470],
      unexpectedRunIds: [25468200151],
      returnedRunCount: 1,
      returnedRuns: [{
        id: 25468200151,
        createdAt: "2026-05-01T00:00:00Z",
        updatedAt: "2026-05-01T00:30:00Z",
        status: "completed",
        conclusion: "success",
        actor: "Hona",
        attempt: 1,
        headBranch: "dev",
        headSha: "abc123",
        url: "https://github.com/anomalyco/opencode/actions/runs/25468200151",
      }],
    })
  })
})
