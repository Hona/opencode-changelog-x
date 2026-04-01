import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname } from "node:path"
import { z } from "zod"
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

export function hasPostedRelease(state: StateFile, release: GithubRelease) {
  return state.releases.some((entry) => entry.releaseId === release.id || entry.tag === release.tag)
}

export function recordPostedRelease(
  state: StateFile,
  release: GithubRelease,
  tweets: string[],
  tweetIds: string[],
): StateFile {
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

export async function saveState(filePath: string, state: StateFile) {
  await mkdir(dirname(filePath), { recursive: true })
  await writeFile(filePath, `${JSON.stringify(state, null, 2)}\n`, "utf8")
}
