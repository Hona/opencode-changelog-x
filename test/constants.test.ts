import { describe, expect, test } from "bun:test"
import { MODEL, PREVIEW_MODEL } from "../src/constants.js"

describe("generation models", () => {
  test("uses GPT 5.6 Sol with xhigh reasoning for published tweets", () => {
    expect(MODEL).toEqual({
      providerID: "opencode",
      modelID: "gpt-5.6-sol",
      variant: "xhigh",
    })
  })

  test("uses GPT 5.6 Sol with low reasoning for previews", () => {
    expect(PREVIEW_MODEL).toEqual({
      providerID: "opencode",
      modelID: "gpt-5.6-sol",
      variant: "low",
    })
  })
})
