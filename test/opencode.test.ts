import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { execFile } from "node:child_process"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { delimiter, join } from "node:path"
import { tmpdir } from "node:os"
import { promisify } from "node:util"
import { Effect, Layer, ManagedRuntime } from "effect"
import type { AppConfig } from "../src/config.js"
import { READ_ONLY_PERMISSIONS } from "../src/generate.js"
import { OPENCODE_SERVER_ARGS, OpencodeServer, serverAuthHeaders } from "../src/opencode.js"
import { RuntimeConfig } from "../src/runtime-config.js"

const directories: string[] = []
const execFileAsync = promisify(execFile)
const SERVER_TEST_TIMEOUT_MS = 60_000
let previousPath: string | undefined
let previousEnv: Record<string, string | undefined>

const ENV_KEYS = ["XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_CONFIG_HOME", "XDG_STATE_HOME", "OPENCODE_SERVER_PASSWORD"]

beforeEach(async () => {
  previousPath = process.env.PATH
  process.env.PATH = `${join(process.cwd(), "node_modules", ".bin")}${delimiter}${previousPath ?? ""}`
  const root = await mkdtemp(join(tmpdir(), "opencode-home-test-"))
  directories.push(root)
  previousEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]))
  process.env.XDG_DATA_HOME = join(root, "data")
  process.env.XDG_CACHE_HOME = join(root, "cache")
  process.env.XDG_CONFIG_HOME = join(root, "config")
  process.env.XDG_STATE_HOME = join(root, "state")
})

afterEach(async () => {
  process.env.PATH = previousPath
  for (const [key, value] of Object.entries(previousEnv)) {
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

async function createRepo() {
  const directory = await mkdtemp(join(tmpdir(), "opencode-server-test-"))
  directories.push(directory)
  await execFileAsync("git", ["init"], { cwd: directory })
  return directory
}

const createSessionInRepo = (directory: string) =>
  OpencodeServer.use((server) => server.withServer(directory, (running) => Effect.gen(function* () {
    const session = yield* Effect.tryPromise(() => running.client.session.create({
      location: { directory: running.directory },
      permissions: READ_ONLY_PERMISSIONS,
    }))
    expect(session.id).toStartWith("ses")
    expect(session.location.directory.toLowerCase()).toBe(directory.toLowerCase())
    return session
  })))

describe("OpencodeServer", () => {
  test("prints only server errors to captured output", () => {
    expect(OPENCODE_SERVER_ARGS).toContain("--print-logs")
    expect(OPENCODE_SERVER_ARGS.slice(OPENCODE_SERVER_ARGS.indexOf("--log-level"), OPENCODE_SERVER_ARGS.indexOf("--log-level") + 2)).toEqual(["--log-level", "error"])
    expect(OPENCODE_SERVER_ARGS).not.toContain("--port")
  })

  test("authenticates as the fixed opencode user", () => {
    expect(serverAuthHeaders("secret")).toEqual({
      Authorization: `Basic ${Buffer.from("opencode:secret").toString("base64")}`,
    })
  })

  test.serial("authenticates its client when the caller sets a server password", async () => {
    const directory = await createRepo()
    process.env.OPENCODE_SERVER_PASSWORD = "server-password"
    const runtime = makeRuntime(directory)

    try {
      await runtime.runPromise(createSessionInRepo(directory))
    } finally {
      await runtime.dispose()
    }
  }, SERVER_TEST_TIMEOUT_MS)

  test.serial("mints a server password when the caller has none", async () => {
    const directory = await createRepo()
    delete process.env.OPENCODE_SERVER_PASSWORD
    const runtime = makeRuntime(directory)

    try {
      await runtime.runPromise(createSessionInRepo(directory))
    } finally {
      await runtime.dispose()
    }
  }, SERVER_TEST_TIMEOUT_MS)

  test.serial("accepts the current upstream reference configuration", async () => {
    const directory = await createRepo()
    await mkdir(join(directory, ".opencode"), { recursive: true })
    // Mirrors anomalyco/opencode .opencode/opencode.jsonc as of v2.0.3.
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
      await runtime.runPromise(createSessionInRepo(directory))
    } finally {
      await runtime.dispose()
    }
  }, SERVER_TEST_TIMEOUT_MS)
})
