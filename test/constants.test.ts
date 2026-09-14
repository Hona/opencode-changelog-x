import { describe, expect, test } from "bun:test"
import { MODEL, PREVIEW_MODEL } from "../src/constants.js"

describe("generation models", () => {
  test("uses GPT 6 Astra with high reasoning for published tweets", () => {
    expect(MODEL).toEqual({
      providerID: "opencode",
      modelID: "gpt-6-astra",
      variant: "high",
    })
  })

  test("uses GPT 6 Astra with low reasoning for previews", () => {
    expect(PREVIEW_MODEL).toEqual({
      providerID: "opencode",
      modelID: "gpt-6-astra",
      variant: "low",
    })
  })
})
