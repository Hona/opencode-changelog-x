import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname } from "node:path"
import { Context, Effect, Layer } from "effect"
import { z } from "zod"
import {
  githubReleaseIdFromNumber,
  isoDateStringFromString,
  nullableIsoDateStringFromString,
  postTextFromString,
  releaseTagFromString,
  tweetIdFromString,
  urlStringFromString,
} from "./domain/value-objects.js"
import { RuntimeConfig } from "./runtime-config.js"

export const postedReleaseSchema = z.object({
  releaseId: z.number().transform(githubReleaseIdFromNumber),
  tag: z.string().transform(releaseTagFromString),
  name: z.string().min(1),
  url: z.string().transform(urlStringFromString),
  draft: z.boolean(),
  prerelease: z.boolean(),
  publishedAt: z.string().nullable().transform(nullableIsoDateStringFromString),
  tweets: z.array(z.string().transform(postTextFromString)),
  tweetIds: z.array(z.string().transform(tweetIdFromString)),
  postedAt: z.string().transform(isoDateStringFromString),
}).strict().refine((release) => release.tweets.length > 0, "Posted release must contain at least one post")
  .refine((release) => release.tweetIds.length === release.tweets.length, "Posted release post/id counts must match")

export const stateFileSchema = z.object({
  version: z.literal(1),
  releases: z.array(postedReleaseSchema),
}).strict()
  .refine((state) => new Set(state.releases.map((release) => release.releaseId)).size === state.releases.length, "Posted release ids must be unique")
  .refine((state) => new Set(state.releases.map((release) => release.tag)).size === state.releases.length, "Posted release tags must be unique")

export type PostedRelease = z.infer<typeof postedReleaseSchema>
export type StateFile = z.infer<typeof stateFileSchema>

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
