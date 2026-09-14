import { describe, expect, test } from "bun:test"
import { PostedReleaseHistory, ReleaseCatalog } from "../src/domain/release-history.js"
import { createGithubRelease, createTagRelease, type GithubRelease } from "../src/domain/releases.js"
import { postTextFromString, releaseTagFromString, tweetIdFromString, isoDateStringFromString } from "../src/domain/value-objects.js"
import { parseStateText, type PostedRelease, type StateFile } from "../src/state.js"

let nextId = 1000

function githubRelease(tag: string, publishedAt: string): GithubRelease {
  nextId += 1
  return createGithubRelease({
    id: nextId,
    commitSha: `sha-${tag}`,
    tag,
    name: tag,
    url: `https://github.com/anomalyco/opencode/releases/tag/${tag}`,
    draft: false,
    prerelease: false,
    createdAt: publishedAt,
    publishedAt,
  })
}

function tagRelease(tag: string, taggedAt: string): GithubRelease {
  return createTagRelease({
    owner: "anomalyco",
    repo: "opencode",
    tag,
    commitSha: `sha-${tag}`,
    taggedAt,
  })
}

function posted(release: GithubRelease, postedAt: string): PostedRelease {
  return {
    releaseId: release.id,
    source: release.source,
    commitSha: release.commitSha,
    tag: release.tag,
    name: release.name,
    url: release.url,
    draft: release.draft,
    prerelease: release.prerelease,
    publishedAt: release.publishedAt,
    tweets: [postTextFromString(`${release.tag} post`)],
    tweetIds: [tweetIdFromString(`tweet-${release.tag}`)],
    postedAt: isoDateStringFromString(postedAt),
  }
}

function state(releases: PostedRelease[]): StateFile {
  return { version: 1, releases }
}

// Publish timestamps deliberately interleave the 1.x and 2.x lines.
const v11829 = githubRelease("v1.18.29", "2026-09-04T23:47:16Z")
const v11830 = githubRelease("v1.18.30", "2026-09-09T03:34:27Z")
const v200 = tagRelease("v2.0.0", "2026-09-11T10:00:00Z")
const v201 = tagRelease("v2.0.1", "2026-09-11T18:00:00Z")
const v202 = tagRelease("v2.0.2", "2026-09-12T08:00:00Z")
const v203 = tagRelease("v2.0.3", "2026-09-12T23:47:55Z")
const v11831 = githubRelease("v1.18.31", "2026-09-14T01:00:00Z")
const v204 = tagRelease("v2.0.4", "2026-09-14T02:00:00Z")

const catalog = new ReleaseCatalog([v203, v11831, v200, v11829, v204, v202, v11830, v201])

describe("ReleaseCatalog", () => {
  test("sorts by semver instead of publish time", () => {
    expect(catalog.releases.map((release) => release.tag)).toEqual([
      "v1.18.29", "v1.18.30", "v1.18.31", "v2.0.0", "v2.0.1", "v2.0.2", "v2.0.3", "v2.0.4",
    ])
  })

  test("picks the semver predecessor as the previous tag", () => {
    expect(catalog.previousTagFor(v11831)).toBe("v1.18.30")
    expect(catalog.previousTagFor(v201)).toBe("v2.0.0")
    expect(catalog.previousTagFor(v200)).toBe("v1.18.31")
    expect(catalog.previousTagFor(v11829)).toBeNull()
  })

  test("previous tag for the first 2.x release is the highest 1.x release", () => {
    const launch = new ReleaseCatalog([v203, v200, v11829, v11830, v201])
    expect(launch.previousTagFor(v200)).toBe("v1.18.30")
  })

  test("exposes the latest release overall and per major line", () => {
    expect(catalog.latest()?.tag).toBe("v2.0.4")
    expect(catalog.latestForMajor(1)?.tag).toBe("v1.18.31")
    expect(catalog.latestForMajor(2)?.tag).toBe("v2.0.4")
    expect(catalog.latestForMajor(3)).toBeNull()
  })

  test("rejects releases outside the catalog", () => {
    expect(() => catalog.previousTagFor(tagRelease("v9.9.9", "2026-09-14T00:00:00Z"))).toThrow("No release-order baseline")
    expect(() => catalog.requireTag("v9.9.9")).toThrow("was not found")
  })
})

describe("PostedReleaseHistory.pendingFrom", () => {
  test("a new major line starts after the highest posted release", () => {
    const history = new PostedReleaseHistory(state([
      posted(v11829, "2026-09-04T23:56:16Z"),
      posted(v11830, "2026-09-09T03:42:56Z"),
    ]))

    const pending = history.pendingFrom(catalog, { allowPostedTarget: false })
    expect(pending.map((release) => release.tag)).toEqual(["v1.18.31", "v2.0.0", "v2.0.1", "v2.0.2", "v2.0.3", "v2.0.4"])
  })

  test("each major line advances independently", () => {
    const history = new PostedReleaseHistory(state([
      posted(v11830, "2026-09-09T03:42:56Z"),
      posted(v200, "2026-09-13T00:00:00Z"),
      posted(v201, "2026-09-13T00:10:00Z"),
      posted(v202, "2026-09-13T00:20:00Z"),
      posted(v203, "2026-09-13T00:30:00Z"),
    ]))

    const pending = history.pendingFrom(catalog, { allowPostedTarget: false })
    expect(pending.map((release) => release.tag)).toEqual(["v1.18.31", "v2.0.4"])
  })

  test("ignores stale lines below the posted baseline", () => {
    const old = tagRelease("v0.15.25", "2025-08-01T00:00:00Z")
    const history = new PostedReleaseHistory(state([posted(v11830, "2026-09-09T03:42:56Z")]))

    const pending = history.pendingFrom(new ReleaseCatalog([old, v11830, v200]), { allowPostedTarget: false })
    expect(pending.map((release) => release.tag)).toEqual(["v2.0.0"])
  })

  test("skips releases posted earlier in the same line even when unposted older ones exist", () => {
    const history = new PostedReleaseHistory(state([posted(v202, "2026-09-13T00:20:00Z")]))

    const pending = history.pendingFrom(new ReleaseCatalog([v200, v201, v202, v203]), { allowPostedTarget: false })
    expect(pending.map((release) => release.tag)).toEqual(["v2.0.3"])
  })

  test("--tag selects one release and refuses posted ones outside dry-run", () => {
    const history = new PostedReleaseHistory(state([posted(v203, "2026-09-13T00:30:00Z")]))

    expect(history.pendingFrom(catalog, { targetTag: releaseTagFromString("v2.0.1"), allowPostedTarget: false })).toEqual([v201])
    expect(history.pendingFrom(catalog, { targetTag: releaseTagFromString("v2.0.3"), allowPostedTarget: true })).toEqual([v203])
    expect(() => history.pendingFrom(catalog, { targetTag: releaseTagFromString("v2.0.3"), allowPostedTarget: false })).toThrow("already processed")
  })
})

describe("PostedReleaseHistory identity", () => {
  test("matches tag-only releases by tag and GitHub releases by id", () => {
    const history = new PostedReleaseHistory(state([
      posted(v11830, "2026-09-09T03:42:56Z"),
      posted(v203, "2026-09-13T00:30:00Z"),
    ]))

    expect(history.hasPosted(v11830)).toBe(true)
    expect(history.hasPosted(v203)).toBe(true)
    expect(history.hasPosted(v204)).toBe(false)
    expect(history.latest()?.tag).toBe("v2.0.3")
    expect(history.latestForMajor(1)?.tag).toBe("v1.18.30")
  })

  test("accepts a GitHub release created later for a posted tag", () => {
    const history = new PostedReleaseHistory(state([posted(v203, "2026-09-13T00:30:00Z")]))
    expect(history.hasPosted(githubRelease("v2.0.3", "2026-09-13T01:00:00Z"))).toBe(true)
  })

  test("still rejects a tag whose GitHub release id changed", () => {
    const history = new PostedReleaseHistory(state([posted(v11830, "2026-09-09T03:42:56Z")]))
    expect(() => history.hasPosted(githubRelease("v1.18.30", "2026-09-09T03:34:27Z"))).toThrow("changed GitHub release id")
  })

  test("records tag-only releases with a null release id", () => {
    const history = new PostedReleaseHistory(state([posted(v11830, "2026-09-09T03:42:56Z")]))
      .recordPosted(v200, postTextFromString("post"), [tweetIdFromString("1")], isoDateStringFromString("2026-09-14T00:00:00Z"))

    const saved = history.toState().releases.find((entry) => entry.tag === "v2.0.0")
    expect(saved).toMatchObject({ releaseId: null, source: "git-tag", commitSha: "sha-v2.0.0" })
    expect(parseStateText(JSON.stringify(history.toState())).releases).toHaveLength(2)
  })
})

describe("state file", () => {
  test("parses legacy entries without source or commit sha", () => {
    const legacy = {
      version: 1,
      releases: [{
        releaseId: 385202354,
        tag: "v1.18.30",
        name: "v1.18.30",
        url: "https://github.com/anomalyco/opencode/releases/tag/v1.18.30",
        draft: false,
        prerelease: false,
        publishedAt: "2026-09-09T03:34:27Z",
        tweets: ["post"],
        tweetIds: ["1"],
        postedAt: "2026-09-09T03:42:56.022Z",
      }],
    }

    const parsed = parseStateText(JSON.stringify(legacy))
    expect(parsed.releases[0]).toMatchObject({ releaseId: 385202354, tag: "v1.18.30" })
    expect(parsed.releases[0]?.source).toBeUndefined()
  })

  test("allows several null release ids but not duplicate numeric ids", () => {
    const entry = (tag: string, releaseId: number | null) => ({
      releaseId,
      tag,
      name: tag,
      url: `https://github.com/anomalyco/opencode/releases/tag/${tag}`,
      draft: false,
      prerelease: false,
      publishedAt: null,
      tweets: ["post"],
      tweetIds: ["1"],
      postedAt: "2026-09-13T00:00:00Z",
    })

    expect(parseStateText(JSON.stringify({ version: 1, releases: [entry("v2.0.0", null), entry("v2.0.1", null)] })).releases).toHaveLength(2)
    expect(() => parseStateText(JSON.stringify({ version: 1, releases: [entry("v1.0.0", 7), entry("v1.0.1", 7)] }))).toThrow("Posted release ids must be unique")
  })
})
