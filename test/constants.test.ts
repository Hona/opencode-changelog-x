import { describe, expect, test } from "bun:test"
import { MODEL, PREVIEW_MODEL } from "../src/constants.js"

describe("generation models", () => {
  test("uses Claude Opus 5.5 with high reasoning for published tweets", () => {
    expect(MODEL).toEqual({
      providerID: "opencode",
      modelID: "claude-opus-5-5",
      variant: "high",
    })
  })

  test("uses Claude Opus 5.5 with high reasoning for previews", () => {
    expect(PREVIEW_MODEL).toEqual({
      providerID: "opencode",
      modelID: "claude-opus-5-5",
      variant: "high",
    })
  })
})
