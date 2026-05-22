import twitterText from "twitter-text"

export function getWeightedLength(text: string) {
  return twitterText.parseTweet(text).weightedLength
}

export function getCharacterLength(text: string) {
  return text.replace(/\r/g, "").trim().length
}

export function validatePost(post: string, maxLength: number) {
  const errors: string[] = []
  const normalized = post.replace(/\r/g, "").trim()

  if (!normalized) {
    errors.push("Post is empty")
    return errors
  }

  const length = getCharacterLength(normalized)
  if (length > maxLength) {
    errors.push(`Post is too long for X Premium long-post limits (${length}/${maxLength})`)
  }

  return errors
}
