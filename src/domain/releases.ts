import { compareVersionStrings, semverFromString } from "./semver.js"
import {
  gitRefFromString,
  githubReleaseIdFromNumber,
  isoDateStringFromString,
  nullableIsoDateStringFromString,
  releaseTagFromString,
  urlStringFromString,
  type GitHubReleaseId,
  type GitRef,
  type IsoDateString,
  type ReleaseTag,
  type UrlString,
} from "./value-objects.js"

export type ReleaseSource = "github-release" | "git-tag"

export type GithubRelease = {
  id: GitHubReleaseId | null
  source: ReleaseSource
  commitSha: string | null
  tag: ReleaseTag
  name: string
  url: UrlString
  draft: boolean
  prerelease: boolean
  createdAt: IsoDateString
  publishedAt: IsoDateString | null
}

export type ChangelogKind = "release" | "preview"

export type ReleaseRange = {
  kind: ChangelogKind
  release: GithubRelease | null
  fromTag: ReleaseTag | null
  fromReleaseTimestamp?: IsoDateString | null
  toTag: GitRef
  toLabel: string
  compareUrl: UrlString
  repoDir: string
  commitCount?: number
}

export function releaseTimestamp(release: { publishedAt: IsoDateString | null; createdAt: IsoDateString }): IsoDateString {
  return release.publishedAt ?? release.createdAt
}

export function createGithubRelease(input: {
  id: unknown
  commitSha?: string | null
  tag: unknown
  name: unknown
  url: unknown
  draft: boolean
  prerelease: boolean
  createdAt: unknown
  publishedAt: unknown
}): GithubRelease {
  const tag = releaseTagFromString(input.tag)
  const name = typeof input.name === "string" && input.name.trim() ? input.name.trim() : tag

  return {
    id: githubReleaseIdFromNumber(input.id),
    source: "github-release",
    commitSha: input.commitSha ?? null,
    tag,
    name,
    url: urlStringFromString(input.url),
    draft: input.draft,
    prerelease: input.prerelease,
    createdAt: isoDateStringFromString(input.createdAt),
    publishedAt: nullableIsoDateStringFromString(input.publishedAt),
  }
}

export function createTagRelease(input: {
  owner: string
  repo: string
  tag: unknown
  commitSha: string
  taggedAt: unknown
}): GithubRelease {
  const tag = releaseTagFromString(input.tag)
  const taggedAt = isoDateStringFromString(input.taggedAt)

  return {
    id: null,
    source: "git-tag",
    commitSha: input.commitSha,
    tag,
    name: tag,
    url: urlStringFromString(`https://github.com/${input.owner}/${input.repo}/releases/tag/${tag}`),
    draft: false,
    prerelease: semverFromString(tag).prerelease.length > 0,
    createdAt: taggedAt,
    publishedAt: taggedAt,
  }
}

export function releaseMajor(release: { tag: ReleaseTag }) {
  return semverFromString(release.tag).major
}

export function compareReleaseOrder(left: { tag: ReleaseTag }, right: { tag: ReleaseTag }) {
  const versionComparison = compareVersionStrings(left.tag, right.tag)
  if (versionComparison !== 0) return versionComparison
  return left.tag.localeCompare(right.tag)
}

export function createCompareUrl(input: {
  owner: string
  repo: string
  fromTag: ReleaseTag | null
  toTag: GitRef
}): UrlString {
  if (input.fromTag) {
    return urlStringFromString(`https://github.com/${input.owner}/${input.repo}/compare/${input.fromTag}...${input.toTag}`)
  }

  return urlStringFromString(`https://github.com/${input.owner}/${input.repo}/tree/${input.toTag}`)
}

export function createReleaseRange(input: {
  release: GithubRelease
  fromTag: ReleaseTag | null
  compareUrl: UrlString
  repoDir: string
  commitCount: number
}): ReleaseRange {
  return {
    kind: "release",
    release: input.release,
    fromTag: input.fromTag,
    toTag: gitRefFromString(input.release.tag),
    toLabel: input.release.tag,
    compareUrl: input.compareUrl,
    repoDir: input.repoDir,
    commitCount: input.commitCount,
  }
}

export function createPreviewRange(input: {
  fromTag: ReleaseTag | null
  fromReleaseTimestamp?: IsoDateString | null
  toTag: GitRef
  shortSha: string
  compareUrl: UrlString
  repoDir: string
  commitCount: number
}): ReleaseRange {
  return {
    kind: "preview",
    release: null,
    fromTag: input.fromTag,
    fromReleaseTimestamp: input.fromReleaseTimestamp,
    toTag: input.toTag,
    toLabel: `HEAD (${input.shortSha})`,
    compareUrl: input.compareUrl,
    repoDir: input.repoDir,
    commitCount: input.commitCount,
  }
}
