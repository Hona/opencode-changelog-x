export type GithubRelease = {
  id: number
  tag: string
  name: string
  body: string
  url: string
  draft: boolean
  prerelease: boolean
  createdAt: string
  publishedAt: string | null
}

export type ChangelogKind = "release" | "preview"

export type ReleaseRange = {
  kind: ChangelogKind
  release: GithubRelease | null
  fromTag: string | null
  fromReleaseTimestamp?: string | null
  toTag: string
  toLabel: string
  compareUrl: string
  repoDir: string
  commitCount?: number
}

export type GeneratedPost = {
  post: string
}

export type ReleasePostReport = {
  kind: ChangelogKind
  tag: string
  releaseUrl: string | null
  compareUrl: string
  fromTag: string | null
  toTag: string
  toLabel: string
  draft: boolean
  model: {
    providerID: string
    modelID: string
    variant: string
  }
  post: string
}

export type PostedReleaseStatus = "posted" | "errored"

export type PostedRelease = {
  releaseId: number
  tag: string
  name: string
  url: string
  draft: boolean
  prerelease: boolean
  publishedAt: string | null
  tweets: string[]
  tweetIds: string[]
  status?: PostedReleaseStatus
  error?: string
  postedAt: string
}

export type ReleasePostProgress = {
  release: GithubRelease
  tweets: string[]
  tweetIds: string[]
  status?: PostedReleaseStatus
  error?: string
}

export type StateFile = {
  version: 1
  releases: PostedRelease[]
}
