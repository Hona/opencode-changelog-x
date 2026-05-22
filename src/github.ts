import { Context, Effect, Layer, Schema } from "effect"
import { z } from "zod"
import type { AppConfig } from "./config.js"
import { compareReleaseOrder, createGithubRelease, type GithubRelease } from "./domain/releases.js"
import { GithubCli, type GithubCliService } from "./integrations/github-cli.js"
import { RuntimeConfig } from "./runtime-config.js"

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

function mapRelease(release: z.infer<typeof releaseSchema>): GithubRelease {
  return createGithubRelease({
    id: release.id,
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

function fetchReleasesPageEffect(config: AppConfig, github: GithubCliService, page: number) {
  return Effect.gen(function* () {
    const params = new URLSearchParams({
      per_page: String(config.githubReleaseLimit),
      page: String(page),
    })
    const stdout = yield* github.api(`repos/${config.githubOwner}/${config.githubRepo}/releases?${params}`).pipe(
      Effect.mapError((cause) => new GithubReleasesError({ message: "GitHub releases request failed", cause })),
    )

    const json = yield* Effect.try({
      try: () => JSON.parse(stdout),
      catch: (cause) => new GithubReleasesError({ message: "GitHub releases response body could not be parsed", cause }),
    })

    return releasesSchema.parse(json)
  })
}

export class GithubReleases extends Context.Service<GithubReleases, {
  readonly latest: () => Effect.Effect<GithubRelease | null, GithubReleasesError>
  readonly list: () => Effect.Effect<GithubRelease[], GithubReleasesError>
}>()("app/GithubReleases") {
  static readonly layer = Layer.effect(
    this,
    Effect.gen(function* () {
      const config = yield* RuntimeConfig
      const github = yield* GithubCli

      const latest = Effect.fn("GithubReleases.latest")(function* () {
        for (let page = 1; ; page += 1) {
          const releases = yield* fetchReleasesPageEffect(config, github, page)
          const latest = releases.map(mapRelease).find((release) => isEligibleRelease(config, release))

          if (latest) return latest
          if (releases.length < config.githubReleaseLimit) return null
        }
      })

      const list = Effect.fn("GithubReleases.list")(function* () {
        const payload = []

        for (let page = 1; ; page += 1) {
          const releases = yield* fetchReleasesPageEffect(config, github, page)
          payload.push(...releases)

          if (releases.length < config.githubReleaseLimit) break
        }

        return payload
          .map(mapRelease)
          .filter((release) => isEligibleRelease(config, release))
          .sort(compareReleaseOrder)
      })

      return GithubReleases.of({ latest, list })
    }),
  )

  static readonly defaultLayer = this.layer.pipe(Layer.provide(GithubCli.layer))
}
