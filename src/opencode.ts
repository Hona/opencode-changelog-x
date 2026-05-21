import { spawn } from "node:child_process"
import { createOpencodeClient } from "@opencode-ai/sdk/v2"

type RunningOpencode = {
  client: ReturnType<typeof createOpencodeClient>
  getOutput: () => string
  close: () => Promise<void>
}

const OPENCODE_OUTPUT_TAIL_LIMIT = 50_000

function shouldEchoOutput() {
  return ["1", "true", "yes", "on"].includes(process.env.OPENCODE_ECHO_OUTPUT?.trim().toLowerCase() ?? "")
}

export async function startOpencode(repoDir: string): Promise<RunningOpencode> {
  const proc = spawn("opencode", ["serve", "--hostname=127.0.0.1", "--port=0"], {
    env: {
      ...process.env,
      OPENCODE_CONFIG_CONTENT: JSON.stringify({}),
    },
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
  })

  let output = ""
  const echoOutput = shouldEchoOutput()

  function appendOutput(chunk: Buffer, stream: NodeJS.WriteStream) {
    const text = chunk.toString()
    output += text
    if (output.length > OPENCODE_OUTPUT_TAIL_LIMIT) {
      output = output.slice(-OPENCODE_OUTPUT_TAIL_LIMIT)
    }
    if (echoOutput) {
      stream.write(text)
    }
    return text
  }

  const exitPromise = new Promise<void>((resolve) => {
    proc.once("close", () => resolve())
  })

  async function killOpencodeTree() {
    if (!proc.pid) {
      return
    }

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

  const url = await new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(() => {
      void killOpencodeTree()
      reject(new Error(`Timeout waiting for opencode server startup\n${output}`))
    }, 10_000)

    const onStdout = (chunk: Buffer) => {
      appendOutput(chunk, process.stdout)
      const lines = output.split("\n")
      for (const line of lines) {
        if (!line.startsWith("opencode server listening")) continue
        const match = line.match(/on\s+(https?:\/\/[^\s]+)/)
        if (!match) {
          clearTimeout(timeout)
          void killOpencodeTree()
          reject(new Error(`Failed to parse opencode server URL\n${output}`))
          return
        }
        clearTimeout(timeout)
        resolve(match[1]!)
        return
      }
    }

    const onStderr = (chunk: Buffer) => {
      appendOutput(chunk, process.stderr)
    }

    proc.stdout?.on("data", onStdout)
    proc.stderr?.on("data", onStderr)
    proc.once("error", (error) => {
      clearTimeout(timeout)
      void killOpencodeTree()
      reject(error)
    })
    proc.once("close", (code) => {
      clearTimeout(timeout)
      void killOpencodeTree()
      reject(new Error(`Opencode server exited early with code ${code}\n${output}`))
    })
  })

  const client = createOpencodeClient({
    baseUrl: url,
    directory: repoDir,
  })

  return {
    client,
    getOutput() {
      return output.trim()
    },
    async close() {
      proc.stdout?.destroy()
      proc.stderr?.destroy()

      if (proc.exitCode === null && !proc.killed) {
        await killOpencodeTree()
      }

      const forceKillTimer = setTimeout(() => {
        if (proc.exitCode === null && !proc.killed) {
          void killOpencodeTree()
        }
      }, 5_000)

      await exitPromise
      clearTimeout(forceKillTimer)
    },
  }
}
