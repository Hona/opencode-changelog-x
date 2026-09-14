import { describe, expect, test } from "bun:test"
import { READ_ONLY_PERMISSIONS, buildGenerationPrompt, describeError, describePromptResult, extractText } from "../src/generate.js"
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

describe("read-only permissions", () => {
  test("deny everything first, then allow only inspection tools and git", () => {
    expect(READ_ONLY_PERMISSIONS[0]).toEqual({ action: "*", resource: "*", effect: "deny" })
    for (const rule of READ_ONLY_PERMISSIONS.slice(1)) {
      expect(rule.effect).toBe("allow")
      expect(["read", "grep", "glob", "shell"]).toContain(rule.action)
    }
    expect(READ_ONLY_PERMISSIONS).toContainEqual({ action: "shell", resource: "git *", effect: "allow" })
    expect(READ_ONLY_PERMISSIONS.some((rule) => rule.action === "edit" && rule.effect === "allow")).toBe(false)
  })
})

describe("session context extraction", () => {
  const messages = [
    { id: "msg_1", type: "user", text: "first question", time: { created: 1 } },
    { id: "msg_2", type: "assistant", model: { providerID: "opencode", id: "gpt-6-astra", variant: "high" }, content: [{ type: "text", text: "old answer" }], finish: "stop" },
    { id: "msg_3", type: "user", text: "second question", time: { created: 3 } },
    { id: "msg_4", type: "assistant", model: { providerID: "opencode", id: "gpt-6-astra", variant: "high" }, content: [{ type: "tool", id: "call_1", name: "shell", state: { status: "completed" } }], finish: "tool-calls" },
    { id: "msg_5", type: "assistant", model: { providerID: "opencode", id: "gpt-6-astra", variant: "high" }, content: [{ type: "reasoning", text: "thinking" }, { type: "text", text: " {\"post\":\"hi\"} " }], finish: "stop", tokens: { input: 1, output: 2, reasoning: 0, cache: { read: 0, write: 0 } } },
    { id: "msg_6", type: "idle", outcome: "succeeded" },
  ]

  test("returns the text of the last assistant message after the last user message", () => {
    expect(extractText(messages)).toBe("{\"post\":\"hi\"}")
    expect(extractText(messages.slice(0, 4))).toBeUndefined()
    expect(extractText([])).toBeUndefined()
    expect(extractText(undefined)).toBeUndefined()
  })

  test("describes the answering assistant message", () => {
    const description = describePromptResult(messages)
    expect(description).toContain("messages=6")
    expect(description).toContain("message=msg_5")
    expect(description).toContain("finish=stop")
    expect(description).toContain("model=opencode/gpt-6-astra")
    expect(description).toContain("variant=high")
    expect(description).toContain("content=reasoning(8), text(13)")
    expect(describePromptResult(messages.slice(0, 4))).toContain("content=tool:shell")
    expect(describePromptResult([])).toContain("message=none")
  })
})

describe("describeError", () => {
  test("unwraps nested causes", () => {
    const timeout = new Error("The operation timed out.")
    timeout.name = "TimeoutError"
    expect(describeError(new Error("Transport", { cause: timeout }))).toBe("Transport (The operation timed out.)")
    expect(describeError(new Error("UnexpectedStatus", { cause: { status: 404 } }))).toBe('UnexpectedStatus ({"status":404})')
    expect(describeError("plain")).toBe("plain")
    expect(describeError({ code: 1 })).toBe('{"code":1}')
  })
})
