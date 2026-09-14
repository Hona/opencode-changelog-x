import type { PostedRelease, StateFile } from "../state.js"
import { compareReleaseOrder, releaseMajor, type GithubRelease } from "./releases.js"
import type { IsoDateString, PostText, ReleaseTag, TweetId } from "./value-objects.js"

function highestByVersion<T extends { tag: ReleaseTag }>(releases: readonly T[]) {
  return releases.reduce<T | null>((highest, release) => {
    if (!highest || compareReleaseOrder(release, highest) > 0) return release
    return highest
  }, null)
}

export class ReleaseCatalog {
  readonly releases: readonly GithubRelease[]
  private readonly previousReleaseTagByTag = new Map<ReleaseTag, ReleaseTag | null>()

  constructor(releases: readonly GithubRelease[]) {
    this.releases = [...releases].sort(compareReleaseOrder)

    for (const [index, release] of this.releases.entries()) {
      const previous = this.releases
        .slice(0, index)
        .reverse()
        .find((candidate) => compareReleaseOrder(candidate, release) < 0)
      this.previousReleaseTagByTag.set(release.tag, previous?.tag ?? null)
    }
  }

  requireTag(tag: string) {
    const release = this.releases.find((release) => release.tag === tag)
    if (!release) {
      throw new Error(`${tag} was not found in the eligible releases list`)
    }
    return release
  }

  previousTagFor(release: GithubRelease) {
    if (!this.previousReleaseTagByTag.has(release.tag)) {
      throw new Error(`No release-order baseline found for ${release.tag}`)
    }

    return this.previousReleaseTagByTag.get(release.tag) ?? null
  }

  latest() {
    return this.releases.at(-1) ?? null
  }

  latestForMajor(major: number) {
    return highestByVersion(this.releases.filter((release) => releaseMajor(release) === major))
  }
}

export class PostedReleaseHistory {
  constructor(private readonly state: StateFile) {}

  private matches(entry: PostedRelease, release: GithubRelease) {
    if (entry.tag === release.tag) return true
    return entry.releaseId !== null && release.id !== null && entry.releaseId === release.id
  }

  private assertReleaseIdentity(release: GithubRelease) {
    const saved = this.state.releases.find((entry) => entry.tag === release.tag)
    if (saved && saved.releaseId !== null && release.id !== null && saved.releaseId !== release.id) {
      throw new Error(`Release tag ${release.tag} changed GitHub release id from ${saved.releaseId} to ${release.id}`)
    }
  }

  latest() {
    return highestByVersion(this.state.releases) ?? undefined
  }

  latestForMajor(major: number) {
    return highestByVersion(this.state.releases.filter((entry) => releaseMajor(entry) === major))
  }

  hasPosted(release: GithubRelease) {
    this.assertReleaseIdentity(release)
    return this.state.releases.some((entry) => this.matches(entry, release))
  }

  // A release is pending when it is newer than the highest posted release of its
  // major line. A line with no posted releases starts after the highest posted release overall.
  isPending(release: GithubRelease) {
    if (this.hasPosted(release)) return false

    const baseline = this.latestForMajor(releaseMajor(release)) ?? this.latest()
    if (!baseline) return true

    return compareReleaseOrder(release, baseline) > 0
  }

  pendingFrom(catalog: ReleaseCatalog, input: { targetTag?: ReleaseTag; allowPostedTarget: boolean }) {
    if (input.targetTag) {
      const release = catalog.requireTag(input.targetTag)
      if (!input.allowPostedTarget && this.hasPosted(release)) {
        throw new Error(`${release.tag} was already processed. Use --dry-run to preview it again.`)
      }
      return [release]
    }

    return catalog.releases.filter((release) => this.isPending(release))
  }

  recordPosted(release: GithubRelease, post: PostText, tweetIds: TweetId[], postedAt: IsoDateString) {
    this.assertReleaseIdentity(release)

    const nextRelease: PostedRelease = {
      releaseId: release.id,
      source: release.source,
      commitSha: release.commitSha,
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
        .filter((entry) => !this.matches(entry, release))
        .concat(nextRelease)
        .sort((left, right) => left.postedAt.localeCompare(right.postedAt)),
    })
  }

  toState() {
    return this.state
  }
}
