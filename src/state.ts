import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname } from "node:path"
import { Context, Effect, Layer } from "effect"
import { z } from "zod"
import { RuntimeConfig } from "./runtime-config.js"
import type { GithubRelease, PostedRelease, StateFile } from "./types.js"

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

export function getSavedRelease(state: StateFile, release: GithubRelease) {
  return state.releases.find((entry) => entry.releaseId === release.id || entry.tag === release.tag)
}

export function isCompletePostedRelease(release: Pick<PostedRelease, "tweets" | "tweetIds">) {
  return release.tweets.length > 0 && release.tweetIds.length === release.tweets.length
}

export function hasPostedRelease(state: StateFile, release: GithubRelease) {
  const saved = getSavedRelease(state, release)
  return saved ? isCompletePostedRelease(saved) : false
}

function postedReleaseTimestamp(release: PostedRelease) {
  return release.publishedAt ?? release.postedAt
}

export function getLatestPostedRelease(state: StateFile) {
  return state.releases.filter(isCompletePostedRelease).reduce<PostedRelease | undefined>((latest, release) => {
    if (!latest) return release

    const latestTimestamp = postedReleaseTimestamp(latest)
    const releaseTimestamp = postedReleaseTimestamp(release)

    if (releaseTimestamp > latestTimestamp) return release
    if (releaseTimestamp === latestTimestamp && release.releaseId > latest.releaseId) return release

    return latest
  }, undefined)
}

function recordRelease(state: StateFile, release: GithubRelease, tweets: string[], tweetIds: string[]): StateFile {
  const nextRelease: PostedRelease = {
    releaseId: release.id,
    tag: release.tag,
    name: release.name,
    url: release.url,
    draft: release.draft,
    prerelease: release.prerelease,
    publishedAt: release.publishedAt,
    tweets,
    tweetIds,
    postedAt: new Date().toISOString(),
  }

  const releases = state.releases
    .filter((entry) => entry.releaseId !== release.id && entry.tag !== release.tag)
    .concat(nextRelease)
    .sort((left, right) => left.postedAt.localeCompare(right.postedAt))

  return {
    version: 1,
    releases,
  }
}

export function recordPostedRelease(
  state: StateFile,
  release: GithubRelease,
  tweets: string[],
  tweetIds: string[],
): StateFile {
  return recordRelease(state, release, tweets, tweetIds)
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
