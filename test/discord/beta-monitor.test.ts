import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { Effect, Layer, ManagedRuntime } from "effect"
import type { AppConfig } from "../../src/config.js"
import { BetaMonitor } from "../../src/discord/beta-monitor.js"
import { GithubCli } from "../../src/integrations/github-cli.js"
import { NpmRegistry } from "../../src/integrations/npm-registry.js"
import { RuntimeConfig } from "../../src/runtime-config.js"

const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

async function makeRuntime(stateFile: string, publishedAt = () => "2026-01-01T00:00:00.000Z") {
  const config = {
    githubOwner: "anomalyco",
    githubRepo: "opencode",
    githubReleaseLimit: 20,
    githubProcessDrafts: false,
    upstreamCloneUrl: "https://github.com/anomalyco/opencode.git",
    opencodeTimeoutMs: 600_000,
    opencodeEchoOutput: false,
    stateFile,
    dryRun: true,
  } satisfies AppConfig

  const npm = NpmRegistry.of({
    packument: () => Effect.succeed({
      "dist-tags": { beta: "0.0.0-beta-test" },
      time: { "0.0.0-beta-test": publishedAt() },
    }),
    versionMetadata: () => Effect.fail(new Error("unexpected versionMetadata call")),
    downloadTarball: () => Effect.fail(new Error("unexpected downloadTarball call")),
  })
  const github = GithubCli.of({
    api: () => Effect.succeed(JSON.stringify({ workflow_runs: [] })),
    listWorkflowDispatchRuns: () => Effect.fail(new Error("unexpected listWorkflowDispatchRuns call")),
    hasActiveWorkflowDispatchRun: () => Effect.fail(new Error("unexpected hasActiveWorkflowDispatchRun call")),
    runWorkflow: () => Effect.fail(new Error("unexpected runWorkflow call")),
    latestReleaseTag: () => Effect.fail(new Error("unexpected latestReleaseTag call")),
  })

  return ManagedRuntime.make(BetaMonitor.layer.pipe(
    Layer.provide(RuntimeConfig.layer(config)),
    Layer.provide(Layer.succeed(NpmRegistry, npm)),
    Layer.provide(Layer.succeed(GithubCli, github)),
  ))
}

describe("BetaMonitor", () => {
  test("edits the existing stale alert rather than sending repeated messages", async () => {
    const directory = await mkdtemp(join(tmpdir(), "beta-monitor-test-"))
    directories.push(directory)
    const sent: string[] = []
    const edits: Array<{ id: string; content: string }> = []
    const channel = {
      send: async (content) => {
        sent.push(content)
        return { id: "beta-alert" }
      },
      edit: async (id, content) => {
        edits.push({ id, content })
      },
    }
    const stateFile = join(directory, "posted-releases.json")
    const runtime = await makeRuntime(stateFile)

    await runtime.runPromise(BetaMonitor.use((monitor) => monitor.checkOnce(channel)))
    await runtime.runPromise(BetaMonitor.use((monitor) => monitor.checkOnce(channel)))
    await runtime.dispose()

    expect(sent).toHaveLength(1)
    expect(edits).toEqual([{ id: "beta-alert", content: sent[0]! }])
  })

  test("reuses the existing alert after monitor reconstruction", async () => {
    const directory = await mkdtemp(join(tmpdir(), "beta-monitor-test-"))
    directories.push(directory)
    const sent: string[] = []
    const editedIds: string[] = []
    const channel = {
      send: async (content) => {
        sent.push(content)
        return { id: "beta-alert" }
      },
      edit: async (id) => {
        editedIds.push(id)
      },
    }
    const stateFile = join(directory, "posted-releases.json")
    const firstRuntime = await makeRuntime(stateFile)

    await firstRuntime.runPromise(BetaMonitor.use((monitor) => monitor.checkOnce(channel)))
    await firstRuntime.dispose()

    const secondRuntime = await makeRuntime(stateFile)
    await secondRuntime.runPromise(BetaMonitor.use((monitor) => monitor.checkOnce(channel)))
    await secondRuntime.dispose()

    expect(sent).toHaveLength(1)
    expect(editedIds).toEqual(["beta-alert"])
  })

  test("edits the stale alert when the beta release recovers", async () => {
    const directory = await mkdtemp(join(tmpdir(), "beta-monitor-test-"))
    directories.push(directory)
    let publishedAt = "2026-01-01T00:00:00.000Z"
    const sent: string[] = []
    const edits: string[] = []
    const channel = {
      send: async (content: string) => {
        sent.push(content)
        return { id: "beta-alert" }
      },
      edit: async (_id: string, content: string) => {
        edits.push(content)
      },
    }
    const runtime = await makeRuntime(join(directory, "posted-releases.json"), () => publishedAt)

    await runtime.runPromise(BetaMonitor.use((monitor) => monitor.checkOnce(channel)))
    publishedAt = new Date().toISOString()
    await runtime.runPromise(BetaMonitor.use((monitor) => monitor.checkOnce(channel)))
    await runtime.dispose()

    expect(sent).toHaveLength(1)
    expect(edits).toEqual(["~~Beta release was stale~~ — resolved (`opencode-ai@0.0.0-beta-test`)"])
  })
})
