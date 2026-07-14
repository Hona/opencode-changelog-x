import { describe, expect, test } from "bun:test"
import { buildGenerationPrompt } from "../src/generate.js"
import type { ReleaseRange } from "../src/domain/releases.js"
import { gitRefFromString, releaseTagFromString, urlStringFromString } from "../src/domain/value-objects.js"

const range: ReleaseRange = {
  kind: "preview",
  release: null,
  fromTag: releaseTagFromString("v1.17.20"),
  toTag: gitRefFromString("HEAD"),
  toLabel: "HEAD (abc1234)",
  compareUrl: urlStringFromString("https://github.com/anomalyco/opencode/compare/v1.17.20...HEAD"),
  repoDir: "/repo",
}

describe("generation prompt taxonomy", () => {
  test("merges browser and desktop surfaces into App and adds Data", () => {
    const prompt = buildGenerationPrompt(range)

    expect(prompt).toContain("- App: local browser UI, Electron desktop shell")
    expect(prompt).toContain("- Data: OpenCode Data and the stats site")
    expect(prompt).not.toContain("- Desktop:")
    expect(prompt).toContain("Data -> 𝗗𝗮𝘁𝗮")
    expect(prompt).not.toContain("Desktop ->")
    expect(prompt).not.toContain("𝗗𝗲𝘀𝗸𝘁𝗼𝗽")
    expect(prompt).toContain("use Data instead of Console for OpenCode Data and stats changes")
  })

  test("prioritizes TUI and App headings before all others", () => {
    const prompt = buildGenerationPrompt(range)

    expect(prompt).toContain("If present, TUI and App must be the first product headings")
    expect(prompt).toContain("Order TUI and App by your perceived importance")
    expect(prompt).toContain("Order all remaining product headings by your perceived importance")
    expect(prompt).not.toContain("TUI must be the first product heading")
  })
})
