import { TwitterApi } from "twitter-api-v2"
import type { AppConfig } from "./config.js"

export async function postThread(tweets: string[], config: AppConfig) {
  if (config.dryRun || !config.twitter) {
    console.log("DRY RUN: thread preview")
    for (const [index, tweet] of tweets.entries()) {
      console.log(`\n[${index + 1}/${tweets.length}]\n${tweet}`)
    }
    return []
  }

  const client = new TwitterApi({
    appKey: config.twitter.appKey,
    appSecret: config.twitter.appSecret,
    accessToken: config.twitter.accessToken,
    accessSecret: config.twitter.accessSecret,
  })

  const tweetIds: string[] = []
  let replyTo: string | undefined

  for (const tweet of tweets) {
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
  }

  return tweetIds
}
