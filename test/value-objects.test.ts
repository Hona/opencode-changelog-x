import { describe, expect, test } from "bun:test"
import { isReleaseTag, releaseTagFromString } from "../src/domain/value-objects.js"

describe("release tags", () => {
  test.each([
    "v1.18.5",
    "1.18.5",
    "v1.18.5-beta.1",
    "v1.18.5+build.1",
  ])("accepts semver tag %s", (tag) => {
    expect(isReleaseTag(tag)).toBe(true)
    expect(releaseTagFromString(tag)).toBe(tag)
  })

  test.each([
    "pr-37967-screenshots-v2",
    "pr-38252-videos",
    "latest",
  ])("rejects non-semver tag %s", (tag) => {
    expect(isReleaseTag(tag)).toBe(false)
    expect(() => releaseTagFromString(tag)).toThrow("Release tag must be a semver tag")
  })
})
