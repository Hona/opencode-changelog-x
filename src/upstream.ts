import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Context, Effect, Layer, Option } from "effect"
import { z } from "zod"
import type { AppConfig } from "./config.js"
import {
  createCompareUrl,
  createPreviewRange,
  createReleaseRange,
  type GithubRelease,
  type ReleaseRange,
} from "./domain/releases.js"
import { parseSemver } from "./domain/semver.js"
import { gitRefFromString } from "./domain/value-objects.js"
import type { IsoDateString, ReleaseTag } from "./domain/value-objects.js"
import { GitCli, type GitCliService } from "./integrations/git-cli.js"
import { RuntimeConfig } from "./runtime-config.js"

const HEAD_VERSION_MANIFESTS = ["packages/cli/package.json", "packages/opencode/package.json"] as const
const manifestSchema = z.object({ version: z.string() })

export type EffectUpstreamCheckout = {
  directory: string
  resolveHeadMajor: () => Effect.Effect<number, unknown>
  resolveRange: (
    release: GithubRelease,
    fromTag: ReleaseTag | null,
  ) => Effect.Effect<ReleaseRange, unknown>
  resolvePreviewRange: (
    fromTag: ReleaseTag | null,
    fromReleaseTimestamp?: IsoDateString | null,
  ) => Effect.Effect<ReleaseRange, unknown>
}

function createEffectCheckout(directory: string, config: AppConfig, git: GitCliService): EffectUpstreamCheckout {
  const resolveHeadSha = Effect.fn("UpstreamCheckout.resolveHeadSha")(function* () {
    return yield* git.run(["rev-parse", "HEAD"], { cwd: directory })
  })

  const resolveShortSha = Effect.fn("UpstreamCheckout.resolveShortSha")(function* (ref: string) {
    return yield* git.run(["rev-parse", "--short=12", ref], { cwd: directory })
  })

  const countCommits = Effect.fn("UpstreamCheckout.countCommits")(function* (fromRef: string | null, toRef: string) {
    const range = fromRef ? `${fromRef}..${toRef}` : toRef
    const output = yield* git.run(["rev-list", "--count", range], { cwd: directory })
    const count = Number.parseInt(output, 10)

    if (!Number.isInteger(count) || count < 0) {
      return yield* Effect.fail(new Error(`Invalid commit count for range ${range}: ${output}`))
    }

    return count
  })

  const resolveHeadMajor = Effect.fn("UpstreamCheckout.resolveHeadMajor")(function* () {
    for (const manifest of HEAD_VERSION_MANIFESTS) {
      const text = yield* git.run(["show", `HEAD:${manifest}`], { cwd: directory }).pipe(Effect.option)
      if (Option.isNone(text)) continue

      const version = manifestSchema.parse(JSON.parse(text.value)).version
      const parsed = parseSemver(version)
      if (!parsed) {
        return yield* Effect.fail(new Error(`${manifest} at HEAD has a non-semver version: ${version}`))
      }
      return parsed.major
    }

    return yield* Effect.fail(new Error(`No version manifest found at HEAD (${HEAD_VERSION_MANIFESTS.join(", ")})`))
  })

  return {
    directory,
    resolveHeadMajor,
    resolveRange: Effect.fn("UpstreamCheckout.resolveRange")(function* (release: GithubRelease, fromTag: ReleaseTag | null) {
      const commitCount = yield* countCommits(fromTag, release.tag)

      return createReleaseRange({
        release,
        fromTag,
        compareUrl: createCompareUrl({
          owner: config.githubOwner,
          repo: config.githubRepo,
          fromTag,
          toTag: gitRefFromString(release.tag),
        }),
        repoDir: directory,
        commitCount,
      })
    }),
    resolvePreviewRange: Effect.fn("UpstreamCheckout.resolvePreviewRange")(function* (
      fromTag: ReleaseTag | null,
      fromReleaseTimestamp?: IsoDateString | null,
    ) {
      const toTag = yield* resolveHeadSha()
      const toRef = gitRefFromString(toTag)
      const shortSha = yield* resolveShortSha(toRef)
      const commitCount = yield* countCommits(fromTag, toRef)

      return createPreviewRange({
        fromTag,
        fromReleaseTimestamp,
        toTag: toRef,
        shortSha,
        compareUrl: createCompareUrl({
          owner: config.githubOwner,
          repo: config.githubRepo,
          fromTag,
          toTag: toRef,
        }),
        repoDir: directory,
        commitCount,
      })
    }),
  }
}

export class UpstreamRepository extends Context.Service<UpstreamRepository, {
  readonly withCheckout: <A, E, R>(use: (checkout: EffectUpstreamCheckout) => Effect.Effect<A, E, R>) => Effect.Effect<A, E | unknown, R>
}>()("app/UpstreamRepository") {
  static readonly layer = Layer.effect(
    this,
    Effect.gen(function* () {
      const config = yield* RuntimeConfig
      const git = yield* GitCli

      const withCheckout = <A, E, R>(use: (checkout: EffectUpstreamCheckout) => Effect.Effect<A, E, R>) =>
        Effect.acquireRelease(
          Effect.gen(function* () {
            const root = yield* Effect.tryPromise(() => mkdtemp(join(tmpdir(), "opencode-changelog-x-")))
            const directory = join(root, "upstream")
            yield* git.run(["clone", "--quiet", "--tags", config.upstreamCloneUrl, directory], { timeout: 5 * 60_000 })
            return { root, checkout: createEffectCheckout(directory, config, git) }
          }),
          ({ root }) => Effect.tryPromise(() => rm(root, { recursive: true, force: true })).pipe(Effect.catch(Effect.die)),
        ).pipe(
          Effect.flatMap(({ checkout }) => use(checkout)),
          Effect.scoped,
        )

      return UpstreamRepository.of({ withCheckout })
    }),
  )

  static readonly defaultLayer = this.layer.pipe(Layer.provide(GitCli.layer))
}
