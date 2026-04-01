import { spawn } from "node:child_process"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import type { AppConfig } from "./config.js"
import type { GithubRelease, ReleaseRange } from "./types.js"

type UpstreamCheckout = {
  directory: string
  resolveRange: (release: GithubRelease) => Promise<ReleaseRange>
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

async function resolvePreviousTag(directory: string, tag: string) {
  try {
    return await run("git", ["describe", "--tags", "--abbrev=0", `${tag}^`], directory)
  } catch {
    return null
  }
}

function createCheckout(directory: string, config: AppConfig, close: () => Promise<void>): UpstreamCheckout {
  return {
    directory,
    async resolveRange(release) {
      const fromTag = await resolvePreviousTag(directory, release.tag)
      return {
        release,
        fromTag,
        toTag: release.tag,
        compareUrl: createCompareUrl(config, fromTag, release.tag),
        repoDir: directory,
      }
    },
    close,
  }
}

export async function prepareUpstreamCheckout(config: AppConfig): Promise<UpstreamCheckout> {
  if (config.upstreamRepoDir) {
    return createCheckout(resolve(config.upstreamRepoDir), config, async () => {})
  }

  const root = await mkdtemp(join(tmpdir(), "opencode-changelog-x-"))
  const directory = join(root, "upstream")
  await run("git", ["clone", "--quiet", "--tags", config.upstreamCloneUrl, directory])

  return createCheckout(directory, config, async () => {
    await rm(root, { recursive: true, force: true })
  })
}
