import { TwitterApi } from "twitter-api-v2"
import { Context, Effect, Layer } from "effect"
import type { AppConfig } from "./config.js"
import { tweetIdFromString, type PostText, type TweetId } from "./domain/value-objects.js"
import { RuntimeConfig } from "./runtime-config.js"

function createTwitterClient(config: AppConfig) {
  return new TwitterApi({
    appKey: config.twitter!.appKey,
    appSecret: config.twitter!.appSecret,
    accessToken: config.twitter!.accessToken,
    accessSecret: config.twitter!.accessSecret,
  })
}

export class TwitterPublisher extends Context.Service<TwitterPublisher, {
  readonly postMessage: (post: PostText) => Effect.Effect<TweetId[], unknown>
}>()("app/TwitterPublisher") {
  static readonly layer = Layer.effect(
    this,
    Effect.gen(function* () {
      const config = yield* RuntimeConfig
      const client = config.dryRun || !config.twitter ? null : createTwitterClient(config)

      const postMessage = Effect.fn("TwitterPublisher.postMessage")(function* (post: PostText) {
        if (!client) {
          yield* Effect.sync(() => {
            console.log("DRY RUN: post preview")
            console.log(`\n${post}`)
          })
          return []
        }

        const response = yield* Effect.tryPromise(() => client.v2.tweet({ text: post }))
        return [tweetIdFromString(response.data.id)]
      })

      return TwitterPublisher.of({ postMessage })
    }),
  )
}
