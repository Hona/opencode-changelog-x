import { describe, expect, test } from "bun:test"
import { bundleTargetsFor } from "../src/bundle-size.js"
import {
  OPENCODE_CLI_NPM_PACKAGES,
  OPENCODE_LEGACY_NPM_PACKAGES,
  opencodeNpmPackagesForVersion,
} from "../src/integrations/npm-registry.js"

describe("opencode npm package families", () => {
  test.each(["1.18.30", "v1.18.31", "1.0.0", "0.15.25"])("%s resolves to opencode-ai", (version) => {
    expect(opencodeNpmPackagesForVersion(version)).toBe(OPENCODE_LEGACY_NPM_PACKAGES)
  })

  test.each(["2.0.0", "v2.0.3", "2.1.0-beta.1", "3.0.0"])("%s resolves to @opencode/cli", (version) => {
    expect(opencodeNpmPackagesForVersion(version)).toBe(OPENCODE_CLI_NPM_PACKAGES)
  })

  test("rejects non-semver versions", () => {
    expect(() => opencodeNpmPackagesForVersion("latest")).toThrow("Version is not semver")
  })

  test("derives binary target package names per family", () => {
    expect(bundleTargetsFor(OPENCODE_LEGACY_NPM_PACKAGES).map((target) => target.packageName)).toEqual([
      "opencode-darwin-arm64",
      "opencode-linux-x64",
      "opencode-windows-x64",
    ])
    expect(bundleTargetsFor(OPENCODE_CLI_NPM_PACKAGES)).toEqual([
      { packageName: "@opencode/cli-darwin-arm64", label: "macOS arm64" },
      { packageName: "@opencode/cli-linux-x64", label: "Linux x64" },
      { packageName: "@opencode/cli-windows-x64", label: "Windows x64" },
    ])
  })
})
