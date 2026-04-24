import { spawn } from "node:child_process"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { AppConfig } from "./config.js"
import type { GithubRelease, ReleaseRange } from "./types.js"

type UpstreamCheckout = {
  directory: string
  resolveRange: (
    release: GithubRelease,
    fromTag: string | null,
  ) => Promise<ReleaseRange>
  resolvePreviewRange: (
    fromTag: string | null,
    fromReleaseTimestamp?: string | null,
  ) => Promise<ReleaseRange>
  close: () => Promise<void>
}

function run(command: string, args: string[], cwd?: string) {
  return new Promise<string>((resolvePromise, rejectPromise) => {
    const proc = spawn(command, args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    })

    let stdout = ""
    let stderr = ""

    proc.stdout.on("data", (chunk) => {
      stdout += chunk.toString()
    })

    proc.stderr.on("data", (chunk) => {
      stderr += chunk.toString()
    })

    proc.on("error", rejectPromise)
    proc.on("close", (code) => {
      if (code === 0) {
        resolvePromise(stdout.trim())
        return
      }

      rejectPromise(new Error(`${command} ${args.join(" ")} failed with exit code ${code}\n${stderr || stdout}`))
    })
  })
}

function createCompareUrl(config: AppConfig, fromTag: string | null, toTag: string) {
  if (fromTag) {
    return `https://github.com/${config.githubOwner}/${config.githubRepo}/compare/${fromTag}...${toTag}`
  }

  return `https://github.com/${config.githubOwner}/${config.githubRepo}/tree/${toTag}`
}

async function resolveHeadSha(directory: string) {
  return run("git", ["rev-parse", "HEAD"], directory)
}

async function resolveShortSha(directory: string, ref: string) {
  return run("git", ["rev-parse", "--short=12", ref], directory)
}

async function countCommits(directory: string, fromRef: string | null, toRef: string) {
  const range = fromRef ? `${fromRef}..${toRef}` : toRef
  const output = await run("git", ["rev-list", "--count", range], directory)
  const count = Number.parseInt(output, 10)

  if (!Number.isInteger(count) || count < 0) {
    throw new Error(`Invalid commit count for range ${range}: ${output}`)
  }

  return count
}

function createCheckout(directory: string, config: AppConfig, close: () => Promise<void>): UpstreamCheckout {
  return {
    directory,
    async resolveRange(release, fromTag) {
      const commitCount = await countCommits(directory, fromTag, release.tag)

      return {
        kind: "release",
        release,
        fromTag,
        toTag: release.tag,
        toLabel: release.tag,
        compareUrl: createCompareUrl(config, fromTag, release.tag),
        repoDir: directory,
        commitCount,
      }
    },
    async resolvePreviewRange(fromTag, fromReleaseTimestamp) {
      const toTag = await resolveHeadSha(directory)
      const shortSha = await resolveShortSha(directory, toTag)
      const commitCount = await countCommits(directory, fromTag, toTag)

      return {
        kind: "preview",
        release: null,
        fromTag,
        fromReleaseTimestamp,
        toTag,
        toLabel: `HEAD (${shortSha})`,
        compareUrl: createCompareUrl(config, fromTag, toTag),
        repoDir: directory,
        commitCount,
      }
    },
    close,
  }
}

export async function prepareUpstreamCheckout(config: AppConfig): Promise<UpstreamCheckout> {
  const root = await mkdtemp(join(tmpdir(), "opencode-changelog-x-"))
  const directory = join(root, "upstream")
  await run("git", ["clone", "--quiet", "--tags", config.upstreamCloneUrl, directory])

  return createCheckout(directory, config, async () => {
    await rm(root, { recursive: true, force: true })
  })
}
