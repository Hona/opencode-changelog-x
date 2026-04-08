import { setTimeout as sleep } from "node:timers/promises"
import { TwitterApi } from "twitter-api-v2"
import type { AppConfig } from "./config.js"

const THREAD_POST_DELAY_MS = 10_000

type PostThreadOptions = {
  existingTweetIds?: string[]
  onProgress?: (tweetIds: string[]) => Promise<void> | void
}

type PostMessageOptions = {
  existingTweetIds?: string[]
  onProgress?: (tweetIds: string[]) => Promise<void> | void
}

function createTwitterClient(config: AppConfig) {
  return new TwitterApi({
    appKey: config.twitter!.appKey,
    appSecret: config.twitter!.appSecret,
    accessToken: config.twitter!.accessToken,
    accessSecret: config.twitter!.accessSecret,
  })
}

export async function postMessage(post: string, config: AppConfig, options: PostMessageOptions = {}) {
  if (config.dryRun || !config.twitter) {
    console.log("DRY RUN: post preview")
    console.log(`\n${post}`)
    return []
  }

  const tweetIds = [...(options.existingTweetIds ?? [])]
  if (tweetIds.length > 0) {
    return tweetIds.slice(0, 1)
  }

  const client = createTwitterClient(config)
  const response = await client.v2.tweet({
    text: post,
  })
  const nextTweetIds = [response.data.id]

  await options.onProgress?.(nextTweetIds)
  return nextTweetIds
}

export async function postThread(tweets: string[], config: AppConfig, options: PostThreadOptions = {}) {
  if (config.dryRun || !config.twitter) {
    console.log("DRY RUN: thread preview")
    for (const [index, tweet] of tweets.entries()) {
      console.log(`\n[${index + 1}/${tweets.length}]\n${tweet}`)
    }
    return []
  }

  const client = createTwitterClient(config)

  const tweetIds = [...(options.existingTweetIds ?? [])]
  let replyTo = tweetIds.at(-1)

  if (tweetIds.length >= tweets.length) {
    return tweetIds
  }

  let isFirstNewTweet = true

  for (const tweet of tweets.slice(tweetIds.length)) {
    if (!isFirstNewTweet) {
      console.log(`Waiting ${THREAD_POST_DELAY_MS / 1000}s before next post...`)
      await sleep(THREAD_POST_DELAY_MS)
    }

    const response = await client.v2.tweet(
      replyTo
        ? {
            text: tweet,
            reply: {
              in_reply_to_tweet_id: replyTo,
            },
          }
        : {
            text: tweet,
          },
    )

    tweetIds.push(response.data.id)
    replyTo = response.data.id
    isFirstNewTweet = false
    await options.onProgress?.(tweetIds)
  }

  return tweetIds
}
