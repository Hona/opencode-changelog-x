import { Client, Events, GatewayIntentBits, TextChannel } from "discord.js"
import { Effect } from "effect"
import { readDiscordConfig } from "./config.js"
import { BetaMonitor } from "./discord/beta-monitor.js"
import { PreviewCommand } from "./discord/preview-command.js"
import { PublishWorkflowMonitor } from "./discord/publish-workflow-monitor.js"
import { ReleasePoll } from "./discord/release-poll.js"
import { createDiscordRuntime } from "./discord/runtime.js"
import type { AlertChannel } from "./discord/types.js"

function createAlertChannel(channel: TextChannel): AlertChannel {
  return {
    async send(content) {
      const msg = await channel.send(content)
      return { id: msg.id }
    },
  }
}

async function main() {
  const config = await Effect.runPromise(Effect.sync(readDiscordConfig))
  const runtime = createDiscordRuntime(config)
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
  })

  let disposed = false
  const shutdown = async () => {
    if (disposed) return
    disposed = true
    client.destroy()
    await runtime.dispose()
  }

  const fatal = (error: unknown) => {
    console.error(error)
    void shutdown().finally(() => {
      process.exit(1)
    })
  }

  process.once("SIGINT", () => void shutdown())
  process.once("SIGTERM", () => void shutdown())

  client.once(Events.ClientReady, (readyClient) => void (async () => {
    console.log(`Discord preview bot ready as ${readyClient.user.tag}`)

    const channel = await readyClient.channels.fetch(config.discordChannelId)
    if (!(channel instanceof TextChannel)) {
      throw new Error(`Channel ${config.discordChannelId} was not found or is not a text channel`)
    }

    const alertChannel = createAlertChannel(channel)
    void runtime.runPromise(Effect.all([
      ReleasePoll.use((releasePoll) => releasePoll.run),
      PublishWorkflowMonitor.use((monitor) => monitor.run(alertChannel)),
      BetaMonitor.use((monitor) => monitor.run(alertChannel)),
    ], { concurrency: "unbounded" })).catch(fatal)

    console.log("Release poll started.")
    console.log("Workflow monitor started.")
    console.log("Beta monitor started.")
  })().catch(fatal))

  client.on(Events.MessageCreate, (message) => {
    void runtime.runPromise(PreviewCommand.use((preview) => preview.handleMessage(message))).catch(fatal)
  })

  client.on(Events.Error, (error) => {
    fatal(error)
  })

  try {
    await client.login(config.discordToken)
  } catch (error) {
    await shutdown()
    throw error
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
