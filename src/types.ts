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

export type ReleaseRange = {
  release: GithubRelease
  fromTag: string | null
  toTag: string
  compareUrl: string
  repoDir: string
}

export type GeneratedThread = {
  tweets: string[]
}

export type ReleaseThreadReport = {
  tag: string
  releaseUrl: string
  compareUrl: string
  fromTag: string | null
  toTag: string
  draft: boolean
  model: {
    providerID: "opencode"
    modelID: "gpt-5.4"
    variant: "high"
  }
  tweets: string[]
}

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
  postedAt: string
}

export type StateFile = {
  version: 1
  releases: PostedRelease[]
}
