import { Context, Effect, Layer } from "effect"
import { GithubReleases } from "../github.js"
import { GitCli } from "../integrations/git-cli.js"
import { GithubCli } from "../integrations/github-cli.js"
import { hasPostedRelease, parseStateText } from "../state.js"
import type { WorkflowTarget } from "../workflows.js"
import { getErrorMessage } from "./errors.js"

const POSTED_RELEASES_REF = "origin/master:data/posted-releases.json"
const RELEASE_POLL_WORKFLOW = {
  owner: "Hona",
  repo: "opencode-changelog-x",
  workflow: "poll.yml",
} satisfies WorkflowTarget

export class OriginPostedReleaseState extends Context.Service<OriginPostedReleaseState, {
  readonly load: () => Effect.Effect<ReturnType<typeof parseStateText>, unknown>
}>()("app/OriginPostedReleaseState") {
  static readonly layer = Layer.effect(
    this,
    Effect.gen(function* () {
      const git = yield* GitCli

      const load = Effect.fn("OriginPostedReleaseState.load")(function* () {
        yield* git.fetch("origin", "master")
        const text = yield* git.show(POSTED_RELEASES_REF)
        return parseStateText(text)
      })

      return OriginPostedReleaseState.of({ load })
    }),
  )

  static readonly defaultLayer = this.layer.pipe(Layer.provide(GitCli.layer))
}

export class ReleasePoll extends Context.Service<ReleasePoll, {
  readonly dispatchOnce: () => Effect.Effect<void>
  readonly run: Effect.Effect<void>
}>()("app/ReleasePoll") {
  static readonly layer = Layer.effect(
    this,
    Effect.gen(function* () {
      const github = yield* GithubCli
      const releases = yield* GithubReleases
      const originState = yield* OriginPostedReleaseState

      const getUnpostedLatestRelease = Effect.fn("ReleasePoll.getUnpostedLatestRelease")(function* () {
        const [latestRelease, state] = yield* Effect.all([
          releases.latest(),
          originState.load(),
        ])

        if (!latestRelease) return null
        return hasPostedRelease(state, latestRelease) ? null : latestRelease
      })

      const dispatchOnceUnsafe = Effect.fn("ReleasePoll.dispatchOnce")(function* () {
        const pendingRelease = yield* getUnpostedLatestRelease()
        if (!pendingRelease) {
          yield* Effect.sync(() => console.log("No unposted release found; skipping release poll dispatch."))
          return
        }

        const active = yield* github.hasActiveWorkflowDispatchRun(RELEASE_POLL_WORKFLOW)
        if (active) {
          yield* Effect.sync(() => console.log("Release poll already running; skipping dispatch."))
          return
        }

        yield* github.runWorkflow(RELEASE_POLL_WORKFLOW, { dry_run: "false" })
        yield* Effect.sync(() => console.log(`Release poll dispatched for ${pendingRelease.tag}.`))
      })

      const dispatchOnce = () => dispatchOnceUnsafe().pipe(
        Effect.catch((error) => Effect.sync(() => console.error(`Release poll dispatch failed: ${getErrorMessage(error)}`))),
      )

      const run = Effect.gen(function* () {
        yield* Effect.sleep("30 seconds")
        while (true) {
          yield* dispatchOnce()
          yield* Effect.sleep("10 minutes")
        }
      })

      return ReleasePoll.of({ dispatchOnce, run })
    }),
  )

  static readonly defaultLayer = this.layer.pipe(
    Layer.provide(OriginPostedReleaseState.defaultLayer),
    Layer.provide(GithubReleases.layer),
    Layer.provide(GithubCli.layer),
  )
}
