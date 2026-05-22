import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname } from "node:path"
import { Context, Effect, Layer } from "effect"
import { z } from "zod"
import { RuntimeConfig } from "./runtime-config.js"
import type { StateFile } from "./types.js"

const postedReleaseSchema = z.object({
  releaseId: z.number(),
  tag: z.string(),
  name: z.string(),
  url: z.string(),
  draft: z.boolean(),
  prerelease: z.boolean(),
  publishedAt: z.string().nullable(),
  tweets: z.array(z.string()),
  tweetIds: z.array(z.string()),
  postedAt: z.string(),
})

const stateFileSchema = z.object({
  version: z.literal(1),
  releases: z.array(postedReleaseSchema),
})

export function parseStateText(text: string): StateFile {
  return stateFileSchema.parse(JSON.parse(text))
}

export class StateStore extends Context.Service<StateStore, {
  readonly load: () => Effect.Effect<StateFile, unknown>
  readonly save: (state: StateFile) => Effect.Effect<void, unknown>
}>()("app/StateStore") {
  static readonly layer = Layer.effect(
    this,
    Effect.gen(function* () {
      const config = yield* RuntimeConfig

      const load = Effect.fn("StateStore.load")(function* () {
        return yield* Effect.tryPromise({
          try: async () => parseStateText(await readFile(config.stateFile, "utf8")),
          catch: (error) => error,
        })
      })

      const save = Effect.fn("StateStore.save")(function* (state: StateFile) {
        yield* Effect.tryPromise({
          try: async () => {
            await mkdir(dirname(config.stateFile), { recursive: true })
            await writeFile(config.stateFile, `${JSON.stringify(state, null, 2)}\n`, "utf8")
          },
          catch: (error) => error,
        })
      })

      return StateStore.of({ load, save })
    }),
  )
}
