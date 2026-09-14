import { describe, expect, test } from "bun:test"
import { compareVersionStrings, majorOf, parseSemver, semverFromString } from "../src/domain/semver.js"

describe("semver", () => {
  test("parses tags with and without a v prefix", () => {
    expect(parseSemver("v1.18.30")).toEqual({ major: 1, minor: 18, patch: 30, prerelease: [] })
    expect(parseSemver("2.0.3")).toEqual({ major: 2, minor: 0, patch: 3, prerelease: [] })
    expect(parseSemver("v2.1.0-beta.1+build.7")).toEqual({ major: 2, minor: 1, patch: 0, prerelease: ["beta", "1"] })
  })

  test.each(["pr-38252-videos", "vscode-v0.0.1", "latest", "v1.2"])("rejects %s", (value) => {
    expect(parseSemver(value)).toBeNull()
    expect(() => semverFromString(value)).toThrow("Version is not semver")
  })

  test("orders by numeric components, not by string or timestamp", () => {
    const sorted = ["v2.0.3", "v1.18.31", "v1.18.9", "v2.0.0", "v1.18.30", "v1.9.0"].sort(compareVersionStrings)
    expect(sorted).toEqual(["v1.9.0", "v1.18.9", "v1.18.30", "v1.18.31", "v2.0.0", "v2.0.3"])
  })

  test("ranks prereleases below the final version", () => {
    expect(compareVersionStrings("v2.1.0-beta.1", "v2.1.0")).toBeLessThan(0)
    expect(compareVersionStrings("v2.1.0-beta.1", "v2.0.3")).toBeGreaterThan(0)
    expect(compareVersionStrings("v2.1.0-beta.2", "v2.1.0-beta.10")).toBeLessThan(0)
    expect(compareVersionStrings("v2.1.0-alpha", "v2.1.0-beta")).toBeLessThan(0)
    expect(compareVersionStrings("v2.1.0-beta", "v2.1.0-beta.1")).toBeLessThan(0)
    expect(compareVersionStrings("v1.0.0", "1.0.0")).toBe(0)
  })

  test("reads the major version line", () => {
    expect(majorOf("v1.18.30")).toBe(1)
    expect(majorOf("v2.0.0")).toBe(2)
  })
})
