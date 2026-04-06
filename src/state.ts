import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname } from "node:path"
import { z } from "zod"
import type { GithubRelease, PostedRelease, PostedReleaseStatus, ReleasePostProgress, StateFile } from "./types.js"

const postedReleaseStatusSchema = z.enum(["posted", "errored"] satisfies PostedReleaseStatus[])

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
  status: postedReleaseStatusSchema.optional(),
  error: z.string().optional(),
  postedAt: z.string(),
})

const stateFileSchema = z.object({
  version: z.literal(1),
  releases: z.array(postedReleaseSchema),
})

function createEmptyState(): StateFile {
  return {
    version: 1,
    releases: [],
  }
}

export async function loadState(filePath: string): Promise<StateFile> {
  try {
    const text = await readFile(filePath, "utf8")
    return stateFileSchema.parse(JSON.parse(text))
  } catch (error) {
    if (typeof error === "object" && error && "code" in error && error.code === "ENOENT") {
      return createEmptyState()
    }
    throw error
  }
}

export function getSavedRelease(state: StateFile, release: GithubRelease) {
  return state.releases.find((entry) => entry.releaseId === release.id || entry.tag === release.tag)
}

export function isCompletePostedRelease(release: Pick<PostedRelease, "tweets" | "tweetIds">) {
  return release.tweets.length > 0 && release.tweetIds.length === release.tweets.length
}

export function isFinishedPostedRelease(release: Pick<PostedRelease, "status" | "tweets" | "tweetIds">) {
  return release.status === "posted" || release.status === "errored" || isCompletePostedRelease(release)
}

export function hasPostedRelease(state: StateFile, release: GithubRelease) {
  const saved = getSavedRelease(state, release)
  return saved ? isFinishedPostedRelease(saved) : false
}

function postedReleaseTimestamp(release: PostedRelease) {
  return release.publishedAt ?? release.postedAt
}

export function getLatestPostedRelease(state: StateFile) {
  return state.releases.filter(isFinishedPostedRelease).reduce<PostedRelease | undefined>((latest, release) => {
    if (!latest) return release

    const latestTimestamp = postedReleaseTimestamp(latest)
    const releaseTimestamp = postedReleaseTimestamp(release)

    if (releaseTimestamp > latestTimestamp) return release
    if (releaseTimestamp === latestTimestamp && release.releaseId > latest.releaseId) return release

    return latest
  }, undefined)
}

export function recordPostingProgress(state: StateFile, progress: ReleasePostProgress): StateFile {
  const nextRelease: PostedRelease = {
    releaseId: progress.release.id,
    tag: progress.release.tag,
    name: progress.release.name,
    url: progress.release.url,
    draft: progress.release.draft,
    prerelease: progress.release.prerelease,
    publishedAt: progress.release.publishedAt,
    tweets: progress.tweets,
    tweetIds: progress.tweetIds,
    status: progress.status,
    error: progress.error,
    postedAt: new Date().toISOString(),
  }

  const releases = state.releases
    .filter((entry) => entry.releaseId !== progress.release.id && entry.tag !== progress.release.tag)
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
  return recordPostingProgress(state, {
    release,
    tweets,
    tweetIds,
    status: "posted",
  })
}

export function recordErroredRelease(
  state: StateFile,
  release: GithubRelease,
  tweets: string[],
  tweetIds: string[],
  error: string,
): StateFile {
  return recordPostingProgress(state, {
    release,
    tweets,
    tweetIds,
    status: "errored",
    error,
  })
}

export async function saveState(filePath: string, state: StateFile) {
  await mkdir(dirname(filePath), { recursive: true })
  await writeFile(filePath, `${JSON.stringify(state, null, 2)}\n`, "utf8")
}
