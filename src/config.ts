import { z } from "zod"
import { releaseTagFromString, type ReleaseTag } from "./domain/value-objects.js"

const twitterCredentialsSchema = z.object({
  appKey: z.string().min(1, "TWITTER_APP_KEY is required"),
  appSecret: z.string().min(1, "TWITTER_APP_SECRET is required"),
  accessToken: z.string().min(1, "TWITTER_ACCESS_TOKEN is required"),
  accessSecret: z.string().min(1, "TWITTER_ACCESS_SECRET is required"),
})

export type TwitterCredentials = z.infer<typeof twitterCredentialsSchema>

export type AppConfig = {
  githubOwner: string
  githubRepo: string
  githubReleaseLimit: number
  githubProcessDrafts: boolean
  upstreamCloneUrl: string
  opencodeTimeoutMs: number
  opencodeEchoOutput: boolean
  stateFile: string
  dryRun: boolean
  targetTag?: ReleaseTag
  twitter?: TwitterCredentials
}

type SharedConfig = Omit<AppConfig, "dryRun" | "targetTag" | "twitter">

export type DiscordConfig = AppConfig & {
  discordToken: string
  discordChannelId: string
}

const GITHUB_OWNER = "anomalyco"
const GITHUB_REPO = "opencode"
const GITHUB_RELEASE_LIMIT = 20
const OPENCODE_TIMEOUT_MS = 600_000
const STATE_FILE = "data/posted-releases.json"
const DISCORD_PREVIEW_CHANNEL_ID = "1472697640880701523"

function readString(env: NodeJS.ProcessEnv, name: string) {
  const value = env[name]?.trim()
  if (value) return value
  throw new Error(`${name} is required`)
}

function readBoolean(env: NodeJS.ProcessEnv, name: string, fallback = false) {
  const value = env[name]?.trim().toLowerCase()
  if (!value) return fallback
  if (["1", "true", "yes", "on"].includes(value)) return true
  if (["0", "false", "no", "off"].includes(value)) return false
  throw new Error(`${name} must be a boolean value`)
}

function readCliArgs(argv: string[]) {
  let dryRun: boolean | undefined
  let targetTag: ReleaseTag | undefined

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === "--dry-run") {
      dryRun = true
      continue
    }

    if (arg === "--tag") {
      const value = argv[index + 1]?.trim()
      if (!value) throw new Error("--tag requires a value")
      targetTag = releaseTagFromString(value.startsWith("v") ? value : `v${value}`)
      index += 1
      continue
    }
  }

  return { dryRun, targetTag }
}

function readSharedConfig(env: NodeJS.ProcessEnv): SharedConfig {
  return {
    githubOwner: GITHUB_OWNER,
    githubRepo: GITHUB_REPO,
    githubReleaseLimit: GITHUB_RELEASE_LIMIT,
    githubProcessDrafts: readBoolean(env, "GITHUB_PROCESS_DRAFTS", false),
    upstreamCloneUrl: `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}.git`,
    opencodeTimeoutMs: OPENCODE_TIMEOUT_MS,
    opencodeEchoOutput: readBoolean(env, "OPENCODE_ECHO_OUTPUT", false),
    stateFile: STATE_FILE,
  }
}

export function readConfig(env: NodeJS.ProcessEnv = process.env, argv: string[] = process.argv.slice(2)): AppConfig {
  const cli = readCliArgs(argv)
  const dryRun = cli.dryRun ?? readBoolean(env, "DRY_RUN", false)

  const config: AppConfig = {
    ...readSharedConfig(env),
    dryRun,
    targetTag: cli.targetTag,
  }

  if (!dryRun) {
    config.twitter = twitterCredentialsSchema.parse({
      appKey: env.TWITTER_APP_KEY,
      appSecret: env.TWITTER_APP_SECRET,
      accessToken: env.TWITTER_ACCESS_TOKEN,
      accessSecret: env.TWITTER_ACCESS_SECRET,
    })
  }

  return config
}

export function readDiscordConfig(env: NodeJS.ProcessEnv = process.env): DiscordConfig {
  return {
    ...readSharedConfig(env),
    dryRun: true,
    targetTag: undefined,
    twitter: undefined,
    discordToken: readString(env, "DISCORD_TOKEN"),
    discordChannelId: DISCORD_PREVIEW_CHANNEL_ID,
  }
}
