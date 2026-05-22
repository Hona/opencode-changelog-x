import type { PostedRelease, StateFile } from "../state.js"
import { releaseTimestamp, type GithubRelease } from "./releases.js"
import type { IsoDateString, PostText, ReleaseTag, TweetId } from "./value-objects.js"

function postedReleaseTimestamp(release: PostedRelease) {
  return release.publishedAt ?? release.postedAt
}

export class ReleaseCatalog {
  private readonly previousReleaseTagByTag = new Map<GithubRelease["tag"], GithubRelease["tag"] | null>()

  constructor(readonly releases: readonly GithubRelease[]) {
    for (const [index, release] of releases.entries()) {
      this.previousReleaseTagByTag.set(release.tag, index > 0 ? releases[index - 1]!.tag : null)
    }
  }

  requireTag(tag: string) {
    const release = this.releases.find((release) => release.tag === tag)
    if (!release) {
      throw new Error(`${tag} was not found in the eligible GitHub releases list`)
    }
    return release
  }

  previousTagFor(release: GithubRelease) {
    if (!this.previousReleaseTagByTag.has(release.tag)) {
      throw new Error(`No release-order baseline found for ${release.tag}`)
    }

    return this.previousReleaseTagByTag.get(release.tag) ?? null
  }
}

export class PostedReleaseHistory {
  constructor(private readonly state: StateFile) {}

  private assertReleaseIdentity(release: GithubRelease) {
    const saved = this.state.releases.find((entry) => entry.tag === release.tag)
    if (saved && saved.releaseId !== release.id) {
      throw new Error(`Release tag ${release.tag} changed GitHub release id from ${saved.releaseId} to ${release.id}`)
    }
  }

  latest() {
    return this.state.releases.reduce<PostedRelease | undefined>((latest, release) => {
      if (!latest) return release

      const latestTimestamp = postedReleaseTimestamp(latest)
      const releaseTimestamp = postedReleaseTimestamp(release)

      if (releaseTimestamp > latestTimestamp) return release
      if (releaseTimestamp === latestTimestamp && release.releaseId > latest.releaseId) return release

      return latest
    }, undefined)
  }

  hasPosted(release: GithubRelease) {
    this.assertReleaseIdentity(release)
    return this.state.releases.some((entry) => entry.releaseId === release.id)
  }

  pendingFrom(catalog: ReleaseCatalog, input: { targetTag?: ReleaseTag; allowPostedTarget: boolean }) {
    if (input.targetTag) {
      const release = catalog.requireTag(input.targetTag)
      if (!input.allowPostedTarget && this.hasPosted(release)) {
        throw new Error(`${release.tag} was already processed. Use --dry-run to preview it again.`)
      }
      return [release]
    }

    const latestPostedRelease = this.latest()
    return catalog.releases.filter((release) => {
      if (this.hasPosted(release)) return false
      if (!latestPostedRelease) return true

      const latestTimestamp = latestPostedRelease.publishedAt ?? latestPostedRelease.postedAt
      const currentTimestamp = releaseTimestamp(release)

      if (currentTimestamp > latestTimestamp) return true
      if (currentTimestamp === latestTimestamp && release.id > latestPostedRelease.releaseId) return true

      return false
    })
  }

  recordPosted(release: GithubRelease, post: PostText, tweetIds: TweetId[], postedAt: IsoDateString) {
    this.assertReleaseIdentity(release)

    const nextRelease: PostedRelease = {
      releaseId: release.id,
      tag: release.tag,
      name: release.name,
      url: release.url,
      draft: release.draft,
      prerelease: release.prerelease,
      publishedAt: release.publishedAt,
      tweets: [post],
      tweetIds,
      postedAt,
    }

    return new PostedReleaseHistory({
      version: 1,
      releases: this.state.releases
        .filter((entry) => entry.releaseId !== release.id)
        .concat(nextRelease)
        .sort((left, right) => left.postedAt.localeCompare(right.postedAt)),
    })
  }

  toState() {
    return this.state
  }
}
