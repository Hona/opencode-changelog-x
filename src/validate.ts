import twitterText from "twitter-text"

export type ThreadValidationError = {
  index: number
  message: string
}

export function getWeightedLength(text: string) {
  return twitterText.parseTweet(text).weightedLength
}

export function validateThread(tweets: string[], maxTweets: number): ThreadValidationError[] {
  const errors: ThreadValidationError[] = []

  if (tweets.length === 0) {
    errors.push({ index: -1, message: "Thread is empty" })
    return errors
  }

  if (tweets.length > maxTweets) {
    errors.push({ index: -1, message: `Thread has ${tweets.length} tweets but max is ${maxTweets}` })
  }

  for (const [index, tweet] of tweets.entries()) {
    const normalized = tweet.trim()
    if (!normalized) {
      errors.push({ index, message: "Tweet is empty" })
      continue
    }

    const result = twitterText.parseTweet(normalized)
    if (!result.valid) {
      errors.push({
        index,
        message: `Tweet is invalid for X weighted length rules (${result.weightedLength}/280)` ,
      })
    }
  }

  return errors
}
