import { spawn } from "node:child_process"
import { randomBytes } from "node:crypto"
import { mkdtemp, rm } from "node:fs/promises"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { OpenCode, type OpenCodeClient } from "@opencode/client"
import { Context, Effect, Layer } from "effect"
import { RuntimeConfig } from "./runtime-config.js"

export type EffectRunningOpencode = {
  client: OpenCodeClient
  directory: string
  getOutput: () => Promise<string>
  close: Effect.Effect<void, unknown>
}

const OPENCODE_OUTPUT_TAIL_LIMIT = 50_000
const OPENCODE_STARTUP_TIMEOUT_MS = 30_000
const OPENCODE_HEALTH_POLL_MS = 250
export const OPENCODE_SERVER_ARGS = [
  "serve",
  "--hostname",
  "127.0.0.1",
  "--print-logs",
  "--log-level",
  "error",
]

// The v2 server always authenticates with HTTP Basic auth as user "opencode". Reuse the caller's
// password when set so the environment stays consistent, otherwise mint one for this child only.
function serverPassword(env: NodeJS.ProcessEnv) {
  return env.OPENCODE_SERVER_PASSWORD || randomBytes(24).toString("base64url")
}

export function serverAuthHeaders(password: string) {
  return {
    Authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`,
  }
}

function findFreePort() {
  return new Promise<number>((resolve, reject) => {
    const server = createServer()
    server.unref()
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      server.close(() => {
        if (address && typeof address === "object") resolve(address.port)
        else reject(new Error("Failed to reserve a local port for the opencode server"))
      })
    })
  })
}

async function killProcessTree(proc: ReturnType<typeof spawn>) {
    if (!proc.pid) return

    if (process.platform === "win32") {
      await new Promise<void>((resolve) => {
        const killer = spawn("taskkill", ["/pid", String(proc.pid), "/t", "/f"], {
          stdio: "ignore",
        })
        killer.once("error", () => resolve())
        killer.once("close", () => resolve())
      })
      return
    }

    try {
      process.kill(-proc.pid, "SIGKILL")
    } catch {
      if (proc.exitCode === null && !proc.killed) {
        proc.kill("SIGKILL")
      }
    }
}

function startOpencodeEffect(repoDir: string, echoOutput: boolean) {
  return Effect.tryPromise(async (signal) => {
    const port = await findFreePort()
    const password = serverPassword(process.env)
    // Only the global config is isolated: the user's plugins and MCP servers are noise for a
    // read-only analysis agent. The data directory (credentials, database) stays shared.
    const configDir = await mkdtemp(join(tmpdir(), "opencode-changelog-config-"))
    const proc = spawn("opencode", [...OPENCODE_SERVER_ARGS, "--port", String(port)], {
      env: {
        ...process.env,
        OPENCODE_SERVER_PASSWORD: password,
        OPENCODE_CONFIG_DIR: configDir,
        OPENCODE_CONFIG_CONTENT: JSON.stringify({}),
        OPENCODE_DISABLE_AUTOUPDATE: "1",
      },
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    })

    let output = ""
    let exited = false

    function appendOutput(chunk: Buffer, stream: NodeJS.WriteStream) {
      const text = chunk.toString()
      output += text
      if (output.length > OPENCODE_OUTPUT_TAIL_LIMIT) {
        output = output.slice(-OPENCODE_OUTPUT_TAIL_LIMIT)
      }
      if (echoOutput) {
        stream.write(text)
      }
    }

    proc.stdout?.on("data", (chunk: Buffer) => appendOutput(chunk, process.stdout))
    proc.stderr?.on("data", (chunk: Buffer) => appendOutput(chunk, process.stderr))

    const exitPromise = new Promise<number | null>((resolve) => {
      proc.once("close", (code) => {
        exited = true
        resolve(code)
      })
    })

    async function closeProcess() {
      proc.stdout?.destroy()
      proc.stderr?.destroy()

      if (proc.exitCode === null && !proc.killed) {
        await killProcessTree(proc)
      }

      const forceKillTimer = setTimeout(() => {
        if (proc.exitCode === null && !proc.killed) {
          void killProcessTree(proc)
        }
      }, 5_000)

      await exitPromise
      clearTimeout(forceKillTimer)
      await rm(configDir, { recursive: true, force: true }).catch(() => undefined)
    }

    signal.addEventListener("abort", () => {
      void closeProcess()
    }, { once: true })

    const url = `http://127.0.0.1:${port}`
    const client = OpenCode.make({
      baseUrl: url,
      headers: serverAuthHeaders(password),
    })

    const spawnError = new Promise<never>((_, reject) => {
      proc.once("error", reject)
    })

    try {
      await Promise.race([
        spawnError,
        (async () => {
          const deadline = Date.now() + OPENCODE_STARTUP_TIMEOUT_MS
          while (true) {
            if (exited) {
              throw new Error(`Opencode server exited early with code ${proc.exitCode}\n${output}`)
            }
            if (Date.now() > deadline) {
              throw new Error(`Timeout waiting for opencode server startup on ${url}\n${output}`)
            }
            const healthy = await client.health.get({ signal: AbortSignal.timeout(OPENCODE_STARTUP_TIMEOUT_MS) })
              .then((health) => health.healthy)
              .catch(() => false)
            if (healthy) return
            await delay(OPENCODE_HEALTH_POLL_MS)
          }
        })(),
      ])
    } catch (error) {
      await closeProcess()
      throw error
    }

    return {
      client,
      directory: repoDir,
      async getOutput() {
        await delay(100)
        return output.trim()
      },
      close: Effect.tryPromise(closeProcess),
    } satisfies EffectRunningOpencode
  })
}

export class OpencodeServer extends Context.Service<OpencodeServer, {
  readonly withServer: <A, E, R>(repoDir: string, use: (server: EffectRunningOpencode) => Effect.Effect<A, E, R>) => Effect.Effect<A, E | unknown, R>
}>()("app/OpencodeServer") {
  static readonly layer = Layer.effect(
    this,
    Effect.gen(function* () {
      const config = yield* RuntimeConfig

      const withServer = <A, E, R>(repoDir: string, use: (server: EffectRunningOpencode) => Effect.Effect<A, E, R>) =>
        Effect.acquireRelease(
          startOpencodeEffect(repoDir, config.opencodeEchoOutput),
          (server) => server.close.pipe(Effect.catch(Effect.die)),
        ).pipe(
          Effect.flatMap(use),
          Effect.scoped,
        )

      return OpencodeServer.of({ withServer })
    }),
  )
}
