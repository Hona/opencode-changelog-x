import { Layer, ManagedRuntime } from "effect"
import { readConfig } from "./config.js"
import { ReleasePublisher } from "./release-publisher.js"
import { RuntimeConfig } from "./runtime-config.js"

const config = readConfig()
const runtime = ManagedRuntime.make(
  ReleasePublisher.defaultLayer.pipe(
    Layer.provide(RuntimeConfig.layer(config)),
  ),
)

runtime.runPromise(ReleasePublisher.use((publisher) => publisher.run))
  .catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
  .finally(() => {
    return runtime.dispose()
  })
