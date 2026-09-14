import { z } from "zod";
import { Context, Effect, Layer } from "effect";
import type { AppConfig } from "./config.js";
import { MODEL, POST_MAX_LENGTH } from "./constants.js";
import { BundleSize, type BundleSizeService } from "./bundle-size.js";
import type { ChangelogKind, ReleaseRange } from "./domain/releases.js";
import {
    postTextFromString,
    type GitRef,
    type PostText,
    type ReleaseTag,
    type UrlString,
} from "./domain/value-objects.js";
import { OpencodeServer, type EffectRunningOpencode } from "./opencode.js";
import { RuntimeConfig } from "./runtime-config.js";
import { validatePost } from "./validate.js";

const generatedPostSchema = z.object({
    post: z.string().min(1),
});

export const STYLED_OPENCODE = "𝙊𝙥𝙚𝙣𝘾𝙤𝙙𝙚";

type GeneratedPost = {
    post: string;
};

export type ReleasePostReport = {
    kind: ChangelogKind;
    tag: string;
    releaseUrl: UrlString | null;
    compareUrl: UrlString;
    fromTag: ReleaseTag | null;
    toTag: GitRef;
    toLabel: string;
    draft: boolean;
    model: ModelConfig;
    post: PostText;
};

function normalizePost(post: GeneratedPost) {
    return post.post.replace(/\r/g, "").trim();
}

export function normalizeBodyBullets(post: string) {
    const lines = post.split("\n");

    return lines
        .map((line, index) => {
            if (index === 0 || index === lines.length - 1) return line;
            return line.replace(/^(\s*)-\s+/, "$1• ");
        })
        .join("\n");
}

type ContextMessage = {
    type?: string;
    id?: string;
    text?: string;
    model?: { providerID?: string; id?: string; variant?: string };
    content?: Array<{ type?: string; text?: string; name?: string }>;
    finish?: string;
    tokens?: unknown;
    error?: unknown;
};

// Returns the assistant message that answered the most recent user message in a session.context result.
export function findLatestAssistantMessage(messages: unknown) {
    const list = Array.isArray(messages) ? (messages as ContextMessage[]) : [];
    const lastUserIndex = list.findLastIndex((message) => message.type === "user");
    return list
        .slice(lastUserIndex + 1)
        .filter((message) => message.type === "assistant")
        .at(-1);
}

export function extractText(messages: unknown) {
    const assistant = findLatestAssistantMessage(messages);
    const text = (assistant?.content ?? [])
        .filter((part) => part.type === "text" && typeof part.text === "string")
        .map((part) => part.text?.trim())
        .filter((part): part is string => Boolean(part))
        .join("\n")
        .trim();

    return text || undefined;
}

export function describePromptResult(messages: unknown) {
    const list = Array.isArray(messages) ? (messages as ContextMessage[]) : [];
    const assistant = findLatestAssistantMessage(messages);
    const contentSummary = (assistant?.content ?? []).map((part) => {
        const text = typeof part.text === "string" ? part.text : "";
        const name = part.type === "tool" && part.name ? `:${part.name}` : "";
        return `${part.type ?? "unknown"}${name}${text ? `(${text.trim().length})` : ""}`;
    });

    return [
        `messages=${list.length}`,
        `message=${assistant?.id ?? "none"}`,
        `finish=${assistant?.finish ?? "missing"}`,
        `model=${assistant?.model?.providerID ?? "unknown"}/${assistant?.model?.id ?? "unknown"}`,
        `variant=${assistant?.model?.variant ?? "unknown"}`,
        `tokens=${JSON.stringify(assistant?.tokens ?? {})}`,
        `error=${JSON.stringify(assistant?.error ?? null)}`,
        `content=${contentSummary.join(", ") || "none"}`,
    ].join("; ");
}

function parseGeneratedPost(text: string) {
    return generatedPostSchema.parse(JSON.parse(text));
}

function insertSectionBeforeCompareLine(post: string, section: string) {
    const lines = post.replace(/\r/g, "").trim().split("\n");
    const compareLine = lines.pop();
    if (!compareLine) {
        throw new Error("Generated post is missing its final Compare line");
    }

    while (lines.at(-1) === "") {
        lines.pop();
    }

    return [...lines, "", section, "", compareLine].join("\n");
}

function getExpectedFirstPrefix(range: ReleaseRange) {
    if (range.kind === "preview") {
        return range.fromTag
            ? `${STYLED_OPENCODE} preview since ${range.fromTag}. TL;DR:`
            : `${STYLED_OPENCODE} preview. TL;DR:`;
    }

    return `${STYLED_OPENCODE} ${range.toLabel} released. TL;DR:`;
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

function parseAndValidatePost(range: ReleaseRange, output: string): PostText {
    const post = normalizeBodyBullets(
        normalizePost(parseGeneratedPost(output)),
    );
    const validationError = formatValidationErrors(post);

    if (validationError) {
        throw new Error(validationError);
    }

    validatePostShape(range, post);
    return postTextFromString(post);
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

export const SYSTEM_PROMPT = `You are a technical release analyst working in a git repository.

Inspect code and diffs with read-only tools only.
Never edit files, write files, or run commands that change the repository.
Prefer git diff, git log, grep, glob, and read.`;

// v2 permission rules: the last matching rule wins. Action names follow the v2 built-in tools
// (`shell` replaced `bash`; `list`, `codesearch`, and `lsp` are no longer permission actions).
export const READ_ONLY_PERMISSIONS = [
    { action: "*", resource: "*", effect: "deny" as const },
    { action: "read", resource: "*", effect: "allow" as const },
    { action: "grep", resource: "*", effect: "allow" as const },
    { action: "glob", resource: "*", effect: "allow" as const },
    { action: "shell", resource: "git *", effect: "allow" as const },
];

export const CHANGELOG_TAXONOMY = `Use this product map when choosing changelog sections. It is a dependency tree, not an output outline:

OpenCode runtime
- Core: shared foundational package and cross-cutting runtime behavior.
- Agent: sessions, tools, permissions, file operations, patches, worktrees, skills, commands, prompts, and questions.
- TUI: terminal UI routes, dialogs, keybinds, themes, prompts, scrollback, notifications, and terminal-only interaction flows.
- CLI: non-TUI commands, installation, shell integration, PTY behavior, formatting, exports/imports, upgrades, and command-line flags.
- Server: local HTTP API, event streams, websocket behavior, projectors, route handlers, OpenAPI-visible server behavior, and share endpoints.
- Storage: database schema, migrations, persistence, JSON migration, and local state layout.
- Providers: provider auth, provider config, model routing, model IDs, provider transforms, and provider-specific user behavior.
- LLM: low-level model protocol adapters, native runtime, tool streaming, cache policy, request framing, schema, and provider transport internals.
- MCP: MCP config, auth, OAuth callback, MCP tools, and server integration.
- ACP: ACP runtime, agent/session protocol support, and ACP CLI command behavior.
- LSP: language-server launch, diagnostics, editor context, LSP tools, and LSP config.
- Sync: sync schema, sync events, and cross-instance synchronization.

Product surfaces
- App: local browser UI, Electron desktop shell, native menus and windows, sidecars, updater, desktop packaging, app icons, preload/main processes, and desktop-specific platform integrations.
- Console: hosted console app, console API, console resources, workspace routes, auth routes, billing routes, and cloud console functions.
- Zen: Zen-specific console routes, Zen onboarding, Zen billing, Zen sharing, Zen branding, and Zen-specific enterprise flows.
- Data: OpenCode Data and the stats site, model rankings and comparisons, usage and cost analytics, data ingestion and sync, stats storage, and data-specific infrastructure.
- Enterprise: enterprise package, enterprise web routes, enterprise sharing, team features, and enterprise storage.

Developer surfaces
- SDK: JS SDK, generated clients, client/server helpers, OpenAPI types, and SDK publishing.
- Plugin: plugin package, plugin APIs, plugin loading, plugin tools, plugin TUI bindings, and plugin config.
- UI: shared UI package, reusable components, themes, icons, i18n dictionaries, and Storybook examples.
- VS Code: VS Code extension behavior, activation, commands, views, packaging, and publishing.
- Zed: Zed extension behavior, context activation, commands, and extension metadata.
- Slack: Slack package, Slack bot integration, commands, and Slack message behavior.
- GitHub: GitHub Action, GitHub app/action package, GitHub automation, and GitHub integration behavior.

Project support
- Docs: public docs, docs site, README translations, and user-facing documentation.
- Infra: SST, Cloudflare resources, monitoring, cloud resources, secrets, and deployment infrastructure.
- Release: install scripts, publishing scripts, Nix, containers, release workflows, package manifests, lockfiles, and build pipeline changes.

Rules for sections:
- Use only the bullet item names in this product map as section headings.
- Never make compound headings. Do not use "&", "/", commas, or "and" in a heading.
- If two areas changed, create two sections. If a change spans two areas, place it under the area users will notice first.
- Omit empty sections instead of merging them into a broad bucket.
- Prefer the most specific accurate section: use TUI instead of CLI for terminal UI changes, use Data instead of Console for OpenCode Data and stats changes, use Zen instead of Console for Zen-only changes, and use VS Code or Zed for editor-extension changes.`;

export const PRODUCT_HEADING_MAP = `  Agent -> 𝗔𝗴𝗲𝗻𝘁
  ACP -> 𝗔𝗖𝗣
  App -> 𝗔𝗽𝗽
  CLI -> 𝗖𝗟𝗜
  Console -> 𝗖𝗼𝗻𝘀𝗼𝗹𝗲
  Core -> 𝗖𝗼𝗿𝗲
  Data -> 𝗗𝗮𝘁𝗮
  Docs -> 𝗗𝗼𝗰𝘀
  Enterprise -> 𝗘𝗻𝘁𝗲𝗿𝗽𝗿𝗶𝘀𝗲
  GitHub -> 𝗚𝗶𝘁𝗛𝘂𝗯
  Infra -> 𝗜𝗻𝗳𝗿𝗮
  LLM -> 𝗟𝗟𝗠
  LSP -> 𝗟𝗦𝗣
  MCP -> 𝗠𝗖𝗣
  Plugin -> 𝗣𝗹𝘂𝗴𝗶𝗻
  Providers -> 𝗣𝗿𝗼𝘃𝗶𝗱𝗲𝗿𝘀
  Release -> 𝗥𝗲𝗹𝗲𝗮𝘀𝗲
  SDK -> 𝗦𝗗𝗞
  Server -> 𝗦𝗲𝗿𝘃𝗲𝗿
  Slack -> 𝗦𝗹𝗮𝗰𝗸
  Storage -> 𝗦𝘁𝗼𝗿𝗮𝗴𝗲
  Sync -> 𝗦𝘆𝗻𝗰
  TUI -> 𝗧𝗨𝗜
  UI -> 𝗨𝗜
  VS Code -> 𝗩𝗦 𝗖𝗼𝗱𝗲
  Zen -> 𝗭𝗲𝗻
  Zed -> 𝗭𝗲𝗱`;

export type PostFormatRuleOptions = {
    firstLinePrefix: string;
    compareUrl: string;
    fromLabel: string;
    toLabel: string;
};

export function buildPostFormatRules(options: PostFormatRuleOptions) {
    return `Rules:
- Produce exactly one X post.
- Keep the total output within ${POST_MAX_LENGTH} characters.
- Plain text only. No code fences. No markdown.
- X/Twitter does NOT support markdown. **bold**, *italic*, __underline__ will render literally as asterisks/underscores.
- Use exact mathematical-bold product headings from the heading map below.
- Use plain ASCII for action subsection headings.
- Use '•' (U+2022) for bullets. Do not use '-' or '*' for bullets.
- Do not use markdown bold, Unicode italic, emoji, box drawing, or decorative heading characters.
- Product heading map:
${PRODUCT_HEADING_MAP}
- Line breaks are allowed.
- Never use separator lines or divider rows of any kind, including "---", "___", or repeated "─" characters.
- Do not spend characters or vertical space on visual dividers.
- The post must start exactly with "${options.firstLinePrefix}".
- The first line should be the high-level summary only: 2-4 short TL;DR points, separated cleanly.
- After the first line, structure the body as product sections using the taxonomy above.
- Section order: If present, TUI and App must be the first product headings. Order TUI and App by your perceived importance. Order all remaining product headings by your perceived importance.
- Inside each product section, only use action subsections when the section has 3+ bullets and at least two distinct action groups.
- Action subsections must be one of: Added, Changed, Fixed, Removed.
- If a product section has one or two bullets, do not use action subsections. Put bullets directly under the product heading.
- If a product section has 3+ bullets but they all share the same action, do not use an action subsection. Put bullets directly under the product heading.
- Keep each bullet to one user-visible behavior change. Do not pack unrelated changes into one bullet.
- Start bullets with direct verbs like Added, Fixed, Changed, Removed, Improved, Restored, or Updated.
- Do not copy commit messages. Rewrite them into concise user-facing behavior.
- Do not include raw commit prefixes like fix:, feat:, chore:, ci:, refactor:, or release:.
- Do not include PR numbers or commit hashes.
- The body can use product headings, action subsection headings, and '•' bullet points.
- Use blank lines between sections when it improves readability.
- The final line must be exactly: "Compare: ${options.compareUrl}"
- The final line is the GitHub compare link between tags ${options.fromLabel} and ${options.toLabel}.
- Do not add any other text after the final line.
- Do not split the release into multiple tweets.
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
- Use this GitHub compare URL between tags: ${options.compareUrl}`;
}

export function buildGenerationPrompt(range: ReleaseRange) {
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

Write for highly technical users, but summarize at the product/behavior level instead of narrating exact code symbols.
You are writing one longer X post, not a thread. The post should read like a precise technical changelog, not marketing copy.

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
- TUI, App, Console, Zen, and Data changes with concrete code backing

Deprioritize:
- docs/tests/chore-only changes
- routine dependency bumps
- release plumbing
- contributor lists

${CHANGELOG_TAXONOMY}

Return strict JSON only. Do not wrap it in markdown fences.

JSON schema:
{
  "post": "full post text"
}

${buildPostFormatRules({
    firstLinePrefix: firstTweetPrefix,
    compareUrl: range.compareUrl,
    fromLabel: range.fromTag ?? "<previous-tag>",
    toLabel: range.toTag,
})}
- Bundle information, if present, appears as one plain sentence immediately before the final Compare line.
- Mention the range "${displayRange}" only if it fits naturally.
- If this is a preview, describe the changes as unreleased work after the latest GitHub release. Do not say they were already released.
- For truly small releases, keep the post tight. Do not pad it with unnecessary sections.
- If a feature added in a release is truly massive, use the extra space for a structured breakdown in the same post.

<example>
${STYLED_OPENCODE} v1.14.21 released. TL;DR:
TUI gets diff review, CLI gets shell mode, v2 API errors are typed, and native routing expands to Anthropic.

𝗧𝗨𝗜
Added
• Added /diff for reviewing working-tree and last-turn changes with file navigation, split/unified views, and single-patch mode.
• Added compacted directory chains and first-file focus behavior in the diff viewer file tree.
• Added mode-aware keymap layers so base shortcuts stop leaking into dialogs and autocomplete.

Fixed
• Fixed PgUp/PgDn keybind aliases.
• Fixed Zed editor context detection so OpenCode only reads Zed context inside Zed terminals.
• Changed collapsed thinking display to a quieter + Thought style.

𝗖𝗟𝗜
• Added shell mode to opencode run: start an empty prompt with ! to run a shell command inline.
• Changed opencode login to default to https://console.opencode.ai when no URL is passed.

𝗦𝗲𝗿𝘃𝗲𝗿
• Added structured v2 HTTP API error schemas for invalid requests, unauthorized requests, missing providers, and catalog failures.
• Exposed v2 request and catalog errors through OpenAPI instead of collapsing them into generic legacy errors.

𝗟𝗟𝗠
• Expanded native runtime routing from OpenAI API-key models to Anthropic API-key models.
• Changed native auth selection to prefer the console OpenCode provider key when available.

𝗣𝗹𝘂𝗴𝗶𝗻
• Added mode-scoped TUI plugin keybindings.
• Fixed no-arg plugin tools so they register instead of crashing tool initialization.

No noticeable bundle change

Compare: https://github.com/anomalyco/opencode/compare/v1.14.20...v1.14.21
</example>

<example>
${STYLED_OPENCODE} v1.14.22 released. TL;DR:
App startup is safer, session loading is faster, and provider auth is easier to debug.

𝗔𝗽𝗽
Added
• Added an Export Logs action that collects app, server, crash, and netlog files into Downloads.

Fixed
• Fixed startup recovery when the sidecar exits before the first window opens.
• Fixed slow recent-session loading by reusing per-directory sync context.
• Fixed custom providers appearing stale after config updates.

𝗣𝗿𝗼𝘃𝗶𝗱𝗲𝗿𝘀
• Added clearer login errors for expired OAuth flows.
• Fixed API-key auth fallback when a provider has both console and local credentials.

Bundle +1.8 MB because Web UI assets and source maps grew across desktop targets.

Compare: https://github.com/anomalyco/opencode/compare/v1.14.21...v1.14.22
</example>

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

export type ModelConfig = {
    providerID: string;
    modelID: string;
    variant: string;
};

export type ReadOnlySessionOptions = {
    model: ModelConfig;
    system: string;
    title?: string;
};

export type PromptSessionOptions = {
    sessionID: string;
    text: string;
    timeoutMs: number;
};

export const SYSTEM_INSTRUCTION_KEY = "changelog-system";

export function describeError(error: unknown): string {
    if (error instanceof Error) {
        const cause = (error as { cause?: unknown }).cause;
        const detail = cause === undefined ? "" : describeError(cause);
        const message = error.message || error.name;
        return detail && detail !== message ? `${message} (${detail})` : message;
    }
    return typeof error === "string" ? error : JSON.stringify(error);
}

const failWithServerOutput = Effect.fn("failWithServerOutput")(function* (opencode: EffectRunningOpencode, lines: string[]) {
    const serverOutput = yield* Effect.promise(() => opencode.getOutput());
    return yield* Effect.fail(new Error(
        [
            ...lines,
            serverOutput ? `Recent opencode output:\n${serverOutput}` : "Recent opencode output: <empty>",
        ].join("\n"),
    ));
});

// The v2 API has no per-prompt system prompt. Session-scoped instruction entries are appended to the
// initial instructions, so the system prompt is attached once when the session is created.
export const createReadOnlySession = Effect.fn("createReadOnlySession")(function* (opencode: EffectRunningOpencode, options: ReadOnlySessionOptions) {
    const { client } = opencode;
    const created = yield* Effect.tryPromise(() => client.session.create({
        title: options.title,
        model: {
            providerID: options.model.providerID,
            id: options.model.modelID,
            variant: options.model.variant,
        },
        location: { directory: opencode.directory },
        permissions: READ_ONLY_PERMISSIONS,
    })).pipe(Effect.result);
    if (created._tag === "Failure") {
        return yield* failWithServerOutput(opencode, [
            `OpenCode session creation failed: ${describeError(created.failure)}`,
        ]);
    }

    const sessionID = created.success.id;
    const instructed = yield* Effect.tryPromise(() => client.session.instructions.entry.put({
        sessionID,
        key: SYSTEM_INSTRUCTION_KEY,
        value: options.system,
    })).pipe(Effect.result);
    if (instructed._tag === "Failure") {
        return yield* failWithServerOutput(opencode, [
            `OpenCode session ${sessionID} rejected the system instructions: ${describeError(instructed.failure)}`,
        ]);
    }
    return sessionID;
});

export const promptSession = Effect.fn("promptSession")(function* (opencode: EffectRunningOpencode, options: PromptSessionOptions) {
    const { client } = opencode;
    const { sessionID } = options;

    yield* Effect.tryPromise(() => client.session.prompt({ sessionID, text: options.text }));

    const signal = AbortSignal.timeout(options.timeoutMs);
    while (true) {
        const waited = yield* Effect.tryPromise(() => client.session.wait({ sessionID }, { signal })).pipe(Effect.result);
        if (waited._tag === "Success") break;
        if (signal.aborted) {
            yield* Effect.promise(() => client.session.interrupt({ sessionID }).catch(() => undefined));
            return yield* failWithServerOutput(opencode, [
                `OpenCode session ${sessionID} did not finish within ${options.timeoutMs}ms; the turn was interrupted`,
            ]);
        }
        // Bun's fetch drops idle long-polls after 6 minutes; keep waiting while the turn is still running.
        const active = yield* Effect.tryPromise(() => client.session.active()).pipe(Effect.result);
        if (active._tag === "Success" && sessionID in active.success) {
            yield* Effect.sleep("1 second");
            continue;
        }
        if (active._tag === "Success") break;
        return yield* failWithServerOutput(opencode, [
            `OpenCode session ${sessionID} wait failed: ${describeError(waited.failure)}`,
            `Session status check failed: ${describeError(active.failure)}`,
        ]);
    }

    const messages = yield* Effect.tryPromise(() => client.session.context({ sessionID }));
    const assistant = findLatestAssistantMessage(messages);
    if (assistant?.error) {
        return yield* failWithServerOutput(opencode, [
            `OpenCode assistant turn failed: ${describeError(assistant.error)}`,
            describePromptResult(messages),
        ]);
    }

    const output = extractText(messages);
    if (!output) {
        return yield* failWithServerOutput(opencode, [
            "OpenCode returned no text output",
            describePromptResult(messages),
        ]);
    }
    return output;
});

function createGenerator(
    config: AppConfig,
    opencode: EffectRunningOpencode,
    bundleSize: BundleSizeService,
    activeModel: ModelConfig,
) {
    const prompt = Effect.fn("PostGenerator.prompt")(function* (sessionID: string, text: string) {
        return yield* promptSession(opencode, {
            sessionID,
            text,
            timeoutMs: config.opencodeTimeoutMs,
        });
    });

    const generatePost = Effect.fn("PostGenerator.generatePost")(function* (sessionID: string, range: ReleaseRange) {
        const output = yield* prompt(sessionID, buildGenerationPrompt(range));
        return parseAndValidatePost(range, output);
    });

    const generateReport = Effect.fn("PostGenerator.generateReport")(function* (range: ReleaseRange) {
        const sessionID = yield* createReadOnlySession(opencode, {
            model: activeModel,
            system: SYSTEM_PROMPT,
            title: `changelog ${range.toLabel}`,
        });

        const generatedPost = yield* generatePost(sessionID, range);
        const bundleSizeSection = yield* bundleSize.buildSection(range);
        const post = bundleSizeSection
            ? postTextFromString(insertSectionBeforeCompareLine(generatedPost, bundleSizeSection))
            : generatedPost;
        const validationError = formatValidationErrors(post);
        if (validationError) {
            return yield* Effect.fail(new Error(validationError));
        }

        validatePostShape(range, post);

        return {
            kind: range.kind,
            tag: range.release?.tag ?? "preview",
            releaseUrl: range.release?.url ?? null,
            compareUrl: range.compareUrl,
            fromTag: range.fromTag,
            toTag: range.toTag,
            toLabel: range.toLabel,
            draft: range.release?.draft ?? false,
            model: activeModel,
            post,
        };
    });

    return { generateReport };
}

export class PostGenerator extends Context.Service<PostGenerator, {
    readonly withGenerator: <A, E, R>(
        repoDir: string,
        modelOverride: ModelConfig | undefined,
        use: (generator: { generateReport: (range: ReleaseRange) => Effect.Effect<ReleasePostReport, unknown> }) => Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, E | unknown, R>
}>()("app/PostGenerator") {
    static readonly layer = Layer.effect(
        this,
        Effect.gen(function* () {
            const config = yield* RuntimeConfig;
            const opencodeServer = yield* OpencodeServer;
            const bundleSize = yield* BundleSize;

            const withGenerator = <A, E, R>(
                repoDir: string,
                modelOverride: ModelConfig | undefined,
                use: (generator: { generateReport: (range: ReleaseRange) => Effect.Effect<ReleasePostReport, unknown> }) => Effect.Effect<A, E, R>,
            ) => opencodeServer.withServer(repoDir, (opencode) =>
                use(createGenerator(config, opencode, bundleSize, modelOverride ?? MODEL)),
            );

            return PostGenerator.of({ withGenerator });
        }),
    ).pipe(
        Layer.provide(OpencodeServer.layer),
        Layer.provide(BundleSize.layer),
    );
}
