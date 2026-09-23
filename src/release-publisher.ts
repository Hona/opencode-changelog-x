import { Context, Effect, Layer } from "effect"
import { POST_MAX_LENGTH } from "./constants.js"
import { PostedReleaseHistory, ReleaseCatalog } from "./domain/release-history.js"
import { isoDateStringFromDate } from "./domain/value-objects.js"
import { PostGenerator } from "./generate.js"
import { GithubReleases } from "./github.js"
import { RuntimeConfig } from "./runtime-config.js"
import { StateStore } from "./state.js"
import { TwitterPublisher } from "./twitter.js"
import { UpstreamRepository } from "./upstream.js"
import { getCharacterLength, validatePost } from "./validate.js"

const MAX_RELEASES_PER_RUN = 1

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
        const releases = yield* releasesApi.list({ known: state.releases })
        const catalog = new ReleaseCatalog(releases)
        let history = new PostedReleaseHistory(state)
        const allPending = history.pendingFrom(catalog, {
          targetTag: config.targetTag,
          allowPostedTarget: config.dryRun,
        })

        if (allPending.length === 0) {
          yield* Effect.sync(() => console.log("No unposted releases found."))
          return
        }

        // A tag burst (for example a new major line) would otherwise post every pending release
        // back to back in one run. Cap the run and let the VPS re-dispatch drain the rest.
        const resolvedPending = config.targetTag ? allPending : allPending.slice(0, MAX_RELEASES_PER_RUN)

        yield* Effect.sync(() => {
          if (config.targetTag) {
            console.log(`Selected ${config.targetTag} for ${config.dryRun ? "dry-run preview" : "publishing"}.`)
          } else {
            console.log(`Found ${allPending.length} unposted release(s); processing ${resolvedPending.map((release) => release.tag).join(", ")} this run.`)
          }
          const latestPostedRelease = history.latest()
          if (!config.targetTag && latestPostedRelease) {
            console.log(`Cron baseline: ${latestPostedRelease.tag}`)
          }
        })

        yield* upstream.withCheckout((checkout) => Effect.gen(function* () {
          yield* Effect.sync(() => console.log(`Using upstream repo at ${checkout.directory}`))

          yield* postGenerator.withGenerator(checkout.directory, undefined, (generator) => Effect.gen(function* () {
            for (const release of resolvedPending) {
              yield* Effect.sync(() => console.log(`\nProcessing ${release.tag}${release.draft ? " (draft)" : ""}...`))
              const range = yield* checkout.resolveRange(
                release,
                catalog.previousTagFor(release),
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
                const postedAt = yield* Effect.sync(() => isoDateStringFromDate(new Date()))
                history = history.recordPosted(release, report.post, tweetIds, postedAt)
                yield* stateStore.save(history.toState())
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
