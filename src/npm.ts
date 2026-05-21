import { gunzipSync } from "node:zlib"
import { z } from "zod"
import type { ReleaseRange } from "./types.js"

const OPENCODE_NPM_PACKAGE = "opencode-ai"
const NPM_METADATA_TIMEOUT_MS = 15_000
const NPM_TARBALL_TIMEOUT_MS = 5 * 60 * 1000
const TAG_VERSION_PATTERN = /(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)$/
const TRAILER = Buffer.from("\n---- Bun! ----\n")
const OFFSETS_SIZE = 32
// Bun's CompiledModuleGraphFile is six StringPointers followed by four u8 fields.
const MODULE_RECORD_SIZE = 52
const LEGACY_OFFSETS_SIZE = 24
const LEGACY_MODULE_RECORD_SIZE = 36
const BYTE_DECIMALS = 1
const SIGNIFICANT_BUNDLE_DELTA_BYTES = 1024 * 1024
const BUNDLE_SUMMARY_MAX_LENGTH = 240
const NATIVE_EXTENSIONS = new Set([".dll", ".dylib", ".node", ".so"])

const LOADER_NAMES = [
  "jsx",
  "js",
  "ts",
  "tsx",
  "css",
  "file",
  "json",
  "jsonc",
  "toml",
  "wasm",
  "napi",
  "base64",
  "dataurl",
  "text",
  "bunsh",
  "sqlite",
  "sqlite_embedded",
  "html",
  "yaml",
  "json5",
  "md",
] as const

export const BUNDLE_TARGETS = [
  { packageName: "opencode-darwin-arm64", label: "macOS arm64" },
  { packageName: "opencode-linux-x64", label: "Linux x64" },
  { packageName: "opencode-windows-x64", label: "Windows x64" },
] as const

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

type VersionMetadata = z.infer<typeof versionMetadataSchema>
type Packument = z.infer<typeof packumentSchema>
export type BundleTarget = (typeof BUNDLE_TARGETS)[number]
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

type StringPointer = {
  offset: number
  length: number
}

type ExtractedModuleGraph = {
  graphBytes: Buffer
  containerSize: number
}

type ParsedModule = {
  name: string
  contentsSize: number
  sourceMapSize: number
  bytecodeSize: number
  moduleInfoSize: number
  loader: string
  side: "server" | "client"
}

type ModuleGraphLayout = {
  offsetsSize: number
  moduleRecordSize: number
  bytecodePointerOffset: number
  moduleInfoPointerOffset: number | null
  loaderOffset: number
  sideOffset: number | null
}

const MODULE_GRAPH_LAYOUTS: ModuleGraphLayout[] = [
  {
    offsetsSize: OFFSETS_SIZE,
    moduleRecordSize: MODULE_RECORD_SIZE,
    bytecodePointerOffset: 24,
    moduleInfoPointerOffset: 32,
    loaderOffset: 49,
    sideOffset: 51,
  },
  {
    offsetsSize: OFFSETS_SIZE,
    moduleRecordSize: LEGACY_MODULE_RECORD_SIZE,
    bytecodePointerOffset: 24,
    moduleInfoPointerOffset: null,
    loaderOffset: 33,
    sideOffset: null,
  },
  {
    offsetsSize: LEGACY_OFFSETS_SIZE,
    moduleRecordSize: LEGACY_MODULE_RECORD_SIZE,
    bytecodePointerOffset: 24,
    moduleInfoPointerOffset: null,
    loaderOffset: 33,
    sideOffset: null,
  },
]

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

export type BundleChangeSummaryInput = {
  deltaText: string
  rawReport: string
}

export type BundleChangeSummarizer = (input: BundleChangeSummaryInput) => Promise<string>

type TargetBundleChange = {
  label: string
  previous: BundleAnalysis | null
  current: BundleAnalysis | null
}

function encodePackageName(packageName: string) {
  return packageName.startsWith("@") ? packageName.replace("/", "%2f") : packageName
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

  return truncateBundleLine(`${prefix}${reason || "compiled output changed across release targets"}`)
}

function getTotalDelta(previous: BundleAnalysis | null, current: BundleAnalysis | null) {
  if (previous && current) return current.total - previous.total
  if (current) return current.total
  if (previous) return -previous.total
  return null
}

function isSignificantTargetChange(change: TargetBundleChange) {
  const delta = getTotalDelta(change.previous, change.current)
  return delta !== null && Math.abs(delta) > SIGNIFICANT_BUNDLE_DELTA_BYTES
}

function chooseBundleDelta(changes: TargetBundleChange[]) {
  const deltas = changes
    .map((change) => getTotalDelta(change.previous, change.current))
    .filter((delta): delta is number => delta !== null)

  if (deltas.length === 0) return 0

  const sameDirection = deltas.every((delta) => delta >= 0) || deltas.every((delta) => delta <= 0)
  if (sameDirection) {
    return Math.round(deltas.reduce((sum, delta) => sum + delta, 0) / deltas.length)
  }

  return deltas.reduce((largest, delta) => (Math.abs(delta) > Math.abs(largest) ? delta : largest), deltas[0]!)
}

function formatMetric(label: string, previous: number | null, current: number | null) {
  if (previous !== null && current !== null) {
    return `• ${label}: ${formatBytes(previous)} -> ${formatBytes(current)} (${formatDelta(current - previous)})`
  }

  if (current !== null) {
    return `• ${label}: new ${formatBytes(current)}`
  }

  if (previous !== null) {
    return `• ${label}: removed (was ${formatBytes(previous)})`
  }

  return null
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
  if (!change.previous || !change.current) return []

  return BUNDLE_METRICS
    .filter((metric) => metric.key !== "total")
    .map((metric) => ({
      label: metric.label,
      delta: change.current![metric.key] - change.previous![metric.key],
    }))
    .filter((item) => item.delta !== 0)
}

function buildFallbackBundleReason(changes: TargetBundleChange[]) {
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

function buildSectionWithLines(lines: Array<string | null | undefined>) {
  return lines.filter((line): line is string => Boolean(line)).join("\n\n")
}

function buildPreviewSnapshotLine(snapshot: SnapshotInfo) {
  return `Preview snapshot: npm dev ${OPENCODE_NPM_PACKAGE}@${snapshot.version}`
}

function readU32(buffer: Buffer, offset: number) {
  if (offset < 0 || offset + 4 > buffer.length) {
    throw new Error(`Out-of-bounds u32 read at offset ${offset}`)
  }

  return buffer.readUInt32LE(offset)
}

function readU64(buffer: Buffer, offset: number) {
  if (offset < 0 || offset + 8 > buffer.length) {
    throw new Error(`Out-of-bounds u64 read at offset ${offset}`)
  }

  const value = buffer.readBigUInt64LE(offset)
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`Value at offset ${offset} exceeds JavaScript safe integer range`)
  }

  return Number(value)
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

function readTableString(table: Buffer, offset: number) {
  if (offset < 0 || offset >= table.length) return ""

  const end = table.indexOf(0, offset)
  return table.subarray(offset, end === -1 ? table.length : end).toString("utf8")
}

function readPointer(buffer: Buffer, offset: number): StringPointer {
  return {
    offset: readU32(buffer, offset),
    length: readU32(buffer, offset + 4),
  }
}

function slicePointer(buffer: Buffer, pointer: StringPointer) {
  if (pointer.length === 0) return Buffer.alloc(0)

  const end = pointer.offset + pointer.length
  if (pointer.offset < 0 || end > buffer.length) {
    throw new Error(`Out-of-bounds pointer slice at ${pointer.offset}+${pointer.length}`)
  }

  return buffer.subarray(pointer.offset, end)
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

function extractGraphFromPE(binary: Buffer): ExtractedModuleGraph | null {
  if (readFixedString(binary, 0, 2) !== "MZ") return null

  const peHeaderOffset = readU32(binary, 0x3c)
  if (readFixedString(binary, peHeaderOffset, 4) !== "PE\0\0") {
    throw new Error("Invalid PE signature while reading opencode bundle")
  }

  const numberOfSections = binary.readUInt16LE(peHeaderOffset + 6)
  const optionalHeaderSize = binary.readUInt16LE(peHeaderOffset + 20)
  const sectionHeadersOffset = peHeaderOffset + 24 + optionalHeaderSize

  for (let index = 0; index < numberOfSections; index += 1) {
    const offset = sectionHeadersOffset + index * 40
    const name = readFixedString(binary, offset, 8)
    if (name !== ".bun") continue

    const rawSize = readU32(binary, offset + 16)
    const rawOffset = readU32(binary, offset + 20)
    const graphLength = readU64(binary, rawOffset)
    const graphStart = rawOffset + 8
    const graphEnd = graphStart + graphLength

    if (graphEnd > binary.length) {
      throw new Error("The PE .bun section extends past the binary bounds")
    }

    return {
      graphBytes: binary.subarray(graphStart, graphEnd),
      containerSize: rawSize,
    }
  }

  throw new Error("The PE binary does not contain a .bun section")
}

function extractGraphFromMachO(binary: Buffer): ExtractedModuleGraph | null {
  if (readU32(binary, 0) !== 0xfeedfacf) return null

  const numberOfCommands = readU32(binary, 16)
  let offset = 32

  for (let index = 0; index < numberOfCommands; index += 1) {
    const command = readU32(binary, offset)
    const commandSize = readU32(binary, offset + 4)

    if (commandSize < 8) {
      throw new Error("Encountered an invalid Mach-O load command")
    }

    if (command === 0x19) {
      const segmentName = readFixedString(binary, offset + 8, 16)
      const fileSize = readU64(binary, offset + 48)
      const sectionCount = readU32(binary, offset + 64)

      if (segmentName === "__BUN") {
        let sectionOffset = offset + 72

        for (let sectionIndex = 0; sectionIndex < sectionCount; sectionIndex += 1) {
          const sectionName = readFixedString(binary, sectionOffset, 16)
          const sectionSegment = readFixedString(binary, sectionOffset + 16, 16)

          if (sectionSegment === "__BUN" && sectionName === "__bun") {
            const fileOffset = readU32(binary, sectionOffset + 48)
            const graphLength = readU64(binary, fileOffset)
            const graphStart = fileOffset + 8
            const graphEnd = graphStart + graphLength

            if (graphEnd > binary.length) {
              throw new Error("The Mach-O __BUN section extends past the binary bounds")
            }

            return {
              graphBytes: binary.subarray(graphStart, graphEnd),
              containerSize: fileSize,
            }
          }

          sectionOffset += 80
        }
      }
    }

    offset += commandSize
  }

  throw new Error("The Mach-O binary does not contain a __BUN/__bun section")
}

function extractGraphFromElf(binary: Buffer): ExtractedModuleGraph | null {
  if (readFixedString(binary, 0, 4) !== "\u007fELF") return null
  if (binary[4] !== 2 || binary[5] !== 1) {
    throw new Error("Only 64-bit little-endian ELF binaries are supported")
  }

  const programHeaderOffset = readU64(binary, 32)
  const sectionHeaderOffset = readU64(binary, 40)
  const programHeaderEntrySize = binary.readUInt16LE(54)
  const programHeaderCount = binary.readUInt16LE(56)
  const sectionHeaderEntrySize = binary.readUInt16LE(58)
  const sectionHeaderCount = binary.readUInt16LE(60)
  const sectionNameTableIndex = binary.readUInt16LE(62)

  const sectionNameHeaderOffset = sectionHeaderOffset + sectionNameTableIndex * sectionHeaderEntrySize
  const sectionNameTableOffset = readU64(binary, sectionNameHeaderOffset + 24)
  const sectionNameTableSize = readU64(binary, sectionNameHeaderOffset + 32)
  const sectionNameTable = binary.subarray(sectionNameTableOffset, sectionNameTableOffset + sectionNameTableSize)

  for (let index = 0; index < sectionHeaderCount; index += 1) {
    const headerOffset = sectionHeaderOffset + index * sectionHeaderEntrySize
    const nameOffset = readU32(binary, headerOffset)
    const name = readTableString(sectionNameTable, nameOffset)
    if (name !== ".bun") continue

    const sectionOffset = readU64(binary, headerOffset + 24)
    const sectionSize = readU64(binary, headerOffset + 32)
    const graphLength = readU64(binary, sectionOffset)
    const graphStart = sectionOffset + 8
    const graphEnd = graphStart + graphLength

    if (graphEnd > binary.length) {
      throw new Error("The ELF .bun section extends past the binary bounds")
    }

    let containerSize = sectionSize
    for (let programIndex = 0; programIndex < programHeaderCount; programIndex += 1) {
      const header = programHeaderOffset + programIndex * programHeaderEntrySize
      const type = readU32(binary, header)
      const fileOffset = readU64(binary, header + 8)
      if (type !== 1 || fileOffset !== sectionOffset) continue
      containerSize = readU64(binary, header + 32)
      break
    }

    return {
      graphBytes: binary.subarray(graphStart, graphEnd),
      containerSize,
    }
  }

  throw new Error("The ELF binary does not contain a .bun section")
}

function extractGraphFromTrailer(binary: Buffer): ExtractedModuleGraph | null {
  const trailerOffset = binary.lastIndexOf(TRAILER)
  if (trailerOffset === -1) return null

  let graphStart: number | null = null

  for (const offsetsSize of [OFFSETS_SIZE, LEGACY_OFFSETS_SIZE]) {
    const offsetsStart = trailerOffset - offsetsSize
    if (offsetsStart < 8) continue

    const byteCount = readU64(binary, offsetsStart)
    if (byteCount > offsetsStart) continue

    graphStart = offsetsStart - byteCount
    break
  }

  if (graphStart === null) {
    throw new Error("The Bun bundle trailer points outside the binary")
  }

  const graphEnd = trailerOffset + TRAILER.length
  let containerSize = graphEnd - graphStart

  // Older Bun builds append the graph blob and finish with a final u64 equal to
  // the full file size. Treat that trailing footer as part of the bundle area.
  if (binary.length >= 8) {
    const trailingValue = binary.readBigUInt64LE(binary.length - 8)
    if (trailingValue <= BigInt(Number.MAX_SAFE_INTEGER) && Number(trailingValue) === binary.length) {
      containerSize += 8
    }
  }

  return {
    graphBytes: binary.subarray(graphStart, graphEnd),
    containerSize,
  }
}

function extractStandaloneModuleGraph(binary: Buffer) {
  const candidates = [extractGraphFromPE, extractGraphFromMachO, extractGraphFromElf] as const

  for (const extract of candidates) {
    try {
      const result = extract(binary)
      if (result) return result
    } catch {
      break
    }
  }

  return extractGraphFromTrailer(binary) ?? (() => {
    throw new Error("Unsupported executable format while analyzing the compiled bundle")
  })()
}

function parseModuleGraphWithLayout(graphBytes: Buffer, layout: ModuleGraphLayout) {
  const trailerOffset = graphBytes.length - TRAILER.length
  const offsetsStart = trailerOffset - layout.offsetsSize
  if (offsetsStart < 8) {
    throw new Error("The Bun module graph offsets are out of bounds")
  }

  const byteCount = readU64(graphBytes, offsetsStart)
  if (byteCount > offsetsStart) {
    throw new Error("The Bun module graph offsets point outside the payload")
  }

  const payload = graphBytes.subarray(0, byteCount)
  const modulesPointer = readPointer(graphBytes, offsetsStart + 8)
  const modulesBytes = slicePointer(payload, modulesPointer)

  if (modulesBytes.length % layout.moduleRecordSize !== 0) {
    throw new Error("The Bun module table has an unexpected size")
  }

  const modules: ParsedModule[] = []
  for (let offset = 0; offset < modulesBytes.length; offset += layout.moduleRecordSize) {
    const record = modulesBytes.subarray(offset, offset + layout.moduleRecordSize)
    const namePointer = readPointer(record, 0)
    const contentsPointer = readPointer(record, 8)
    const sourceMapPointer = readPointer(record, 16)
    const bytecodePointer = readPointer(record, layout.bytecodePointerOffset)
    const moduleInfoPointer =
      layout.moduleInfoPointerOffset !== null ? readPointer(record, layout.moduleInfoPointerOffset) : null

    modules.push({
      name: slicePointer(payload, namePointer).toString("utf8").replace(/\0$/, ""),
      contentsSize: contentsPointer.length,
      sourceMapSize: sourceMapPointer.length,
      bytecodeSize: bytecodePointer.length,
      moduleInfoSize: moduleInfoPointer?.length ?? 0,
      loader: LOADER_NAMES[record.readUInt8(layout.loaderOffset)] ?? `loader#${record.readUInt8(layout.loaderOffset)}`,
      side: layout.sideOffset !== null && record.readUInt8(layout.sideOffset) === 1 ? "client" : "server",
    })
  }

  return modules
}

function parseModuleGraph(graphBytes: Buffer) {
  if (graphBytes.length < LEGACY_OFFSETS_SIZE + TRAILER.length) {
    throw new Error("The Bun module graph is too small to be valid")
  }

  const trailerOffset = graphBytes.length - TRAILER.length
  if (!graphBytes.subarray(trailerOffset).equals(TRAILER)) {
    throw new Error("The Bun module graph is missing its expected trailer")
  }

  let lastError: Error | null = null

  for (const layout of MODULE_GRAPH_LAYOUTS) {
    try {
      return parseModuleGraphWithLayout(graphBytes, layout)
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error))
    }
  }

  throw lastError ?? new Error("Could not parse the Bun module graph")
}

function classifyModule(module: ParsedModule) {
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

function analyzeStandaloneBinary(binary: Buffer): BundleAnalysis {
  const extracted = extractStandaloneModuleGraph(binary)
  const modules = parseModuleGraph(extracted.graphBytes)

  const analysis: BundleAnalysis = {
    total: binary.length,
    bunRuntime: binary.length - extracted.containerSize,
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

  for (const module of modules) {
    analysis.sourceMaps += module.sourceMapSize
    analysis.bytecode += module.bytecodeSize
    analysis.moduleInfo += module.moduleInfoSize
    analysis[classifyModule(module)] += module.contentsSize
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

  analysis.bundleMetadata = extracted.containerSize - bundleContentBytes

  if (analysis.bunRuntime < 0 || analysis.bundleMetadata < 0) {
    throw new Error("Parsed an invalid standalone bundle breakdown")
  }

  return analysis
}

async function fetchVersionMetadata(packageName: string, version: string): Promise<VersionMetadata> {
  const response = await fetch(`https://registry.npmjs.org/${encodePackageName(packageName)}/${version}`, {
    headers: {
      Accept: "application/json",
      "User-Agent": "opencode-changelog-x",
    },
    signal: AbortSignal.timeout(NPM_METADATA_TIMEOUT_MS),
  })

  if (!response.ok) {
    throw new Error(`NPM package request failed for ${packageName}@${version} (${response.status} ${response.statusText})`)
  }

  return versionMetadataSchema.parse(await response.json())
}

async function fetchPackument(packageName: string): Promise<Packument> {
  const response = await fetch(`https://registry.npmjs.org/${encodePackageName(packageName)}`, {
    headers: {
      Accept: "application/json",
      "User-Agent": "opencode-changelog-x",
    },
    signal: AbortSignal.timeout(NPM_METADATA_TIMEOUT_MS),
  })

  if (!response.ok) {
    throw new Error(`NPM packument request failed for ${packageName} (${response.status} ${response.statusText})`)
  }

  return packumentSchema.parse(await response.json())
}

async function fetchSnapshotInfo(packageName: string, tag: string): Promise<SnapshotInfo | null> {
  const packument = await fetchPackument(packageName)
  const version = packument["dist-tags"]?.[tag]
  if (!version) return null

  return {
    version,
    publishedAt: packument.time?.[version] ?? null,
  }
}

async function downloadTarball(url: string) {
  const response = await fetch(url, {
    headers: {
      "User-Agent": "opencode-changelog-x",
    },
    signal: AbortSignal.timeout(NPM_TARBALL_TIMEOUT_MS),
  })

  if (!response.ok) {
    throw new Error(`NPM tarball request failed (${response.status} ${response.statusText}) for ${url}`)
  }

  return Buffer.from(await response.arrayBuffer())
}

async function downloadBundleBinary(packageName: string, version: string) {
  const metadata = await fetchVersionMetadata(packageName, version)
  const tarballUrl = metadata.dist?.tarball

  if (!tarballUrl) {
    throw new Error(`No tarball URL was published for ${packageName}@${version}`)
  }

  const tarball = await downloadTarball(tarballUrl)
  return extractBinaryFromTarball(tarball)
}

export async function inspectBundle(packageName: string, version: string): Promise<BundleInspection> {
  const binary = await downloadBundleBinary(packageName, version)
  return {
    packageName,
    packageVersion: version,
    analysis: analyzeStandaloneBinary(binary),
    bunVersions: extractBunVersions(binary),
  }
}

export async function scanBundleBunVersions(packageName: string, version: string) {
  const binary = await downloadBundleBinary(packageName, version)
  return extractBunVersions(binary)
}

export async function inspectReleaseBundles(
  version: string,
  targets: readonly BundleTarget[] = BUNDLE_TARGETS,
): Promise<ReleaseBundleInspection> {
  const rootMetadata = await fetchVersionMetadata(OPENCODE_NPM_PACKAGE, version)
  const inspectedTargets = await Promise.all(
    targets.map(async (target) => {
      const packageVersion = rootMetadata.optionalDependencies?.[target.packageName]
      if (!packageVersion) {
        throw new Error(`No optional dependency entry for ${target.packageName} in ${OPENCODE_NPM_PACKAGE}@${version}`)
      }

      const inspection = await inspectBundle(target.packageName, packageVersion)
      return {
        ...target,
        ...inspection,
      }
    }),
  )

  return {
    rootPackageVersion: version,
    targets: inspectedTargets,
  }
}

function formatTargetSection(label: string, previous: BundleAnalysis | null, current: BundleAnalysis | null) {
  if (!previous && !current) return null

  const lines = BUNDLE_METRICS
    .map(({ label: metricLabel, key, always }) => {
      const previousValue = previous?.[key] ?? null
      const currentValue = current?.[key] ?? null
      if (!always && previousValue === 0 && currentValue === 0) {
        return null
      }
      return formatMetric(metricLabel, previousValue, currentValue)
    })
    .filter((line): line is string => Boolean(line))

  if (lines.length === 0) return null

  return [label, ...lines].join("\n")
}

export async function buildBundleSizeSection(
  range: ReleaseRange,
  summarizeChange?: BundleChangeSummarizer,
): Promise<string | null> {
  if (!range.fromTag) {
    return null
  }

  const previousVersion = extractVersionFromTag(range.fromTag)

  if (!previousVersion) {
    throw new Error(`Could not derive an npm version from ${range.fromTag}`)
  }

  let currentVersion: string
  let previewSnapshot: SnapshotInfo | null = null

  if (range.kind === "preview") {
    previewSnapshot = await fetchSnapshotInfo(OPENCODE_NPM_PACKAGE, "dev")
    if (!previewSnapshot) {
      return null
    }

    const snapshotPublishedAt = parseTimestamp(previewSnapshot.publishedAt)
    const baselinePublishedAt = parseTimestamp(range.fromReleaseTimestamp ?? null)
    if (snapshotPublishedAt === null || baselinePublishedAt === null) {
      return null
    }

    if (snapshotPublishedAt < baselinePublishedAt) {
      return null
    }

    currentVersion = previewSnapshot.version
  } else {
    currentVersion = extractVersionFromTag(range.toTag) ?? ""
  }

  if (!currentVersion) {
    throw new Error(`Could not derive an npm version from ${range.toTag}`)
  }

  const [previousRoot, currentRoot] = await Promise.all([
    fetchVersionMetadata(OPENCODE_NPM_PACKAGE, previousVersion),
    fetchVersionMetadata(OPENCODE_NPM_PACKAGE, currentVersion),
  ])

  const targetChanges = await Promise.all(
    BUNDLE_TARGETS.map(async (target): Promise<TargetBundleChange> => {
      const previousTargetVersion = previousRoot.optionalDependencies?.[target.packageName] ?? null
      const currentTargetVersion = currentRoot.optionalDependencies?.[target.packageName] ?? null

      const [previousAnalysis, currentAnalysis] = await Promise.all([
        previousTargetVersion ? inspectBundle(target.packageName, previousTargetVersion).then((item) => item.analysis) : Promise.resolve(null),
        currentTargetVersion ? inspectBundle(target.packageName, currentTargetVersion).then((item) => item.analysis) : Promise.resolve(null),
      ])

      return {
        label: target.label,
        previous: previousAnalysis,
        current: currentAnalysis,
      }
    }),
  )

  const significantChanges = targetChanges.filter(isSignificantTargetChange)

  if (significantChanges.length === 0) {
    return "No noticeable bundle change"
  }

  const deltaText = formatDelta(chooseBundleDelta(significantChanges))
  const rawReport = buildSectionWithLines([
    `Required output prefix: Bundle ${deltaText} because`,
    previewSnapshot ? buildPreviewSnapshotLine(previewSnapshot) : null,
    ...significantChanges
      .map((change) => formatTargetSection(change.label, change.previous, change.current))
      .filter((section): section is string => Boolean(section)),
  ])

  if (summarizeChange) {
    try {
      return normalizeBundleSummary(await summarizeChange({ deltaText, rawReport }), deltaText)
    } catch (error) {
      console.warn(`Falling back to deterministic bundle summary: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  return normalizeBundleSummary(`Bundle ${deltaText} because ${buildFallbackBundleReason(significantChanges)}`, deltaText)
}
