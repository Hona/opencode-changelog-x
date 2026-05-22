import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { Context, Effect, Layer, Schema } from "effect"

const execFileAsync = promisify(execFile)

export class GitCliError extends Schema.TaggedErrorClass<GitCliError>()("GitCliError", {
  command: Schema.String,
  cause: Schema.Defect,
}) {}

type RunOptions = {
  readonly cwd?: string
  readonly timeout?: number
  readonly maxBuffer?: number
}

export type GitCliService = {
  readonly run: (args: string[], options?: RunOptions) => Effect.Effect<string, GitCliError>
  readonly fetch: (remote: string, branch: string) => Effect.Effect<void, GitCliError>
  readonly show: (ref: string) => Effect.Effect<string, GitCliError>
}

export class GitCli extends Context.Service<GitCli, GitCliService>()("app/GitCli") {
  static readonly layer = Layer.effect(
    this,
    Effect.gen(function* () {
      const run = Effect.fn("GitCli.run")(function* (args: string[], options: RunOptions = {}) {
        const command = `git ${args.join(" ")}`
        const { stdout } = yield* Effect.tryPromise({
          try: () => execFileAsync("git", args, {
            cwd: options.cwd,
            timeout: options.timeout ?? 30_000,
            maxBuffer: options.maxBuffer,
          }),
          catch: (cause) => new GitCliError({ command, cause }),
        })
        return stdout.trim()
      })

      const fetch = Effect.fn("GitCli.fetch")(function* (remote: string, branch: string) {
        yield* run(["fetch", "--quiet", remote, branch], { timeout: 60_000 })
      })

      const show = Effect.fn("GitCli.show")(function* (ref: string) {
        return yield* run(["show", ref], { maxBuffer: 10 * 1024 * 1024 })
      })

      return GitCli.of({ run, fetch, show })
    }),
  )
}
