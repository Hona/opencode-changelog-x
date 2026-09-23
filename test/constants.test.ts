import { describe, expect, test } from "bun:test"
import { MODEL, PREVIEW_MODEL } from "../src/constants.js"

describe("generation models", () => {
  test("uses Gemini 3.8 Flash with high reasoning for published tweets", () => {
    expect(MODEL).toEqual({
      providerID: "opencode",
      modelID: "gemini-3.8-flash",
      variant: "high",
    })
  })

  test("uses Gemini 3.8 Flash with high reasoning for previews", () => {
    expect(PREVIEW_MODEL).toEqual({
      providerID: "opencode",
      modelID: "gemini-3.8-flash",
      variant: "high",
    })
  })
})
