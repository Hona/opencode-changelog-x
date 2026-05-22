import { Context, Layer } from "effect"
import type { AppConfig, DiscordConfig } from "./config.js"

export class RuntimeConfig extends Context.Service<RuntimeConfig, AppConfig>()("app/RuntimeConfig") {
  static layer(config: AppConfig) {
    return Layer.succeed(this, this.of(config))
  }
}

export class DiscordSettings extends Context.Service<DiscordSettings, Pick<DiscordConfig, "discordChannelId">>()("app/DiscordSettings") {
  static layer(config: DiscordConfig) {
    return Layer.succeed(this, this.of({ discordChannelId: config.discordChannelId }))
  }
}
