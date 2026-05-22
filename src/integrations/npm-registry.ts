import { Context, Effect, Layer } from "effect"
import { z } from "zod"

export const OPENCODE_NPM_PACKAGE = "opencode-ai"

const NPM_METADATA_TIMEOUT_MS = 15_000
const NPM_TARBALL_TIMEOUT_MS = 5 * 60 * 1000

const versionMetadataSchema = z.object({
  optionalDependencies: z.record(z.string(), z.string()).optional(),
  dist: z.object({
    tarball: z.string().url().optional(),
  }).optional(),
})

const packumentSchema = z.object({
  "dist-tags": z.record(z.string(), z.string()).optional(),
  time: z.record(z.string(), z.string()).optional(),
})

export type VersionMetadata = z.infer<typeof versionMetadataSchema>
export type Packument = z.infer<typeof packumentSchema>

function encodePackageName(packageName: string) {
  return packageName.startsWith("@") ? packageName.replace("/", "%2f") : packageName
}

function fetchJson(url: string): Effect.Effect<unknown, unknown> {
  return Effect.gen(function* () {
    const response = yield* Effect.tryPromise(() => fetch(url, {
      headers: {
        Accept: "application/json",
        "User-Agent": "opencode-changelog-x",
      },
      signal: AbortSignal.timeout(NPM_METADATA_TIMEOUT_MS),
    }))

    if (!response.ok) {
      return yield* Effect.fail(new Error(`NPM request failed (${response.status} ${response.statusText}) for ${url}`))
    }

    return yield* Effect.tryPromise(() => response.json())
  })
}

export type NpmRegistryService = {
  readonly versionMetadata: (packageName: string, version: string) => Effect.Effect<VersionMetadata, unknown>
  readonly packument: (packageName: string) => Effect.Effect<Packument, unknown>
  readonly downloadTarball: (url: string) => Effect.Effect<Buffer, unknown>
}

export class NpmRegistry extends Context.Service<NpmRegistry, NpmRegistryService>()("app/NpmRegistry") {
  static readonly layer = Layer.succeed(
    this,
    this.of({
      versionMetadata(packageName, version) {
        return Effect.gen(function* () {
          const json = yield* fetchJson(`https://registry.npmjs.org/${encodePackageName(packageName)}/${version}`)
          return versionMetadataSchema.parse(json)
        })
      },
      packument(packageName) {
        return Effect.gen(function* () {
          const json = yield* fetchJson(`https://registry.npmjs.org/${encodePackageName(packageName)}`)
          return packumentSchema.parse(json)
        })
      },
      downloadTarball(url) {
        return Effect.gen(function* () {
          const response = yield* Effect.tryPromise(() => fetch(url, {
            headers: {
              "User-Agent": "opencode-changelog-x",
            },
            signal: AbortSignal.timeout(NPM_TARBALL_TIMEOUT_MS),
          }))

          if (!response.ok) {
            return yield* Effect.fail(new Error(`NPM tarball request failed (${response.status} ${response.statusText}) for ${url}`))
          }

          const arrayBuffer = yield* Effect.tryPromise(() => response.arrayBuffer())
          return Buffer.from(arrayBuffer)
        })
      },
    }),
  )
}
