import { Context, Effect, Layer } from "effect"
import { POST_MAX_LENGTH } from "./constants.js"
import { PostGenerator } from "./generate.js"
import { GithubReleases } from "./github.js"
import { RuntimeConfig } from "./runtime-config.js"
import {
  getLatestPostedRelease,
  hasPostedRelease,
  recordPostedRelease,
  StateStore,
} from "./state.js"
import { TwitterPublisher } from "./twitter.js"
import type { GithubRelease, StateFile } from "./types.js"
import { UpstreamRepository } from "./upstream.js"
import { getCharacterLength, validatePost } from "./validate.js"

function releaseTimestamp(release: { publishedAt: string | null; createdAt: string }) {
  return release.publishedAt ?? release.createdAt
}

function buildPreviousReleaseTagByTag(releases: GithubRelease[]) {
  const previousReleaseTagByTag = new Map<string, string | null>()

  for (const [index, release] of releases.entries()) {
    previousReleaseTagByTag.set(release.tag, index > 0 ? releases[index - 1]!.tag : null)
  }

  return previousReleaseTagByTag
}

function getPreviousReleaseTag(
  previousReleaseTagByTag: Map<string, string | null>,
  release: GithubRelease,
) {
  if (!previousReleaseTagByTag.has(release.tag)) {
    throw new Error(`No release-order baseline found for ${release.tag}`)
  }

  return previousReleaseTagByTag.get(release.tag) ?? null
}

function getTargetRelease(releases: GithubRelease[], targetTag: string) {
  const release = releases.find((release) => release.tag === targetTag)

  if (!release) {
    throw new Error(`${targetTag} was not found in the eligible GitHub releases list`)
  }

  return release
}

function resolvePendingReleases(state: StateFile, releases: GithubRelease[], targetTag: string | undefined) {
  const latestPostedRelease = getLatestPostedRelease(state)

  return targetTag
    ? [getTargetRelease(releases, targetTag)]
    : releases.filter((release) => {
        if (hasPostedRelease(state, release)) return false
        if (!latestPostedRelease) return true

        const latestTimestamp = latestPostedRelease.publishedAt ?? latestPostedRelease.postedAt
        const currentTimestamp = releaseTimestamp(release)

        if (currentTimestamp > latestTimestamp) return true
        if (currentTimestamp === latestTimestamp && release.id > latestPostedRelease.releaseId) return true

        return false
      })
}

export class ReleasePublisher extends Context.Service<ReleasePublisher, {
  readonly run: Effect.Effect<void, unknown>
}>()("app/ReleasePublisher") {
  static readonly layer = Layer.effect(
    this,
    Effect.gen(function* () {
      const config = yield* RuntimeConfig
      const stateStore = yield* StateStore
      const releasesApi = yield* GithubReleases
      const upstream = yield* UpstreamRepository
      const postGenerator = yield* PostGenerator
      const twitter = yield* TwitterPublisher

      const run = Effect.gen(function* () {
        const state = yield* stateStore.load()
        const latestPostedRelease = getLatestPostedRelease(state)
        const releases = yield* releasesApi.list()
        const previousReleaseTagByTag = buildPreviousReleaseTagByTag(releases)
        const resolvedPending = resolvePendingReleases(state, releases, config.targetTag)

        const targetedRelease = config.targetTag ? resolvedPending[0] : undefined
        if (targetedRelease && !config.dryRun && hasPostedRelease(state, targetedRelease)) {
          return yield* Effect.fail(new Error(`${targetedRelease.tag} was already processed. Use --dry-run to preview it again.`))
        }

        if (resolvedPending.length === 0) {
          yield* Effect.sync(() => console.log("No unposted releases found."))
          return
        }

        yield* Effect.sync(() => {
          console.log(`Found ${resolvedPending.length} unposted release(s).`)
          if (!config.targetTag && latestPostedRelease) {
            console.log(`Cron baseline: ${latestPostedRelease.tag}`)
          }
        })

        yield* upstream.withCheckout((checkout) => Effect.gen(function* () {
          yield* Effect.sync(() => console.log(`Using upstream repo at ${checkout.directory}`))

          yield* postGenerator.withGenerator(checkout.directory, undefined, (generator) => Effect.gen(function* () {
            let nextState = state

            for (const release of resolvedPending) {
              yield* Effect.sync(() => console.log(`\nProcessing ${release.tag}${release.draft ? " (draft)" : ""}...`))
              const range = yield* checkout.resolveRange(
                release,
                getPreviousReleaseTag(previousReleaseTagByTag, release),
              )
              yield* Effect.sync(() => console.log(`Tag range: ${range.fromTag ?? "<none>"} -> ${range.toLabel}`))

              const report = yield* generator.generateReport(range)
              yield* Effect.sync(() => console.log(JSON.stringify(report, null, 2)))

              const validationErrors = validatePost(report.post, POST_MAX_LENGTH)
              if (validationErrors.length > 0) {
                return yield* Effect.fail(new Error(`Generated post for ${release.tag} is invalid: ${validationErrors.join("; ")}`))
              }

              yield* Effect.sync(() => console.log(`post: ${getCharacterLength(report.post)}/${POST_MAX_LENGTH}`))

              const tweetIds = yield* twitter.postMessage(report.post)

              if (!config.dryRun) {
                nextState = recordPostedRelease(nextState, release, [report.post], tweetIds)
                yield* stateStore.save(nextState)
              }
            }
          }))
        }))
      })

      return ReleasePublisher.of({ run })
    }),
  )

  static readonly defaultLayer = this.layer.pipe(
    Layer.provide(StateStore.layer),
    Layer.provide(GithubReleases.defaultLayer),
    Layer.provide(UpstreamRepository.defaultLayer),
    Layer.provide(PostGenerator.layer),
    Layer.provide(TwitterPublisher.layer),
  )
}
