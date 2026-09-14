import { describe, expect, test } from "bun:test"
import type { BunModule } from "unbunjs"
import { analyzeParsedBinary, type ParsedStandaloneBinary } from "../src/bundle-size.js"

function fakeModule(index: number, overrides: Partial<BunModule>): BunModule {
  return {
    index,
    name: `/$bunfs/root/module-${index}`,
    contents_offset: 0,
    contents_length: 0,
    sourcemap_length: 0,
    bytecode_length: 0,
    module_info_length: 0,
    bytecode_origin_path: "",
    encoding: "latin1",
    loader: "js",
    module_format: "esm",
    side: "server",
    is_entry_point: false,
    ...overrides,
  }
}

function fakeParsed(byteCount: number, modules: BunModule[]): ParsedStandaloneBinary {
  return {
    offsets: {
      byte_count: byteCount,
      modules_ptr: { offset: 0, length: modules.length * 52 },
      entry_point_id: 0,
      compile_exec_argv_ptr: { offset: 0, length: 0 },
      flags: 0,
      module_entry_size: 52,
    },
    modules,
  }
}

const MODULES = [
  fakeModule(0, {
    name: "/$bunfs/root/src/index.js",
    contents_length: 1_000,
    bytecode_length: 700,
    module_info_length: 50,
    sourcemap_length: 300,
    is_entry_point: true,
  }),
  fakeModule(1, {
    name: "/$bunfs/root/dist/web/index.html",
    contents_length: 2_000,
    loader: "file",
    module_format: "none",
    side: "client",
    encoding: "binary",
  }),
  fakeModule(2, {
    name: "/$bunfs/root/node_modules/pty/pty.win32-x64-msvc.node",
    contents_length: 4_000,
    loader: "napi",
    module_format: "none",
    encoding: "binary",
  }),
  fakeModule(3, {
    name: "/$bunfs/root/node_modules/tree-sitter/tree-sitter.wasm",
    contents_length: 8_000,
    loader: "wasm",
    module_format: "none",
    encoding: "binary",
  }),
  fakeModule(4, {
    name: "/$bunfs/root/src/prompt.txt",
    contents_length: 16_000,
    loader: "text",
    module_format: "none",
  }),
]

const CONTENT_BYTES = 1_000 + 700 + 50 + 300 + 2_000 + 4_000 + 8_000 + 16_000
const METADATA_BYTES = 1_234
const PAYLOAD_BYTES = CONTENT_BYTES + METADATA_BYTES
const TOTAL_BYTES = PAYLOAD_BYTES + 100_000

describe("analyzeParsedBinary", () => {
  test("splits the payload into categories and attributes the remainder to the runtime", () => {
    expect(analyzeParsedBinary(TOTAL_BYTES, fakeParsed(PAYLOAD_BYTES, MODULES))).toEqual({
      total: TOTAL_BYTES,
      bunRuntime: 100_000,
      cliTuiJs: 1_000,
      webUiAssets: 2_000,
      nativeAddons: 4_000,
      wasm: 8_000,
      sourceMaps: 300,
      bytecode: 700,
      moduleInfo: 50,
      otherEmbedded: 16_000,
      bundleMetadata: METADATA_BYTES,
    })
  })

  test("classifies native addons and wasm by extension when the loader is generic", () => {
    const modules = [
      fakeModule(0, { name: "/$bunfs/root/addon.dll", contents_length: 10, loader: "file", side: "client" }),
      fakeModule(1, { name: "/$bunfs/root/lib.dylib", contents_length: 20, loader: "file" }),
      fakeModule(2, { name: "/$bunfs/root/module.wasm", contents_length: 40, loader: "file", side: "client" }),
    ]

    const analysis = analyzeParsedBinary(1_000, fakeParsed(70, modules))
    expect(analysis.nativeAddons).toBe(30)
    expect(analysis.wasm).toBe(40)
    expect(analysis.webUiAssets).toBe(0)
    expect(analysis.bundleMetadata).toBe(0)
  })

  test("treats non-js server modules as other embedded content", () => {
    const modules = [
      fakeModule(0, { name: "/$bunfs/root/config.json", contents_length: 5, loader: "json" }),
      fakeModule(1, { name: "/$bunfs/root/app.js", contents_length: 7, loader: "js", side: "client" }),
    ]

    const analysis = analyzeParsedBinary(100, fakeParsed(12, modules))
    expect(analysis.otherEmbedded).toBe(5)
    expect(analysis.webUiAssets).toBe(7)
    expect(analysis.cliTuiJs).toBe(0)
  })

  test("rejects payloads that do not fit the binary", () => {
    expect(() => analyzeParsedBinary(10, fakeParsed(20, []))).toThrow("Parsed an invalid standalone bundle breakdown")
  })

  test("rejects module content that exceeds the payload", () => {
    const modules = [fakeModule(0, { contents_length: 50 })]
    expect(() => analyzeParsedBinary(1_000, fakeParsed(40, modules))).toThrow("Parsed an invalid standalone bundle breakdown")
  })
})
