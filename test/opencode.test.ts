import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { Effect, Layer, ManagedRuntime } from "effect"
import type { AppConfig } from "../src/config.js"
import { OpencodeServer } from "../src/opencode.js"
import { RuntimeConfig } from "../src/runtime-config.js"

const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe("OpencodeServer", () => {
  test("authenticates its client when the spawned server requires a password", async () => {
    const directory = await mkdtemp(join(tmpdir(), "opencode-server-test-"))
    directories.push(directory)
    const previousPassword = process.env.OPENCODE_SERVER_PASSWORD
    const previousUsername = process.env.OPENCODE_SERVER_USERNAME
    process.env.OPENCODE_SERVER_PASSWORD = "server-password"
    process.env.OPENCODE_SERVER_USERNAME = "test-user"

    const config = {
      githubOwner: "anomalyco",
      githubRepo: "opencode",
      githubReleaseLimit: 20,
      githubProcessDrafts: false,
      upstreamCloneUrl: "https://github.com/anomalyco/opencode.git",
      opencodeTimeoutMs: 600_000,
      opencodeEchoOutput: false,
      stateFile: join(directory, "posted-releases.json"),
      dryRun: true,
    } satisfies AppConfig
    const runtime = ManagedRuntime.make(OpencodeServer.layer.pipe(
      Layer.provide(RuntimeConfig.layer(config)),
    ))

    try {
      await runtime.runPromise(OpencodeServer.use((server) => server.withServer(directory, (running) => Effect.gen(function* () {
        const response = yield* Effect.tryPromise(() => running.client.session.create({}))
        expect(response.response.status).toBe(200)
        expect(response.data?.id).toBeString()
      }))))
    } finally {
      await runtime.dispose()
      if (previousPassword === undefined) delete process.env.OPENCODE_SERVER_PASSWORD
      else process.env.OPENCODE_SERVER_PASSWORD = previousPassword
      if (previousUsername === undefined) delete process.env.OPENCODE_SERVER_USERNAME
      else process.env.OPENCODE_SERVER_USERNAME = previousUsername
    }
  })
})
