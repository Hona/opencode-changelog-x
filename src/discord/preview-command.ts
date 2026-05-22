import { EmbedBuilder, ThreadAutoArchiveDuration, type Message } from "discord.js"
import { Context, Effect, Layer, Option, Semaphore } from "effect"
import { PREVIEW_MODEL } from "../constants.js"
import { PostGenerator } from "../generate.js"
import { GithubReleases } from "../github.js"
import type { ReleasePostReport } from "../types.js"
import { UpstreamRepository } from "../upstream.js"
import { DiscordSettings } from "../runtime-config.js"
import { getErrorMessage } from "./errors.js"

const PREVIEW_COMMAND = "!previewchangelog"
const PREVIEW_EMBED_COLOR = 0x5865f2
const DISCORD_EMBED_DESCRIPTION_LIMIT = 4096

type ThreadSender = {
  send: (options: { embeds: EmbedBuilder[] }) => Promise<unknown>
}

type LatestReleaseBaseline = {
  tag: string
  releaseTimestamp: string | null
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

function getReleaseTimestamp(release: { publishedAt: string | null; createdAt: string }) {
  return release.publishedAt ?? release.createdAt
}

function sendThreadEmbed(channel: ThreadSender, embed: EmbedBuilder) {
  return Effect.tryPromise(() => channel.send({ embeds: [embed] })).pipe(Effect.asVoid)
}

function react(message: Message, emoji: string) {
  return Effect.tryPromise(() => message.react(emoji)).pipe(Effect.asVoid)
}

export class PreviewCommand extends Context.Service<PreviewCommand, {
  readonly handleMessage: (message: Message) => Effect.Effect<void, unknown>
}>()("app/PreviewCommand") {
  static readonly layer = Layer.effect(
    this,
    Effect.gen(function* () {
      const discord = yield* DiscordSettings
      const releases = yield* GithubReleases
      const upstream = yield* UpstreamRepository
      const postGenerator = yield* PostGenerator
      const semaphore = yield* Semaphore.make(1)

      const resolveLatestReleaseBaseline = Effect.fn("PreviewCommand.resolveLatestReleaseBaseline")(function* () {
        const latestRelease = yield* releases.latest()
        if (!latestRelease) {
          return yield* Effect.fail(new Error("No eligible GitHub release found for preview baseline"))
        }

        return {
          tag: latestRelease.tag,
          releaseTimestamp: getReleaseTimestamp(latestRelease),
        } satisfies LatestReleaseBaseline
      })

      const generatePreview = Effect.fn("PreviewCommand.generatePreview")(function* (message: Message<true>) {
        const latestRelease = yield* resolveLatestReleaseBaseline()
        const latestReleaseTag = latestRelease?.tag ?? null
        const thread = yield* Effect.tryPromise(() => message.startThread({
          name: buildThreadName(latestReleaseTag),
          autoArchiveDuration: ThreadAutoArchiveDuration.OneDay,
          reason: "OpenCode changelog preview",
        }))

        yield* upstream.withCheckout((checkout) => Effect.gen(function* () {
          try {
            const range = yield* checkout.resolvePreviewRange(
              latestReleaseTag,
              latestRelease?.releaseTimestamp ?? null,
            )

            if (range.commitCount === 0) {
              const baseline = latestReleaseTag ?? "the repository start"
              yield* sendThreadEmbed(thread, buildInfoEmbed("No unreleased commits", `Nothing new landed after ${baseline}.`))
              return
            }

            yield* Effect.tryPromise(() => thread.setName(buildThreadName(range.fromTag)))
            yield* Effect.sync(() => console.log(`Starting preview for ${message.author.tag}: ${range.fromTag ?? "<none>"} -> ${range.toLabel}`))

            yield* postGenerator.withGenerator(checkout.directory, PREVIEW_MODEL, (generator) => Effect.gen(function* () {
              const report = yield* generator.generateReport(range)

              for (const embed of buildPostEmbeds(report)) {
                yield* sendThreadEmbed(thread, embed)
              }

              yield* Effect.sync(() => console.log(`Preview posted for ${message.author.tag}: ${report.fromTag ?? "<none>"} -> ${report.toLabel}`))
            }))
          } catch (error) {
            yield* sendThreadEmbed(thread, buildInfoEmbed("Preview failed", getErrorMessage(error)))
            return yield* Effect.fail(error)
          }
        }))
      })

      const runPreview = Effect.fn("PreviewCommand.runPreview")(function* (message: Message<true>) {
        yield* react(message, "⏳")
        yield* generatePreview(message)
        yield* react(message, "✅")
      })

      const handleMessage = Effect.fn("PreviewCommand.handleMessage")(function* (message: Message) {
        if (!message.inGuild()) return
        if (message.author.bot) return
        if (message.channelId !== discord.discordChannelId) return
        if (message.content.trim() !== PREVIEW_COMMAND) return

        const result = yield* semaphore.withPermitsIfAvailable(1)(
          runPreview(message as Message<true>).pipe(
            Effect.catch((error) => Effect.gen(function* () {
              yield* Effect.sync(() => console.error(error))
              yield* react(message, "❌")
            })),
          ),
        )

        if (Option.isNone(result)) {
          yield* Effect.tryPromise(() => message.reply("Another operation is already running. Try again shortly."))
        }
      })

      return PreviewCommand.of({ handleMessage })
    }),
  )

  static readonly defaultLayer = this.layer.pipe(
    Layer.provide(GithubReleases.defaultLayer),
    Layer.provide(UpstreamRepository.defaultLayer),
    Layer.provide(PostGenerator.layer),
  )
}
