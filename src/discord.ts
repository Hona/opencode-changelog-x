import { exec } from "node:child_process"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { promisify } from "node:util"
import {
  Client,
  EmbedBuilder,
  Events,
  GatewayIntentBits,
  TextChannel,
  ThreadAutoArchiveDuration,
  type Message,
} from "discord.js"
import { readDiscordConfig, type DiscordConfig } from "./config.js"
import { createPostGenerator } from "./generate.js"
import { getLatestRelease } from "./github.js"
import { getLatestPostedRelease, loadState } from "./state.js"
import type { ReleasePostReport } from "./types.js"
import { prepareUpstreamCheckout } from "./upstream.js"
import {
  checkBetaNpmStaleness,
  fetchLatestBetaFailureUrl,
  fetchLatestReleaseTag,
  fetchPublishWorkflowRuns,
  getAllRunIds,
  getCompletedRunIds,
  getNewAlerts,
  getNewlySeenRuns,
  loadWorkflowState,
  saveWorkflowState,
  type BetaNpmStatus,
  type WorkflowAlert,
} from "./workflows.js"

const execAsync = promisify(exec)

const PREVIEW_COMMAND = "!previewchangelog"
const PREVIEW_EMBED_COLOR = 0x5865f2
const DISCORD_EMBED_DESCRIPTION_LIMIT = 4096
const RELEASE_POLL_INTERVAL_MS = 10 * 60 * 1000
const WORKFLOW_POLL_INTERVAL_MS = 5 * 60 * 1000
const BETA_CHECK_INTERVAL_MS = 10 * 60 * 1000
const BETA_NPM_PACKAGE = "opencode-ai"

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
    await message.reply("Another operation is already running. Try again shortly.")
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

type AlertChannel = {
  send(content: string): Promise<{ id: string }>
  editMessage(messageId: string, content: string): Promise<void>
}

async function dispatchReleasePoll() {
  try {
    await execAsync("gh workflow run poll.yml -f dry_run=false", { timeout: 30_000 })
    console.log("Release poll dispatched.")
  } catch (error) {
    console.error(`Release poll dispatch failed: ${getErrorMessage(error)}`)
  }
}

function startReleasePollLoop() {
  async function tick() {
    await dispatchReleasePoll()
    setTimeout(tick, RELEASE_POLL_INTERVAL_MS)
  }

  setTimeout(tick, 30_000)
}

function formatTriggeredAlert(alert: WorkflowAlert): string {
  return `\`${alert.actor}\` triggered release\n[View workflow run](${alert.url})`
}

function formatCompletedAlert(alert: WorkflowAlert, tag: string | null): string {
  if (alert.success && tag) {
    return `\`${alert.actor}\` triggered \`${tag}\` release\n[View workflow run](${alert.url})`
  }
  if (alert.success) {
    return `\`${alert.actor}\` triggered release — **published**\n[View workflow run](${alert.url})`
  }
  const verb = alert.conclusion === "cancelled" ? "cancelled" : "failed"
  return `\`${alert.actor}\` triggered release — **${verb}**\n[Open logs](${alert.url})`
}

async function checkPublishWorkflows(
  config: DiscordConfig,
  channel: AlertChannel,
  pendingMessages: Map<number, string>,
) {
  const workflowStateFile = join(dirname(config.stateFile), "publish-workflow-state.json")

  const [runs, state] = await Promise.all([
    fetchPublishWorkflowRuns(config.githubOwner, config.githubRepo),
    loadWorkflowState(workflowStateFile),
  ])

  if (state.seenRunIds.length === 0 && state.reportedRunIds.length === 0) {
    const allIds = getAllRunIds(runs)
    const completedIds = getCompletedRunIds(runs)
    if (allIds.length > 0) {
      console.log(`Seeding workflow state with ${allIds.length} existing run(s).`)
      await saveWorkflowState(workflowStateFile, { seenRunIds: allIds, reportedRunIds: completedIds })
      return
    }
  }

  let dirty = false
  let nextSeen = state.seenRunIds
  let nextReported = state.reportedRunIds

  const triggered = getNewlySeenRuns(runs, state)
  for (const alert of triggered) {
    const sent = await channel.send(formatTriggeredAlert(alert))
    pendingMessages.set(alert.runId, sent.id)
    console.log(`Posted triggered alert: run ${alert.runId} by ${alert.actor}`)
  }
  if (triggered.length > 0) {
    nextSeen = [...nextSeen, ...triggered.map((a) => a.runId)].slice(-100)
    dirty = true
  }

  const completed = getNewAlerts(runs, state)
  for (const alert of completed) {
    const tag = alert.success
      ? await fetchLatestReleaseTag(config.githubOwner, config.githubRepo)
      : null
    const content = formatCompletedAlert(alert, tag)
    const messageId = pendingMessages.get(alert.runId)

    if (messageId) {
      try {
        await channel.editMessage(messageId, content)
        pendingMessages.delete(alert.runId)
      } catch {
        await channel.send(content)
      }
    } else {
      await channel.send(content)
    }

    console.log(`Posted completion alert: ${alert.conclusion} run ${alert.runId} by ${alert.actor}${tag ? ` (${tag})` : ""}`)
  }
  if (completed.length > 0) {
    nextReported = [...nextReported, ...completed.map((a) => a.runId)].slice(-100)
    dirty = true
  }

  if (dirty) {
    await saveWorkflowState(workflowStateFile, { seenRunIds: nextSeen, reportedRunIds: nextReported })
  }
}

function startWorkflowMonitorLoop(config: DiscordConfig, channel: AlertChannel) {
  const pendingMessages = new Map<number, string>()

  async function tick() {
    try {
      await checkPublishWorkflows(config, channel, pendingMessages)
    } catch (error) {
      console.error(`Workflow monitor error: ${getErrorMessage(error)}`)
    }
    setTimeout(tick, WORKFLOW_POLL_INTERVAL_MS)
  }

  setTimeout(tick, 5_000)
}

function formatBetaAge(ageMs: number): string {
  const hours = Math.floor(ageMs / (60 * 60 * 1000))
  const mins = Math.floor((ageMs % (60 * 60 * 1000)) / (60 * 1000))
  return hours > 0 ? `${hours}h ${mins}m` : `${mins}m`
}

function formatBetaStaleAlert(status: BetaNpmStatus, failureUrl: string | null): string {
  let msg = `**Beta release is stale** — last published ${formatBetaAge(status.ageMs)} ago (\`${BETA_NPM_PACKAGE}@${status.version}\`)`
  if (failureUrl) {
    msg += `\n[Last failure](${failureUrl})`
  }
  return msg
}

function formatBetaResolvedAlert(status: BetaNpmStatus): string {
  return `~~Beta release was stale~~ — resolved (\`${BETA_NPM_PACKAGE}@${status.version}\`)`
}

function startBetaMonitorLoop(config: DiscordConfig, channel: AlertChannel) {
  let alertMessageId: string | null = null

  async function tick() {
    try {
      const status = await checkBetaNpmStaleness(BETA_NPM_PACKAGE)
      if (!status) return

      if (status.stale) {
        const failureUrl = await fetchLatestBetaFailureUrl(config.githubOwner, config.githubRepo)
        const content = formatBetaStaleAlert(status, failureUrl)

        if (!alertMessageId) {
          const sent = await channel.send(content)
          alertMessageId = sent.id
          console.log(`Beta stale alert: ${status.version} is ${formatBetaAge(status.ageMs)} old`)
        } else {
          try {
            await channel.editMessage(alertMessageId, content)
          } catch {
            const sent = await channel.send(content)
            alertMessageId = sent.id
          }
        }
      } else if (alertMessageId) {
        try {
          await channel.editMessage(alertMessageId, formatBetaResolvedAlert(status))
        } catch {
          // Message might have been deleted, just clear state.
        }
        alertMessageId = null
        console.log(`Beta stale alert resolved: ${status.version}`)
      }
    } catch (error) {
      console.error(`Beta monitor error: ${getErrorMessage(error)}`)
    }
    setTimeout(tick, BETA_CHECK_INTERVAL_MS)
  }

  setTimeout(tick, 15_000)
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

  client.once(Events.ClientReady, async (readyClient) => {
    console.log(`Discord preview bot ready as ${readyClient.user.tag}`)

    startReleasePollLoop()

    try {
      const channel = await readyClient.channels.fetch(config.discordChannelId)
      if (channel instanceof TextChannel) {
        const alertChannel: AlertChannel = {
          async send(content) {
            const msg = await channel.send(content)
            return { id: msg.id }
          },
          async editMessage(messageId, content) {
            const msg = await channel.messages.fetch(messageId)
            await msg.edit(content)
          },
        }
        startWorkflowMonitorLoop(config, alertChannel)
        startBetaMonitorLoop(config, alertChannel)
        console.log("Workflow monitor started.")
        console.log("Beta monitor started.")
      } else {
        console.error(`Channel ${config.discordChannelId} not found or not a text channel, workflow monitoring disabled.`)
      }
    } catch (error) {
      console.error(`Failed to fetch channel for workflow monitoring: ${getErrorMessage(error)}`)
    }
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
