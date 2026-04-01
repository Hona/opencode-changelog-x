import { z } from "zod"
import type { AppConfig } from "./config.js"
import type { GithubRelease } from "./types.js"

const releaseSchema = z.object({
  id: z.number(),
  tag_name: z.string(),
  name: z.string().nullable().optional(),
  body: z.string().nullable().optional(),
  html_url: z.string().url(),
  draft: z.boolean(),
  prerelease: z.boolean(),
  created_at: z.string(),
  published_at: z.string().nullable(),
})

const releasesSchema = z.array(releaseSchema)

function mapRelease(release: z.infer<typeof releaseSchema>): GithubRelease {
  return {
    id: release.id,
    tag: release.tag_name,
    name: release.name?.trim() || release.tag_name,
    body: release.body ?? "",
    url: release.html_url,
    draft: release.draft,
    prerelease: release.prerelease,
    createdAt: release.created_at,
    publishedAt: release.published_at,
  }
}

function releaseTimestamp(release: GithubRelease) {
  return release.publishedAt ?? release.createdAt
}

export async function listReleases(config: AppConfig): Promise<GithubRelease[]> {
  const url = new URL(`https://api.github.com/repos/${config.githubOwner}/${config.githubRepo}/releases`)
  url.searchParams.set("per_page", String(config.githubReleaseLimit))

  const response = await fetch(url, {
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "opencode-changelog-x",
      ...(config.githubToken ? { Authorization: `Bearer ${config.githubToken}` } : {}),
    },
  })

  if (!response.ok) {
    throw new Error(`GitHub releases request failed (${response.status} ${response.statusText})`)
  }

  const payload = releasesSchema.parse(await response.json())

  return payload
    .map(mapRelease)
    .filter((release) => config.githubProcessDrafts || !release.draft)
    .sort((left, right) => releaseTimestamp(left).localeCompare(releaseTimestamp(right)))
}

export async function getReleaseByTag(config: AppConfig, tag: string): Promise<GithubRelease> {
  const url = `https://api.github.com/repos/${config.githubOwner}/${config.githubRepo}/releases/tags/${tag}`

  const response = await fetch(url, {
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "opencode-changelog-x",
      ...(config.githubToken ? { Authorization: `Bearer ${config.githubToken}` } : {}),
    },
  })

  if (!response.ok) {
    throw new Error(`GitHub tag release request failed (${response.status} ${response.statusText})`)
  }

  const payload = releaseSchema.parse(await response.json())
  const release = mapRelease(payload)

  if (release.draft && !config.githubProcessDrafts) {
    throw new Error(`${tag} is a draft release. Set GITHUB_PROCESS_DRAFTS=true to allow it.`)
  }

  return release
}
