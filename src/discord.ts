import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import {
  Client,
  EmbedBuilder,
  Events,
  GatewayIntentBits,
  ThreadAutoArchiveDuration,
  type Message,
} from "discord.js"
import { readDiscordConfig, type DiscordConfig } from "./config.js"
import { createPostGenerator } from "./generate.js"
import { getLatestRelease } from "./github.js"
import { getLatestPostedRelease, loadState } from "./state.js"
import type { ReleasePostReport } from "./types.js"
import { prepareUpstreamCheckout } from "./upstream.js"

const PREVIEW_COMMAND = "!previewchangelog"
const PREVIEW_EMBED_COLOR = 0x5865f2
const DISCORD_EMBED_DESCRIPTION_LIMIT = 4096

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

function buildThreadName(fromTag: string | null) {
  const name = fromTag ? `Preview since ${fromTag}` : "Preview changelog"
  return name.length <= 100 ? name : `${name.slice(0, 97)}...`
}

function buildInfoEmbed(title: string, description: string) {
  return new EmbedBuilder()
    .setColor(PREVIEW_EMBED_COLOR)
    .setTitle(title)
    .setDescription(description)
}

function splitPreviewText(text: string, maxLength: number) {
  const chunks: string[] = []
  let remaining = text.replace(/\r/g, "").trim()

  while (remaining.length > maxLength) {
    let splitIndex = remaining.lastIndexOf("\n\n", maxLength)
    if (splitIndex < Math.floor(maxLength / 2)) {
      splitIndex = remaining.lastIndexOf("\n", maxLength)
    }
    if (splitIndex < Math.floor(maxLength / 2)) {
      splitIndex = remaining.lastIndexOf(" ", maxLength)
    }
    if (splitIndex <= 0) {
      splitIndex = maxLength
    }

    chunks.push(remaining.slice(0, splitIndex).trim())
    remaining = remaining.slice(splitIndex).trim()
  }

  if (remaining) {
    chunks.push(remaining)
  }

  return chunks.length > 0 ? chunks : [text]
}

function buildPostEmbeds(report: ReleasePostReport) {
  const chunks = splitPreviewText(report.post, DISCORD_EMBED_DESCRIPTION_LIMIT)

  return chunks.map((chunk, index) =>
    new EmbedBuilder()
      .setColor(PREVIEW_EMBED_COLOR)
      .setTitle(chunks.length === 1 ? "Preview" : `Preview ${index + 1}/${chunks.length}`)
      .setDescription(chunk)
      .setURL(report.compareUrl)
      .setFooter({
        text: report.fromTag ? `${report.fromTag} -> ${report.toLabel}` : report.toLabel,
      }),
  )
}

type ThreadSender = {
  send: (options: { embeds: EmbedBuilder[] }) => Promise<unknown>
}

type LatestReleaseCache = {
  tag: string
  cachedAt: string
}

async function sendThreadEmbed(channel: ThreadSender, embed: EmbedBuilder) {
  await channel.send({ embeds: [embed] })
}

function buildLatestReleaseCachePath(config: DiscordConfig) {
  return join(dirname(config.stateFile), "latest-github-release.json")
}

async function readLatestReleaseCache(filePath: string) {
  try {
    const text = await readFile(filePath, "utf8")
    const payload = JSON.parse(text) as Partial<LatestReleaseCache>
    return typeof payload.tag === "string" && payload.tag.trim() ? payload.tag.trim() : null
  } catch (error) {
    if (typeof error === "object" && error && "code" in error && error.code === "ENOENT") {
      return null
    }

    throw error
  }
}

async function writeLatestReleaseCache(filePath: string, tag: string) {
  await mkdir(dirname(filePath), { recursive: true })
  await writeFile(
    filePath,
    `${JSON.stringify({ tag, cachedAt: new Date().toISOString() } satisfies LatestReleaseCache, null, 2)}\n`,
    "utf8",
  )
}

async function resolveLatestReleaseTag(config: DiscordConfig) {
  const cacheFile = buildLatestReleaseCachePath(config)

  try {
    const latestRelease = await getLatestRelease(config)

    if (!latestRelease) {
      return await readLatestReleaseCache(cacheFile)
    }

    await writeLatestReleaseCache(cacheFile, latestRelease.tag)
    return latestRelease.tag
  } catch (error) {
    const cachedTag = await readLatestReleaseCache(cacheFile)
    if (cachedTag) {
      console.warn(`Falling back to cached latest release ${cachedTag}: ${getErrorMessage(error)}`)
      return cachedTag
    }

    const state = await loadState(config.stateFile)
    const postedTag = getLatestPostedRelease(state)?.tag ?? null
    if (postedTag) {
      console.warn(`Falling back to posted release state ${postedTag}: ${getErrorMessage(error)}`)
      return postedTag
    }

    throw error
  }
}

async function generatePreview(message: Message<true>, config: DiscordConfig) {
  const latestReleaseTag = await resolveLatestReleaseTag(config)
  const thread = await message.startThread({
    name: buildThreadName(latestReleaseTag),
    autoArchiveDuration: ThreadAutoArchiveDuration.OneDay,
    reason: "OpenCode changelog preview",
  })

  const checkout = await prepareUpstreamCheckout(config)

  try {
    const range = await checkout.resolvePreviewRange(latestReleaseTag)

    if (range.commitCount === 0) {
      const baseline = latestReleaseTag ?? "the repository start"
      await sendThreadEmbed(thread, buildInfoEmbed("No unreleased commits", `Nothing new landed after ${baseline}.`))
      return
    }

    await thread.setName(buildThreadName(range.fromTag))
    console.log(`Starting preview for ${message.author.tag}: ${range.fromTag ?? "<none>"} -> ${range.toLabel}`)

    const generator = await createPostGenerator(config, checkout.directory)

    try {
      const report = await generator.generateReport(range)

      for (const embed of buildPostEmbeds(report)) {
        await sendThreadEmbed(thread, embed)
      }

      console.log(`Preview posted for ${message.author.tag}: ${report.fromTag ?? "<none>"} -> ${report.toLabel}`)
    } finally {
      await generator.close()
    }
  } catch (error) {
    await sendThreadEmbed(thread, buildInfoEmbed("Preview failed", getErrorMessage(error)))
    throw error
  } finally {
    await checkout.close()
  }
}

async function handleMessage(message: Message, config: DiscordConfig, busy: { active: boolean }) {
  if (!message.inGuild()) return
  if (message.author.bot) return
  if (message.channelId !== config.discordChannelId) return
  if (message.content.trim() !== PREVIEW_COMMAND) return

  if (busy.active) {
    await message.reply("A changelog preview is already running in this bot process.")
    return
  }

  busy.active = true

  try {
    await message.react("⏳")
    await generatePreview(message as Message<true>, config)
    await message.react("✅")
  } catch (error) {
    console.error(error)

    try {
      await message.react("❌")
    } catch {
      // Ignore reaction failures after logging the actual error.
    }
  } finally {
    busy.active = false
  }
}

async function main() {
  const config = readDiscordConfig()
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
  })
  const busy = { active: false }

  client.once(Events.ClientReady, (readyClient) => {
    console.log(`Discord preview bot ready as ${readyClient.user.tag}`)
  })

  client.on(Events.MessageCreate, (message) => {
    void handleMessage(message, config, busy)
  })

  client.on(Events.Error, (error) => {
    console.error(error)
  })

  await client.login(config.discordToken)
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
