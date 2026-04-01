import { z } from "zod"
import type { AppConfig } from "./config.js"
import { MODEL, THREAD_MAX_TWEETS, THREAD_SOFT_TWEET_LENGTH } from "./constants.js"
import { startOpencode } from "./opencode.js"
import type { GeneratedThread, ReleaseRange, ReleaseThreadReport } from "./types.js"
import { validateThread } from "./validate.js"

const generatedThreadSchema = z.object({
  tweets: z.array(z.string().min(1)).min(1),
})

function normalizeTweets(thread: GeneratedThread) {
  return thread.tweets.map((tweet) => tweet.replace(/\r/g, "").trim()).filter(Boolean)
}

function extractText(result: unknown) {
  const parts = (result as { data?: { parts?: Array<{ type?: string; text?: string }> } }).data?.parts ?? []
  return parts.find((part) => part.type === "text" && typeof part.text === "string")?.text?.trim()
}

function parseGeneratedThread(text: string) {
  const candidates = [
    text,
    text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1],
    (() => {
      const start = text.indexOf("{")
      const end = text.lastIndexOf("}")
      if (start === -1 || end === -1 || end <= start) return undefined
      return text.slice(start, end + 1)
    })(),
  ].filter((candidate): candidate is string => Boolean(candidate))

  for (const candidate of candidates) {
    try {
      return generatedThreadSchema.parse(JSON.parse(candidate))
    } catch {
      continue
    }
  }

  throw new Error(`Failed to parse generated thread JSON from output:\n${text}`)
}

function validateThreadShape(range: ReleaseRange, tweets: string[]) {
  const expectedFirstPrefix = `OpenCode ${range.toTag} released. TL;DR:`
  const expectedFinalTweet = `Compare: ${range.compareUrl}`

  if (tweets.length < 2) {
    throw new Error(`Generated invalid thread for ${range.toTag}: expected at least 2 tweets`)
  }

  if (!tweets[0]?.startsWith(expectedFirstPrefix)) {
    throw new Error(`Generated invalid thread for ${range.toTag}: first tweet format is wrong`)
  }

  if (tweets[tweets.length - 1] !== expectedFinalTweet) {
    throw new Error(`Generated invalid thread for ${range.toTag}: final tweet must be the GitHub compare link`)
  }
}

const SYSTEM_PROMPT = `You are a technical release analyst working in a git repository.

Inspect code and diffs with read-only tools only.
Never edit files, write files, or run commands that change the repository.
Prefer git diff, git log, grep, glob, and read.`

const READ_ONLY_PERMISSIONS = [
  { permission: "*", pattern: "*", action: "deny" as const },
  { permission: "read", pattern: "*", action: "allow" as const },
  { permission: "grep", pattern: "*", action: "allow" as const },
  { permission: "glob", pattern: "*", action: "allow" as const },
  { permission: "list", pattern: "*", action: "allow" as const },
  { permission: "codesearch", pattern: "*", action: "allow" as const },
  { permission: "lsp", pattern: "*", action: "allow" as const },
  { permission: "bash", pattern: "git *", action: "allow" as const },
]

function buildGenerationPrompt(range: ReleaseRange, config: AppConfig) {
  return `Analyze the git tag range ${range.fromTag ? `${range.fromTag} -> ${range.toTag}` : range.toTag} in the current repository.

Use the repository tools to inspect the code itself. Do not use GitHub release text or any pre-written release notes.

Goal:
Produce a concise technical TL;DR X thread for OpenCode followers who care about concrete implementation changes.

Write for highly technical users, but summarize at the subsystem/behavior level instead of narrating exact code symbols.

Suggested investigation:
1. Inspect the commit list for the tag range.
2. Inspect the file-level diff summary.
3. Inspect the highest-signal changed files.
4. Verify the most important claims against the code.

Prioritize:
- new capabilities
- fixes with clear behavior changes
- notable architecture or plugin-system changes
- provider/model/tooling changes
- TUI/Desktop/Web changes with concrete code backing

Deprioritize:
- docs/tests/chore-only changes
- routine dependency bumps
- release plumbing
- contributor lists

Return strict JSON only. Do not wrap it in markdown fences.

JSON schema:
{
  "tweets": ["tweet 1", "tweet 2"]
}

Rules:
- Produce between 2 and ${THREAD_MAX_TWEETS} tweets.
- Every tweet must be valid for X/Twitter weighted character rules.
- Aim for ${THREAD_SOFT_TWEET_LENGTH} weighted characters or less per tweet when possible.
- Use as many tweets as needed up to ${THREAD_MAX_TWEETS}.
- Plain text only. No markdown headings, no code fences.
- The first tweet must start exactly with "OpenCode ${range.toTag} released. TL;DR:".
- The first tweet should be the high-level summary only: 2-4 short TL;DR points, separated cleanly.
- The first tweet should not be the deep dive.
- If the first tweet summary would overflow, truncate it cleanly with "..." and continue the deeper detail in later tweets.
- The final tweet must be exactly: "Compare: ${range.compareUrl}"
- The final tweet is the GitHub compare link between tags ${range.fromTag ?? "<previous-tag>"} and ${range.toTag}.
- Do not add any other text to the final tweet.
- If there are more than 2 tweets, tweets 2-${THREAD_MAX_TWEETS - 1} should be the deeper dive on subsystem summaries.
- In deeper-dive tweets, group related changes by subsystem/theme rather than listing commits.
- Mention the tag range "${range.fromTag ? `${range.fromTag} -> ${range.toTag}` : range.toTag}" only if it fits naturally.
- Keep the tone technical and evidence-driven, not marketing copy.
- Prefer high-level technical summaries over exact variable, class, function, file, or test names.
- Only mention exact names when they are user-facing or ecosystem-facing: provider names, model names, package names, CLI commands, config keys, protocols, platforms.
- For each point, emphasize what changed and why it matters.
- Compress implementation detail into short subsystem summaries rather than listing many touched paths.
- Avoid exhaustive enumerations.
- Good: "improves async context propagation across session/runtime paths"
- Bad: "adds InstanceRef and runtime attach logic"
- Good: "adds Vertex Anthropic prompt-cache accounting"
- Bad: "reads cacheCreationInputTokens in Session.getUsage"
- Good: "fixes Azure provider option remapping"
- Bad: "transform.ts removed the special-case for @ai-sdk/azure"
- Do not invent changes.
- Use this GitHub compare URL between tags: ${range.compareUrl}

Release metadata:
- Current tag: ${range.toTag}
- Previous tag: ${range.fromTag ?? "none found"}
- Compare URL: ${range.compareUrl}
- Release URL: ${range.release.url}`
}

type PromptBody = {
  sessionID: string
  model: {
    providerID: string
    modelID: string
  }
  variant: string
  system: string
  parts: Array<{
    type: "text"
    text: string
  }>
}

export async function createThreadGenerator(config: AppConfig, repoDir: string) {
  const opencode = await startOpencode(repoDir)

  async function prompt(sessionID: string, text: string) {
    const result = await opencode.client.session.prompt(
      {
        sessionID,
        model: {
          providerID: MODEL.providerID,
          modelID: MODEL.modelID,
        },
        variant: MODEL.variant,
        system: SYSTEM_PROMPT,
        parts: [
          {
            type: "text",
            text,
          },
        ],
      } satisfies PromptBody,
      {
        signal: AbortSignal.timeout(config.opencodeTimeoutMs),
      },
    )

    const output = extractText(result)
    if (!output) throw new Error("OpenCode returned no text output")
    return output
  }

  return {
    async generateReport(range: ReleaseRange): Promise<ReleaseThreadReport> {
      const session = await opencode.client.session.create({
        permission: READ_ONLY_PERMISSIONS,
      })
      const sessionID = session.data?.id
      if (!sessionID) throw new Error("OpenCode session creation returned no session ID")

      const output = await prompt(sessionID, buildGenerationPrompt(range, config))
      const tweets = normalizeTweets(parseGeneratedThread(output))
      const errors = validateThread(tweets, THREAD_MAX_TWEETS)
      if (errors.length > 0) {
        throw new Error(`Generated invalid thread for ${range.toTag}`)
      }
      validateThreadShape(range, tweets)

      return {
        tag: range.release.tag,
        releaseUrl: range.release.url,
        compareUrl: range.compareUrl,
        fromTag: range.fromTag,
        toTag: range.toTag,
        draft: range.release.draft,
        model: MODEL,
        tweets,
      }
    },
    async close() {
      await opencode.close()
    },
  }
}
