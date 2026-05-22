declare const brand: unique symbol

type Brand<Name extends string, Value> = Value & { readonly [brand]: Name }

export type GitHubReleaseId = Brand<"GitHubReleaseId", number>
export type WorkflowRunId = Brand<"WorkflowRunId", number>
export type ReleaseTag = Brand<"ReleaseTag", string>
export type GitRef = Brand<"GitRef", string>
export type IsoDateString = Brand<"IsoDateString", string>
export type UrlString = Brand<"UrlString", string>
export type TweetId = Brand<"TweetId", string>
export type PostText = Brand<"PostText", string>

function nonEmptyString(value: unknown, name: string) {
  if (typeof value !== "string") throw new Error(`${name} must be a string`)
  const trimmed = value.trim()
  if (!trimmed) throw new Error(`${name} must not be empty`)
  return trimmed
}

function positiveInteger(value: unknown, name: string) {
  if (!Number.isInteger(value) || typeof value !== "number" || value <= 0) {
    throw new Error(`${name} must be a positive integer`)
  }
  return value
}

export function githubReleaseIdFromNumber(value: unknown): GitHubReleaseId {
  return positiveInteger(value, "GitHub release id") as GitHubReleaseId
}

export function workflowRunIdFromNumber(value: unknown): WorkflowRunId {
  return positiveInteger(value, "Workflow run id") as WorkflowRunId
}

export function releaseTagFromString(value: unknown): ReleaseTag {
  const tag = nonEmptyString(value, "Release tag")
  if (!/^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(tag)) {
    throw new Error(`Release tag must be a v-prefixed semver tag: ${tag}`)
  }
  return tag as ReleaseTag
}

export function gitRefFromString(value: unknown): GitRef {
  return nonEmptyString(value, "Git ref") as GitRef
}

export function isoDateStringFromString(value: unknown): IsoDateString {
  const text = nonEmptyString(value, "ISO date")
  if (Number.isNaN(Date.parse(text))) {
    throw new Error(`ISO date is invalid: ${text}`)
  }
  return text as IsoDateString
}

export function isoDateStringFromDate(value: Date): IsoDateString {
  return isoDateStringFromString(value.toISOString())
}

export function nullableIsoDateStringFromString(value: unknown): IsoDateString | null {
  return value === null ? null : isoDateStringFromString(value)
}

export function urlStringFromString(value: unknown): UrlString {
  const text = nonEmptyString(value, "URL")
  try {
    new URL(text)
  } catch {
    throw new Error(`URL is invalid: ${text}`)
  }
  return text as UrlString
}

export function tweetIdFromString(value: unknown): TweetId {
  return nonEmptyString(value, "Tweet id") as TweetId
}

export function postTextFromString(value: unknown): PostText {
  return nonEmptyString(value, "Post text") as PostText
}
