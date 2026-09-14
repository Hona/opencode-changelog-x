import { gunzipSync } from "node:zlib"
import { Context, Effect, Layer } from "effect"
import { parseBuffer, type BunModule, type ParsedBunBinary } from "unbunjs"
import type { ReleaseRange } from "./domain/releases.js"
import {
  NpmRegistry,
  opencodeNpmPackagesForVersion,
  type NpmRegistryService,
  type OpencodeNpmPackages,
} from "./integrations/npm-registry.js"

const TAG_VERSION_PATTERN = /(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)$/
const BYTE_DECIMALS = 1
const SIGNIFICANT_BUNDLE_DELTA_BYTES = 1024 * 1024
const BUNDLE_SUMMARY_MAX_LENGTH = 240
const NATIVE_EXTENSIONS = new Set([".dll", ".dylib", ".node", ".so"])

export const BUNDLE_PLATFORMS = [
  { platform: "darwin-arm64", label: "macOS arm64" },
  { platform: "linux-x64", label: "Linux x64" },
  { platform: "windows-x64", label: "Windows x64" },
] as const

export type BundleTarget = {
  readonly packageName: string
  readonly label: string
}

export function bundleTargetsFor(packages: OpencodeNpmPackages): BundleTarget[] {
  return BUNDLE_PLATFORMS.map((target) => ({
    packageName: `${packages.binaryPackagePrefix}${target.platform}`,
    label: target.label,
  }))
}
export type BundleCategory =
  | "total"
  | "bunRuntime"
  | "cliTuiJs"
  | "webUiAssets"
  | "nativeAddons"
  | "wasm"
  | "sourceMaps"
  | "bytecode"
  | "moduleInfo"
  | "otherEmbedded"
  | "bundleMetadata"

export type BundleAnalysis = Record<BundleCategory, number>

export const BUNDLE_CATEGORIES = [
  "total",
  "bunRuntime",
  "cliTuiJs",
  "webUiAssets",
  "nativeAddons",
  "wasm",
  "sourceMaps",
  "bytecode",
  "moduleInfo",
  "otherEmbedded",
  "bundleMetadata",
] as const satisfies readonly BundleCategory[]

export type ParsedStandaloneBinary = Pick<ParsedBunBinary, "offsets" | "modules">

type SnapshotInfo = {
  version: string
  publishedAt: string | null
}

export type BundleInspection = {
  packageName: string
  packageVersion: string
  analysis: BundleAnalysis
  bunVersions: string[]
}

export type ReleaseBundleInspection = {
  rootPackageVersion: string
  targets: Array<{ label: string } & BundleInspection>
}

type TargetBundleChange = {
  label: string
  previous: BundleAnalysis
  current: BundleAnalysis
}

export function extractVersionFromTag(tag: string) {
  return tag.match(TAG_VERSION_PATTERN)?.[1] ?? null
}

function createByteFormatter(decimals = BYTE_DECIMALS) {
  return new Intl.NumberFormat("en-US", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  })
}

function formatBytes(bytes: number, decimals = BYTE_DECIMALS) {
  if (bytes < 1024) {
    return `${bytes} B`
  }

  const units = ["KB", "MB", "GB", "TB"]
  let value = bytes
  let unitIndex = -1

  do {
    value /= 1024
    unitIndex += 1
  } while (value >= 1024 && unitIndex < units.length - 1)

  return `${createByteFormatter(decimals).format(value)} ${units[unitIndex]}`
}

function formatDelta(delta: number) {
  if (delta === 0) return "no change"
  return `${delta > 0 ? "+" : "-"}${formatBytes(Math.abs(delta))}`
}

function truncateBundleLine(line: string) {
  if (line.length <= BUNDLE_SUMMARY_MAX_LENGTH) return line
  return `${line.slice(0, BUNDLE_SUMMARY_MAX_LENGTH - 3).trimEnd()}...`
}

function normalizeBundleSummary(line: string, deltaText: string) {
  const prefix = `Bundle ${deltaText} because `
  const singleLine = line.replace(/\s+/g, " ").trim()

  if (singleLine.toLowerCase().startsWith(prefix.toLowerCase())) {
    return truncateBundleLine(`${prefix}${singleLine.slice(prefix.length).trim()}`)
  }

  const reason = singleLine
    .replace(/^bundle\s+[-+]?\d[\d,.]*\s+[a-z]+\s+because\s+/i, "")
    .replace(/^because\s+/i, "")
    .trim()

  if (!reason) {
    throw new Error("Bundle summary reason must not be empty")
  }

  return truncateBundleLine(`${prefix}${reason}`)
}

function getTotalDelta(previous: BundleAnalysis, current: BundleAnalysis) {
  return current.total - previous.total
}

function isSignificantTargetChange(change: TargetBundleChange) {
  const delta = getTotalDelta(change.previous, change.current)
  return Math.abs(delta) > SIGNIFICANT_BUNDLE_DELTA_BYTES
}

function chooseBundleDelta(changes: TargetBundleChange[]) {
  const deltas = changes.map((change) => getTotalDelta(change.previous, change.current))

  if (deltas.length === 0) return 0

  const sameDirection = deltas.every((delta) => delta >= 0) || deltas.every((delta) => delta <= 0)
  if (sameDirection) {
    return Math.round(deltas.reduce((sum, delta) => sum + delta, 0) / deltas.length)
  }

  return deltas.reduce((largest, delta) => (Math.abs(delta) > Math.abs(largest) ? delta : largest), deltas[0]!)
}

const BUNDLE_METRICS: Array<{ label: string; key: BundleCategory; always?: boolean }> = [
  { label: "Total", key: "total", always: true },
  { label: "Bun runtime", key: "bunRuntime", always: true },
  { label: "CLI/TUI JS", key: "cliTuiJs" },
  { label: "Web UI assets", key: "webUiAssets" },
  { label: "Native addons", key: "nativeAddons" },
  { label: "WASM", key: "wasm" },
  { label: "Source maps", key: "sourceMaps" },
  { label: "Bytecode", key: "bytecode" },
  { label: "Module info", key: "moduleInfo" },
  { label: "Other embedded", key: "otherEmbedded" },
  { label: "Bundle metadata", key: "bundleMetadata" },
]

function getCategoryDeltas(change: TargetBundleChange) {
  return BUNDLE_METRICS
    .filter((metric) => metric.key !== "total")
    .map((metric) => ({
      label: metric.label,
      delta: change.current[metric.key] - change.previous[metric.key],
    }))
    .filter((item) => item.delta !== 0)
}

function buildBundleReason(changes: TargetBundleChange[]) {
  const categoryDeltas = new Map<string, number>()

  for (const change of changes) {
    for (const category of getCategoryDeltas(change)) {
      categoryDeltas.set(category.label, (categoryDeltas.get(category.label) ?? 0) + category.delta)
    }
  }

  const largestCategories = [...categoryDeltas.entries()]
    .map(([label, delta]) => ({ label, delta }))
    .sort((left, right) => Math.abs(right.delta) - Math.abs(left.delta))
    .slice(0, 2)

  if (largestCategories.length === 0) {
    return "compiled output changed across release targets"
  }

  return `mostly ${largestCategories.map((item) => `${item.label} ${formatDelta(item.delta)}`).join(" and ")}`
}

function parseTimestamp(timestamp: string | null | undefined) {
  if (!timestamp) return null
  const value = Date.parse(timestamp)
  return Number.isFinite(value) ? value : null
}

function buildPreviewSnapshotLine(packageName: string, snapshot: SnapshotInfo) {
  return `Preview snapshot: npm dev ${packageName}@${snapshot.version}`
}

function readFixedString(buffer: Buffer, offset: number, length: number) {
  if (offset < 0 || offset + length > buffer.length) {
    throw new Error(`Out-of-bounds string read at offset ${offset}`)
  }

  return buffer
    .subarray(offset, offset + length)
    .toString("utf8")
    .replace(/\0.*$/, "")
}

function getExtension(filepath: string) {
  const lastSlash = Math.max(filepath.lastIndexOf("/"), filepath.lastIndexOf("\\"))
  const lastDot = filepath.lastIndexOf(".")
  if (lastDot === -1 || lastDot < lastSlash) return ""
  return filepath.slice(lastDot).toLowerCase()
}

function parseTarEntries(buffer: Buffer) {
  const entries = new Map<string, Buffer>()

  for (let offset = 0; offset + 512 <= buffer.length; ) {
    const header = buffer.subarray(offset, offset + 512)
    if (header.every((byte) => byte === 0)) {
      break
    }

    const name = readFixedString(header, 0, 100)
    const sizeText = readFixedString(header, 124, 12).trim()
    const size = Number.parseInt(sizeText || "0", 8) || 0
    const dataStart = offset + 512
    const dataEnd = dataStart + size

    if (dataEnd > buffer.length) {
      throw new Error(`Tar entry ${name} extends past archive bounds`)
    }

    entries.set(name, buffer.subarray(dataStart, dataEnd))
    offset = dataStart + Math.ceil(size / 512) * 512
  }

  return entries
}

function extractBinaryFromTarball(tarball: Buffer) {
  const tar = gunzipSync(tarball)
  const entries = parseTarEntries(tar)
  const binary = [...entries.entries()].find(([name]) => /package\/bin\/opencode(\.exe)?$/.test(name))?.[1]

  if (!binary) {
    throw new Error("Could not find the compiled opencode binary in the npm tarball")
  }

  return binary
}

function classifyModule(module: BunModule) {
  const extension = getExtension(module.name)

  if (module.side === "server" && module.loader === "js") {
    return "cliTuiJs" as const
  }

  if (module.loader === "napi" || NATIVE_EXTENSIONS.has(extension)) {
    return "nativeAddons" as const
  }

  if (module.loader === "wasm" || extension === ".wasm") {
    return "wasm" as const
  }

  if (module.side === "client") {
    return "webUiAssets" as const
  }

  return "otherEmbedded" as const
}

function extractBunVersions(binary: Buffer) {
  const versions = new Set<string>()
  const needle = Buffer.from("Bun v")

  for (let offset = 0; ; ) {
    const hit = binary.indexOf(needle, offset)
    if (hit === -1) break

    const window = binary.subarray(hit, Math.min(hit + 64, binary.length)).toString("latin1")
    const match = /^Bun v([0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?)/.exec(window)
    if (match?.[1]) {
      versions.add(match[1])
    }

    offset = hit + needle.length
  }

  return [...versions].sort()
}

export function analyzeParsedBinary(totalLength: number, parsed: ParsedStandaloneBinary): BundleAnalysis {
  // byte_count is the embedded module-graph payload; everything else is the Bun runtime.
  const payloadSize = parsed.offsets.byte_count

  const analysis: BundleAnalysis = {
    total: totalLength,
    bunRuntime: totalLength - payloadSize,
    cliTuiJs: 0,
    webUiAssets: 0,
    nativeAddons: 0,
    wasm: 0,
    sourceMaps: 0,
    bytecode: 0,
    moduleInfo: 0,
    otherEmbedded: 0,
    bundleMetadata: 0,
  }

  for (const module of parsed.modules) {
    analysis.sourceMaps += module.sourcemap_length
    analysis.bytecode += module.bytecode_length
    analysis.moduleInfo += module.module_info_length
    analysis[classifyModule(module)] += module.contents_length
  }

  const bundleContentBytes =
    analysis.cliTuiJs +
    analysis.webUiAssets +
    analysis.nativeAddons +
    analysis.wasm +
    analysis.sourceMaps +
    analysis.bytecode +
    analysis.moduleInfo +
    analysis.otherEmbedded

  analysis.bundleMetadata = payloadSize - bundleContentBytes

  if (analysis.bunRuntime < 0 || analysis.bundleMetadata < 0) {
    throw new Error("Parsed an invalid standalone bundle breakdown")
  }

  return analysis
}

function analyzeStandaloneBinary(binary: Buffer): BundleAnalysis {
  return analyzeParsedBinary(binary.length, parseBuffer(binary))
}

function fetchSnapshotInfo(registry: NpmRegistryService, packageName: string, tag: string): Effect.Effect<SnapshotInfo | null, unknown> {
  return Effect.gen(function* () {
    const packument = yield* registry.packument(packageName)
    const version = packument["dist-tags"]?.[tag]
    if (!version) return null

    return {
      version,
      publishedAt: packument.time?.[version] ?? null,
    }
  })
}

function downloadBundleBinary(registry: NpmRegistryService, packageName: string, version: string): Effect.Effect<Buffer, unknown> {
  return Effect.gen(function* () {
    const metadata = yield* registry.versionMetadata(packageName, version)
    const tarballUrl = metadata.dist?.tarball

    if (!tarballUrl) {
      return yield* Effect.fail(new Error(`No tarball URL was published for ${packageName}@${version}`))
    }

    const tarball = yield* registry.downloadTarball(tarballUrl)
    return extractBinaryFromTarball(tarball)
  })
}

function inspectBundle(registry: NpmRegistryService, packageName: string, version: string): Effect.Effect<BundleInspection, unknown> {
  return Effect.gen(function* () {
    const binary = yield* downloadBundleBinary(registry, packageName, version)
    return {
      packageName,
      packageVersion: version,
      analysis: analyzeStandaloneBinary(binary),
      bunVersions: extractBunVersions(binary),
    }
  })
}

function scanBundleBunVersions(registry: NpmRegistryService, packageName: string, version: string): Effect.Effect<string[], unknown> {
  return Effect.gen(function* () {
    const binary = yield* downloadBundleBinary(registry, packageName, version)
    return extractBunVersions(binary)
  })
}

function inspectReleaseBundles(
  registry: NpmRegistryService,
  version: string,
  targets?: readonly BundleTarget[],
): Effect.Effect<ReleaseBundleInspection, unknown> {
  return Effect.gen(function* () {
    const packages = opencodeNpmPackagesForVersion(version)
    const rootMetadata = yield* registry.versionMetadata(packages.rootPackage, version)
    const inspectedTargets = yield* Effect.all(
      (targets ?? bundleTargetsFor(packages)).map((target) => Effect.gen(function* () {
        const packageVersion = rootMetadata.optionalDependencies?.[target.packageName]
        if (!packageVersion) {
          return yield* Effect.fail(new Error(`No optional dependency entry for ${target.packageName} in ${packages.rootPackage}@${version}`))
        }

        const inspection = yield* inspectBundle(registry, target.packageName, packageVersion)
        return {
          ...target,
          ...inspection,
        }
      })),
      { concurrency: "unbounded" },
    )

    return {
      rootPackageVersion: version,
      targets: inspectedTargets,
    }
  })
}

function buildBundleSizeSection(
  registry: NpmRegistryService,
  range: ReleaseRange,
): Effect.Effect<string | null, unknown> {
  return Effect.gen(function* () {
    if (!range.fromTag) {
      return null
    }

    const previousVersion = extractVersionFromTag(range.fromTag)

    if (!previousVersion) {
      return yield* Effect.fail(new Error(`Could not derive an npm version from ${range.fromTag}`))
    }

    const previousPackages = opencodeNpmPackagesForVersion(previousVersion)
    let currentPackages: OpencodeNpmPackages
    let currentVersion: string
    let previewSnapshot: SnapshotInfo | null = null

    if (range.kind === "preview") {
      // Preview snapshots are 0.0.0-dev builds, so they follow the baseline's package family.
      currentPackages = previousPackages
      previewSnapshot = yield* fetchSnapshotInfo(registry, currentPackages.rootPackage, "dev")
      if (!previewSnapshot) {
        return yield* Effect.fail(new Error(`${currentPackages.rootPackage} has no dev dist-tag for preview bundle analysis`))
      }

      const snapshotPublishedAt = parseTimestamp(previewSnapshot.publishedAt)
      const baselinePublishedAt = parseTimestamp(range.fromReleaseTimestamp ?? null)
      if (snapshotPublishedAt === null || baselinePublishedAt === null) {
        return yield* Effect.fail(new Error("Preview bundle analysis requires valid snapshot and baseline publish timestamps"))
      }

      if (snapshotPublishedAt < baselinePublishedAt) {
        return yield* Effect.fail(new Error(`${currentPackages.rootPackage}@dev is older than ${range.fromTag}`))
      }

      currentVersion = previewSnapshot.version
    } else {
      currentVersion = extractVersionFromTag(range.toTag) ?? ""
      if (!currentVersion) {
        return yield* Effect.fail(new Error(`Could not derive an npm version from ${range.toTag}`))
      }
      currentPackages = opencodeNpmPackagesForVersion(currentVersion)
    }

    const [previousRoot, currentRoot] = yield* Effect.all([
      registry.versionMetadata(previousPackages.rootPackage, previousVersion),
      registry.versionMetadata(currentPackages.rootPackage, currentVersion),
    ], { concurrency: "unbounded" })

    const previousTargets = bundleTargetsFor(previousPackages)
    const currentTargets = bundleTargetsFor(currentPackages)

    const targetChanges = yield* Effect.all(
      BUNDLE_PLATFORMS.map((target, index): Effect.Effect<TargetBundleChange, unknown> => Effect.gen(function* () {
        const previousTarget = previousTargets[index]!
        const currentTarget = currentTargets[index]!
        const previousTargetVersion = previousRoot.optionalDependencies?.[previousTarget.packageName] ?? null
        const currentTargetVersion = currentRoot.optionalDependencies?.[currentTarget.packageName] ?? null
        if (!previousTargetVersion) {
          return yield* Effect.fail(new Error(`No optional dependency entry for ${previousTarget.packageName} in ${previousPackages.rootPackage}@${previousVersion}`))
        }
        if (!currentTargetVersion) {
          return yield* Effect.fail(new Error(`No optional dependency entry for ${currentTarget.packageName} in ${currentPackages.rootPackage}@${currentVersion}`))
        }

        const [previousAnalysis, currentAnalysis] = yield* Effect.all([
          inspectBundle(registry, previousTarget.packageName, previousTargetVersion).pipe(Effect.map((item) => item.analysis)),
          inspectBundle(registry, currentTarget.packageName, currentTargetVersion).pipe(Effect.map((item) => item.analysis)),
        ], { concurrency: "unbounded" })

        return {
          label: target.label,
          previous: previousAnalysis,
          current: currentAnalysis,
        }
      })),
      { concurrency: "unbounded" },
    )

    const significantChanges = targetChanges.filter(isSignificantTargetChange)

    if (significantChanges.length === 0) {
      return "No noticeable bundle change"
    }

    const deltaText = formatDelta(chooseBundleDelta(significantChanges))
    return normalizeBundleSummary(`Bundle ${deltaText} because ${buildBundleReason(significantChanges)}`, deltaText)
  })
}

export type BundleSizeService = {
  readonly inspectBundle: (packageName: string, version: string) => Effect.Effect<BundleInspection, unknown>
  readonly scanBundleBunVersions: (packageName: string, version: string) => Effect.Effect<string[], unknown>
  readonly inspectReleaseBundles: (version: string, targets?: readonly BundleTarget[]) => Effect.Effect<ReleaseBundleInspection, unknown>
  readonly buildSection: (range: ReleaseRange) => Effect.Effect<string | null, unknown>
}

export class BundleSize extends Context.Service<BundleSize, BundleSizeService>()("app/BundleSize") {
  static readonly layer = Layer.effect(
    this,
    Effect.gen(function* () {
      const registry = yield* NpmRegistry

      return BundleSize.of({
        inspectBundle: (packageName, version) => inspectBundle(registry, packageName, version),
        scanBundleBunVersions: (packageName, version) => scanBundleBunVersions(registry, packageName, version),
        inspectReleaseBundles: (version, targets) => inspectReleaseBundles(registry, version, targets),
        buildSection: (range) => buildBundleSizeSection(registry, range),
      })
    }),
  ).pipe(
    Layer.provide(NpmRegistry.layer),
  )
}
