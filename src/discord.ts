import { Client, Events, GatewayIntentBits, TextChannel } from "discord.js"
import { readDiscordConfig } from "./config.js"
import { BetaMonitor } from "./discord/beta-monitor.js"
import { getErrorMessage } from "./discord/errors.js"
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
  const config = readDiscordConfig()
  const runtime = createDiscordRuntime(config)
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
  })

  let disposed = false
  const shutdown = () => {
    if (disposed) return
    disposed = true
    client.destroy()
    void runtime.dispose()
  }

  process.once("SIGINT", shutdown)
  process.once("SIGTERM", shutdown)

  client.once(Events.ClientReady, async (readyClient) => {
    console.log(`Discord preview bot ready as ${readyClient.user.tag}`)

    runtime.runFork(ReleasePoll.use((releasePoll) => releasePoll.run))

    try {
      const channel = await readyClient.channels.fetch(config.discordChannelId)
      if (channel instanceof TextChannel) {
        const alertChannel = createAlertChannel(channel)
        runtime.runFork(PublishWorkflowMonitor.use((monitor) => monitor.run(alertChannel)))
        runtime.runFork(BetaMonitor.use((monitor) => monitor.run(alertChannel)))
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
    void runtime.runPromise(PreviewCommand.use((preview) => preview.handleMessage(message))).catch(console.error)
  })

  client.on(Events.Error, (error) => {
    console.error(error)
  })

  try {
    await client.login(config.discordToken)
  } catch (error) {
    shutdown()
    throw error
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
