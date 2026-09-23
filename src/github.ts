import { Context, Effect, Layer, Schema } from "effect"
import { z } from "zod"
import type { AppConfig } from "./config.js"
import {
  compareReleaseOrder,
  createGithubRelease,
  createTagRelease,
  releaseMajor,
  type GithubRelease,
} from "./domain/releases.js"
import { compareVersionStrings, majorOf } from "./domain/semver.js"
import { isReleaseTag, type ReleaseTag } from "./domain/value-objects.js"
import { GithubCli, type GithubCliService } from "./integrations/github-cli.js"
import { RuntimeConfig } from "./runtime-config.js"
import type { PostedRelease } from "./state.js"

export class GithubReleasesError extends Schema.TaggedErrorClass<GithubReleasesError>()("GithubReleasesError", {
  message: Schema.String,
  cause: Schema.Defect,
}) {}

const releaseSchema = z.object({
  id: z.number(),
  tag_name: z.string(),
  name: z.string().nullable().optional(),
  html_url: z.string().url(),
  draft: z.boolean(),
  prerelease: z.boolean(),
  created_at: z.string(),
  published_at: z.string().nullable(),
})

const releasesSchema = z.array(releaseSchema)
const releaseFieldsJq = "[.[] | {id, tag_name, name, html_url, draft, prerelease, created_at, published_at}]"

const tagRefSchema = z.object({
  ref: z.string(),
  object: z.object({
    sha: z.string(),
    type: z.string(),
  }),
})

const tagRefsSchema = z.array(tagRefSchema)
const tagRefFieldsJq = "[.[] | {ref, object: {sha: .object.sha, type: .object.type}}]"

const taggedObjectSchema = z.object({
  sha: z.string(),
  date: z.string(),
})

type TagRef = {
  tag: string
  sha: string
  type: string
}

export type ReleaseListOptions = {
  readonly known?: readonly PostedRelease[]
}

function mapRelease(release: z.infer<typeof releaseSchema>, commitSha: string | null): GithubRelease {
  return createGithubRelease({
    id: release.id,
    commitSha,
    tag: release.tag_name,
    name: release.name?.trim() || release.tag_name,
    url: release.html_url,
    draft: release.draft,
    prerelease: release.prerelease,
    createdAt: release.created_at,
    publishedAt: release.published_at,
  })
}

function isEligibleRelease(config: AppConfig, release: GithubRelease) {
  return config.githubProcessDrafts || !release.draft
}

function parseJson(stdout: string, description: string) {
  return Effect.try({
    try: () => JSON.parse(stdout) as unknown,
    catch: (cause) => new GithubReleasesError({ message: `${description} response body could not be parsed`, cause }),
  })
}

function fetchReleasesPageEffect(config: AppConfig, github: GithubCliService, page: number) {
  return Effect.gen(function* () {
    const params = new URLSearchParams({
      per_page: String(config.githubReleaseLimit),
      page: String(page),
    })
    const stdout = yield* github.api(`repos/${config.githubOwner}/${config.githubRepo}/releases?${params}`, ["--jq", releaseFieldsJq]).pipe(
      Effect.mapError((cause) => new GithubReleasesError({ message: "GitHub releases request failed", cause })),
    )

    return releasesSchema.parse(yield* parseJson(stdout, "GitHub releases"))
  })
}

function fetchAllReleasesEffect(config: AppConfig, github: GithubCliService) {
  return Effect.gen(function* () {
    const payload = []

    for (let page = 1; ; page += 1) {
      const releases = yield* fetchReleasesPageEffect(config, github, page)
      payload.push(...releases)

      if (releases.length < config.githubReleaseLimit) break
    }

    return payload.filter((release) => isReleaseTag(release.tag_name))
  })
}

function fetchTagRefsEffect(config: AppConfig, github: GithubCliService) {
  return Effect.gen(function* () {
    const stdout = yield* github.api(`repos/${config.githubOwner}/${config.githubRepo}/git/matching-refs/tags/v`, ["--jq", tagRefFieldsJq]).pipe(
      Effect.mapError((cause) => new GithubReleasesError({ message: "GitHub tag refs request failed", cause })),
    )

    return tagRefsSchema.parse(yield* parseJson(stdout, "GitHub tag refs"))
      .map((ref): TagRef => ({ tag: ref.ref.replace(/^refs\/tags\//, ""), sha: ref.object.sha, type: ref.object.type }))
      .filter((ref) => isReleaseTag(ref.tag))
  })
}

function resolveTaggedObjectEffect(config: AppConfig, github: GithubCliService, ref: TagRef) {
  return Effect.gen(function* () {
    const repoPath = `repos/${config.githubOwner}/${config.githubRepo}`
    const request = ref.type === "tag"
      ? github.api(`${repoPath}/git/tags/${ref.sha}`, ["--jq", "{sha: .object.sha, date: .tagger.date}"])
      : github.api(`${repoPath}/commits/${ref.sha}`, ["--jq", "{sha, date: .commit.committer.date}"])
    const stdout = yield* request.pipe(
      Effect.mapError((cause) => new GithubReleasesError({ message: `GitHub tag lookup failed for ${ref.tag}`, cause })),
    )

    return taggedObjectSchema.parse(yield* parseJson(stdout, `GitHub tag ${ref.tag}`))
  })
}

// Tags without a GitHub release only count when they are newer than every GitHub
// release of their major line; older gaps were never meant to be announced.
function isForwardTag(tag: string, ceilingByMajor: ReadonlyMap<number, string>) {
  const ceiling = ceilingByMajor.get(majorOf(tag))
  return !ceiling || compareVersionStrings(tag, ceiling) > 0
}

function fetchMergedReleasesEffect(config: AppConfig, github: GithubCliService, options: ReleaseListOptions) {
  return Effect.gen(function* () {
    const [releases, refs] = yield* Effect.all([
      fetchAllReleasesEffect(config, github),
      fetchTagRefsEffect(config, github),
    ], { concurrency: "unbounded" })

    const refByTag = new Map(refs.map((ref) => [ref.tag, ref]))
    const githubReleases = releases.map((release) => mapRelease(release, refByTag.get(release.tag_name)?.sha ?? null))
    const releasedTags = new Set<ReleaseTag>(githubReleases.map((release) => release.tag))
    const ceilingByMajor = new Map<number, string>()
    for (const release of githubReleases) {
      const major = releaseMajor(release)
      const ceiling = ceilingByMajor.get(major)
      if (!ceiling || compareVersionStrings(release.tag, ceiling) > 0) ceilingByMajor.set(major, release.tag)
    }

    const knownByTag = new Map((options.known ?? []).map((entry) => [entry.tag as string, entry]))
    const tagReleases = yield* Effect.all(
      refs
        .filter((ref) => !releasedTags.has(ref.tag as ReleaseTag) && isForwardTag(ref.tag, ceilingByMajor))
        .map((ref) => Effect.gen(function* () {
          const known = knownByTag.get(ref.tag)
          const tagged = known
            ? { sha: known.commitSha ?? ref.sha, date: known.publishedAt ?? known.postedAt }
            : yield* resolveTaggedObjectEffect(config, github, ref)

          return createTagRelease({
            owner: config.githubOwner,
            repo: config.githubRepo,
            tag: ref.tag,
            commitSha: tagged.sha,
            taggedAt: tagged.date,
          })
        })),
      { concurrency: 4 },
    )

    return [...githubReleases, ...tagReleases]
      .filter((release) => isEligibleRelease(config, release))
      .sort(compareReleaseOrder)
  })
}

export class GithubReleases extends Context.Service<GithubReleases, {
  readonly latest: (options?: ReleaseListOptions) => Effect.Effect<GithubRelease | null, GithubReleasesError>
  readonly list: (options?: ReleaseListOptions) => Effect.Effect<GithubRelease[], GithubReleasesError>
}>()("app/GithubReleases") {
  static readonly layer = Layer.effect(
    this,
    Effect.gen(function* () {
      const config = yield* RuntimeConfig
      const github = yield* GithubCli

      const list = Effect.fn("GithubReleases.list")(function* (options: ReleaseListOptions = {}) {
        return yield* fetchMergedReleasesEffect(config, github, options)
      })

      const latest = Effect.fn("GithubReleases.latest")(function* (options: ReleaseListOptions = {}) {
        const releases = yield* list(options)
        return releases.at(-1) ?? null
      })

      return GithubReleases.of({ latest, list })
    }),
  )

  static readonly defaultLayer = this.layer.pipe(Layer.provide(GithubCli.layer))
}
