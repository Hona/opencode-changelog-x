import { Effect, Layer, ManagedRuntime } from "effect"
import { readConfig } from "./config.js"
import { ReleasePublisher } from "./release-publisher.js"
import { RuntimeConfig } from "./runtime-config.js"

Effect.runPromise(Effect.sync(readConfig))
  .then(async (config) => {
    const runtime = ManagedRuntime.make(
      ReleasePublisher.defaultLayer.pipe(
        Layer.provide(RuntimeConfig.layer(config)),
      ),
    )

    try {
      await runtime.runPromise(ReleasePublisher.use((publisher) => publisher.run))
    } finally {
      await runtime.dispose()
    }
  })
  .catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
