import { z } from "zod"

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
  githubToken?: string
  githubReleaseLimit: number
  githubProcessDrafts: boolean
  upstreamRepoDir?: string
  upstreamCloneUrl: string
  opencodeTimeoutMs: number
  stateFile: string
  dryRun: boolean
  targetTag?: string
  twitter?: TwitterCredentials
}

type SharedConfig = Omit<AppConfig, "dryRun" | "targetTag" | "twitter">

export type DiscordConfig = AppConfig & {
  discordToken: string
  discordChannelId: string
}

const DISCORD_PREVIEW_CHANNEL_ID = "1472697640880701523"

function readString(env: NodeJS.ProcessEnv, name: string, fallback?: string) {
  const value = env[name]?.trim()
  if (value) return value
  if (fallback !== undefined) return fallback
  throw new Error(`${name} is required`)
}

function readBoolean(env: NodeJS.ProcessEnv, name: string, fallback = false) {
  const value = env[name]?.trim().toLowerCase()
  if (!value) return fallback
  if (["1", "true", "yes", "on"].includes(value)) return true
  if (["0", "false", "no", "off"].includes(value)) return false
  throw new Error(`${name} must be a boolean value`)
}

function readPositiveInteger(env: NodeJS.ProcessEnv, name: string, fallback: number) {
  const raw = env[name]?.trim()
  if (!raw) return fallback
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`)
  }
  return parsed
}

function readCliArgs(argv: string[]) {
  let dryRun: boolean | undefined
  let targetTag: string | undefined

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === "--dry-run") {
      dryRun = true
      continue
    }

    if (arg === "--tag") {
      const value = argv[index + 1]?.trim()
      if (!value) throw new Error("--tag requires a value")
      targetTag = value.startsWith("v") ? value : `v${value}`
      index += 1
      continue
    }
  }

  return { dryRun, targetTag }
}

function readSharedConfig(env: NodeJS.ProcessEnv): SharedConfig {
  const githubOwner = readString(env, "GITHUB_OWNER", "anomalyco")
  const githubRepo = readString(env, "GITHUB_REPO", "opencode")

  return {
    githubOwner,
    githubRepo,
    githubToken: env.GITHUB_API_TOKEN?.trim() || env.GITHUB_TOKEN?.trim() || undefined,
    githubReleaseLimit: readPositiveInteger(env, "GITHUB_RELEASE_LIMIT", 20),
    githubProcessDrafts: readBoolean(env, "GITHUB_PROCESS_DRAFTS", false),
    upstreamRepoDir: env.UPSTREAM_REPO_DIR?.trim() || undefined,
    upstreamCloneUrl: readString(env, "UPSTREAM_CLONE_URL", `https://github.com/${githubOwner}/${githubRepo}.git`),
    opencodeTimeoutMs: readPositiveInteger(env, "OPENCODE_TIMEOUT_MS", 600_000),
    stateFile: readString(env, "STATE_FILE", "data/posted-releases.json"),
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
