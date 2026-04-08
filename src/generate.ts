import { z } from "zod";
import type { AppConfig } from "./config.js";
import { MODEL, POST_MAX_LENGTH } from "./constants.js";
import { startOpencode } from "./opencode.js";
import type {
    GeneratedPost,
    ReleaseRange,
    ReleasePostReport,
} from "./types.js";
import { validatePost } from "./validate.js";

const generatedPostSchema = z.object({
    post: z.string().min(1),
});

const MAX_GENERATION_ATTEMPTS = 3;

function normalizePost(post: GeneratedPost) {
    return post.post.replace(/\r/g, "").trim();
}

function normalizeBodyBullets(post: string) {
    const lines = post.split("\n");

    return lines
        .map((line, index) => {
            if (index === 0 || index === lines.length - 1) return line;
            return line.replace(/^(\s*)-\s+/, "$1• ");
        })
        .join("\n");
}

function extractText(result: unknown) {
    const parts =
        (
            result as {
                data?: { parts?: Array<{ type?: string; text?: string }> };
            }
        ).data?.parts ?? [];
    return parts
        .find((part) => part.type === "text" && typeof part.text === "string")
        ?.text?.trim();
}

function parseGeneratedPost(text: string) {
    const candidates = [
        text,
        text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1],
        (() => {
            const start = text.indexOf("{");
            const end = text.lastIndexOf("}");
            if (start === -1 || end === -1 || end <= start) return undefined;
            return text.slice(start, end + 1);
        })(),
    ].filter((candidate): candidate is string => Boolean(candidate));

    for (const candidate of candidates) {
        try {
            return generatedPostSchema.parse(JSON.parse(candidate));
        } catch {
            continue;
        }
    }

    throw new Error(
        `Failed to parse generated post JSON from output:\n${text}`,
    );
}

function getExpectedFirstPrefix(range: ReleaseRange) {
    if (range.kind === "preview") {
        return range.fromTag
            ? `OpenCode preview since ${range.fromTag}. TL;DR:`
            : "OpenCode preview. TL;DR:";
    }

    return `OpenCode ${range.toLabel} released. TL;DR:`;
}

function getDisplayRange(range: ReleaseRange) {
    return range.fromTag
        ? `${range.fromTag} -> ${range.toLabel}`
        : range.toLabel;
}

function getGitRange(range: ReleaseRange) {
    return range.fromTag ? `${range.fromTag}..${range.toTag}` : range.toTag;
}

function formatValidationErrors(post: string) {
    const errors = validatePost(post, POST_MAX_LENGTH);
    if (errors.length === 0) return null;

    return errors.join("; ");
}

function parseAndValidatePost(range: ReleaseRange, output: string) {
    const post = normalizeBodyBullets(normalizePost(parseGeneratedPost(output)));
    const validationError = formatValidationErrors(post);

    if (validationError) {
        throw new Error(validationError);
    }

    validatePostShape(range, post);
    return post;
}

function validatePostShape(range: ReleaseRange, post: string) {
    const expectedFirstPrefix = getExpectedFirstPrefix(range);
    const expectedFinalLine = `Compare: ${range.compareUrl}`;
    const lines = post
        .split("\n")
        .map((line) => line.trimEnd())
        .filter(Boolean);

    if (lines.length < 3) {
        throw new Error(
            `Generated invalid post for ${range.toLabel}: expected a TL;DR line, body, and compare footer`,
        );
    }

    if (!post.startsWith(expectedFirstPrefix)) {
        throw new Error(
            `Generated invalid post for ${range.toLabel}: TL;DR header format is wrong`,
        );
    }

    if (lines.at(-1) !== expectedFinalLine) {
        throw new Error(
            `Generated invalid post for ${range.toLabel}: final line must be the GitHub compare link`,
        );
    }

    const body = lines.slice(1, -1).join("\n").trim();
    if (!body) {
        throw new Error(
            `Generated invalid post for ${range.toLabel}: body is empty`,
        );
    }
}

const SYSTEM_PROMPT = `You are a technical release analyst working in a git repository.

Inspect code and diffs with read-only tools only.
Never edit files, write files, or run commands that change the repository.
Prefer git diff, git log, grep, glob, and read.`;

const READ_ONLY_PERMISSIONS = [
    { permission: "*", pattern: "*", action: "deny" as const },
    { permission: "read", pattern: "*", action: "allow" as const },
    { permission: "grep", pattern: "*", action: "allow" as const },
    { permission: "glob", pattern: "*", action: "allow" as const },
    { permission: "list", pattern: "*", action: "allow" as const },
    { permission: "codesearch", pattern: "*", action: "allow" as const },
    { permission: "lsp", pattern: "*", action: "allow" as const },
    { permission: "bash", pattern: "git *", action: "allow" as const },
];

function buildGenerationPrompt(range: ReleaseRange) {
    const firstTweetPrefix = getExpectedFirstPrefix(range);
    const displayRange = getDisplayRange(range);
    const gitRange = getGitRange(range);
    const goal =
        range.kind === "preview"
            ? "Produce a concise technical TL;DR X post preview for unreleased OpenCode commits after the latest GitHub release."
            : "Produce a concise technical TL;DR X post for the shipped OpenCode release.";

    return `Analyze the git range ${displayRange} in the current repository.

When you run git commands, use the exact ref range ${gitRange}.

Use the repository tools to inspect the code itself. Do not use GitHub release text or any pre-written release notes.

Goal:
${goal}

Write for highly technical users, but summarize at the subsystem/behavior level instead of narrating exact code symbols.
You are writing one longer X post, not a thread.

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
  "post": "full post text"
}

Rules:
- Produce exactly one X post.
- Keep the total output within ${POST_MAX_LENGTH} characters.
- Plain text only. No code fences.
- Line breaks are allowed.
- Use the Unicode bullet character '•' (U+2022) for body points when helpful.
- The post must start exactly with "${firstTweetPrefix}".
- The first line should be the high-level summary only: 2-4 short TL;DR points, separated cleanly.
- After the first line, include a compact body with grouped subsystem summaries.
- The body can use short paragraphs and/or '•' bullet points.
- Use blank lines between sections when it improves readability.
- The final line must be exactly: "Compare: ${range.compareUrl}"
- The final line is the GitHub compare link between tags ${range.fromTag ?? "<previous-tag>"} and ${range.toTag}.
- Do not add any other text after the final line.
- Do not split the release into multiple tweets.
- Mention the range "${displayRange}" only if it fits naturally.
- Keep the tone technical and evidence-driven, not marketing copy.
- Prefer high-level technical summaries over exact variable, class, function, file, or test names.
- Only mention exact names when they are user-facing or ecosystem-facing: provider names, model names, package names, CLI commands, config keys, protocols, platforms.
- For each point, emphasize what changed and why it matters.
- Compress implementation detail into short subsystem summaries rather than listing many touched paths.
- Avoid exhaustive enumerations.
- If this is a preview, describe the changes as unreleased work after the latest GitHub release. Do not say they were already released.
- Good: "improves async context propagation across session/runtime paths"
- Bad: "adds InstanceRef and runtime attach logic"
- Good: "adds Vertex Anthropic prompt-cache accounting"
- Bad: "reads cacheCreationInputTokens in Session.getUsage"
- Good: "fixes Azure provider option remapping"
- Bad: "transform.ts removed the special-case for @ai-sdk/azure"
- Do not invent changes.
- For truely small releases, keep the post tight. Do not pad it with unnecessary sections.
- If a feature added in a release is truely massive, use the extra space for a structured breakdown in the same post.
- Use this GitHub compare URL between tags: ${range.compareUrl}

Release metadata:
- Mode: ${range.kind}
- Previous tag: ${range.fromTag ?? "none found"}
- Display range: ${displayRange}
- Exact git ref range: ${gitRange}
- Current ref label: ${range.toLabel}
- Current ref: ${range.toTag}
- Compare URL: ${range.compareUrl}
- Release URL: ${range.release?.url ?? "none (preview)"}`;
}

type PromptBody = {
    sessionID: string;
    model: {
        providerID: string;
        modelID: string;
    };
    variant: string;
    system: string;
    parts: Array<{
        type: "text";
        text: string;
    }>;
};

export async function createPostGenerator(
    config: AppConfig,
    repoDir: string,
) {
    const opencode = await startOpencode(repoDir);

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
        );

        const output = extractText(result);
        if (!output) throw new Error("OpenCode returned no text output");
        return output;
    }

    async function generatePost(sessionID: string, range: ReleaseRange) {
        let nextPrompt = buildGenerationPrompt(range);
        let lastError: Error | undefined;

        for (
            let attempt = 1;
            attempt <= MAX_GENERATION_ATTEMPTS;
            attempt += 1
        ) {
            const output = await prompt(sessionID, nextPrompt);

            try {
                return parseAndValidatePost(range, output);
            } catch (error) {
                lastError =
                    error instanceof Error ? error : new Error(String(error));

                if (attempt >= MAX_GENERATION_ATTEMPTS) {
                    break;
                }

                nextPrompt = [
                    `Your previous output was invalid: ${lastError.message}`,
                    "Return corrected strict JSON only.",
                    `The post must start exactly with: \"${getExpectedFirstPrefix(range)}\"`,
                    `The final line must be exactly: \"Compare: ${range.compareUrl}\"`,
                ].join("\n");
            }
        }

        throw new Error(
            `Generated invalid post for ${range.toLabel} after ${MAX_GENERATION_ATTEMPTS} attempts: ${lastError?.message ?? "unknown error"}`,
        );
    }

    return {
        async generateReport(
            range: ReleaseRange,
        ): Promise<ReleasePostReport> {
            const session = await opencode.client.session.create({
                permission: READ_ONLY_PERMISSIONS,
            });
            const sessionID = session.data?.id;
            if (!sessionID)
                throw new Error(
                    "OpenCode session creation returned no session ID",
                );

            const post = await generatePost(sessionID, range);

            return {
                kind: range.kind,
                tag: range.release?.tag ?? "preview",
                releaseUrl: range.release?.url ?? null,
                compareUrl: range.compareUrl,
                fromTag: range.fromTag,
                toTag: range.toTag,
                toLabel: range.toLabel,
                draft: range.release?.draft ?? false,
                model: MODEL,
                post,
            };
        },
        async close() {
            await opencode.close();
        },
    };
}
