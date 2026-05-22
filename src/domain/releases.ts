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

export type GithubRelease = {
  id: GitHubReleaseId
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
    tag,
    name,
    url: urlStringFromString(input.url),
    draft: input.draft,
    prerelease: input.prerelease,
    createdAt: isoDateStringFromString(input.createdAt),
    publishedAt: nullableIsoDateStringFromString(input.publishedAt),
  }
}

export function compareReleaseOrder(left: GithubRelease, right: GithubRelease) {
  const timestampComparison = releaseTimestamp(left).localeCompare(releaseTimestamp(right))
  if (timestampComparison !== 0) return timestampComparison
  return left.id - right.id
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
