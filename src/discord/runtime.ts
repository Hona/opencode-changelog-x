import { Layer, ManagedRuntime } from "effect"
import type { DiscordConfig } from "../config.js"
import { DiscordSettings, RuntimeConfig } from "../runtime-config.js"
import { BetaMonitor } from "./beta-monitor.js"
import { PreviewCommand } from "./preview-command.js"
import { PublishWorkflowMonitor } from "./publish-workflow-monitor.js"
import { ReleasePoll } from "./release-poll.js"

export function createDiscordRuntime(config: DiscordConfig) {
  return ManagedRuntime.make(
    Layer.mergeAll(
      ReleasePoll.defaultLayer,
      PreviewCommand.defaultLayer,
      PublishWorkflowMonitor.defaultLayer,
      BetaMonitor.defaultLayer,
    ).pipe(
      Layer.provide(RuntimeConfig.layer(config)),
      Layer.provide(DiscordSettings.layer(config)),
    ),
  )
}
