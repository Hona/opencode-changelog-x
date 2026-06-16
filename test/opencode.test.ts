import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { execFile } from "node:child_process"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { delimiter, join } from "node:path"
import { tmpdir } from "node:os"
import { promisify } from "node:util"
import { Effect, Layer, ManagedRuntime } from "effect"
import type { AppConfig } from "../src/config.js"
import { OPENCODE_SERVER_ARGS, OpencodeServer } from "../src/opencode.js"
import { RuntimeConfig } from "../src/runtime-config.js"

const directories: string[] = []
const execFileAsync = promisify(execFile)
let previousPath: string | undefined
let previousXdg: Record<string, string | undefined>

beforeEach(async () => {
  previousPath = process.env.PATH
  process.env.PATH = `${join(process.cwd(), "node_modules", ".bin")}${delimiter}${previousPath ?? ""}`
  const root = await mkdtemp(join(tmpdir(), "opencode-home-test-"))
  directories.push(root)
  previousXdg = Object.fromEntries(["XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_CONFIG_HOME", "XDG_STATE_HOME"].map((key) => [key, process.env[key]]))
  process.env.XDG_DATA_HOME = join(root, "data")
  process.env.XDG_CACHE_HOME = join(root, "cache")
  process.env.XDG_CONFIG_HOME = join(root, "config")
  process.env.XDG_STATE_HOME = join(root, "state")
})

afterEach(async () => {
  process.env.PATH = previousPath
  for (const [key, value] of Object.entries(previousXdg)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  await Promise.all(directories.splice(0).map(async (directory) => {
    try {
      await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
    } catch (error) {
      if (process.platform !== "win32" || !(error instanceof Error) || !("code" in error) || error.code !== "EBUSY") throw error
    }
  }))
})

function makeRuntime(directory: string) {
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
  return ManagedRuntime.make(OpencodeServer.layer.pipe(
    Layer.provide(RuntimeConfig.layer(config)),
  ))
}

describe("OpencodeServer", () => {
  test("prints only server errors to captured output", () => {
    expect(OPENCODE_SERVER_ARGS).toContain("--print-logs")
    expect(OPENCODE_SERVER_ARGS).toContain("--log-level=ERROR")
  })

  test.serial("authenticates its client when the spawned server requires a password", async () => {
    const directory = await mkdtemp(join(tmpdir(), "opencode-server-test-"))
    directories.push(directory)
    const previousPassword = process.env.OPENCODE_SERVER_PASSWORD
    const previousUsername = process.env.OPENCODE_SERVER_USERNAME
    process.env.OPENCODE_SERVER_PASSWORD = "server-password"
    process.env.OPENCODE_SERVER_USERNAME = "test-user"

    const runtime = makeRuntime(directory)

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
  }, 15_000)

  test.serial("accepts the current upstream reference configuration", async () => {
    const directory = await mkdtemp(join(tmpdir(), "opencode-server-test-"))
    directories.push(directory)
    await execFileAsync("git", ["init"], { cwd: directory })
    await mkdir(join(directory, ".opencode"), { recursive: true })
    // Mirrors anomalyco/opencode .opencode/opencode.jsonc as of v1.17.4.
    await writeFile(join(directory, ".opencode", "opencode.jsonc"), `{
  "$schema": "https://opencode.ai/config.json",
  "provider": {},
  "permission": {},
  "references": {
    "effect": {
      "repository": "github.com/Effect-TS/effect-smol",
      "description": "Use for Effect v4 and effect-smol implementation details",
    },
    "opencode-local": {
      "path": "~/.local/share/opencode",
      "description": "Contains opencode logs and data",
    },
  },
  "mcp": {},
  "tools": {
    "github-triage": false,
    "github-pr-search": false,
  },
}
`, "utf8")
    const runtime = makeRuntime(directory)

    try {
      await runtime.runPromise(OpencodeServer.use((server) => server.withServer(directory, (running) => Effect.gen(function* () {
        const response = yield* Effect.tryPromise(() => running.client.session.create({}))
        expect(response.response.status).toBe(200)
        expect(response.data?.id).toBeString()
      }))))
    } finally {
      await runtime.dispose()
    }
  }, 15_000)
})
