# Candidate B

```text
𝙊𝙥𝙚𝙣𝘾𝙤𝙙𝙚 v1.15.6 released. TL;DR: TUI gets a real diff viewer; `opencode run` adds shell mode; v2 HTTP API errors are now typed; native LLM routing expands to Anthropic.

TUI
Added
• Added `/diff`, a full-screen diff viewer for working-tree changes and last-turn changes, with file tree navigation, split/unified views, single-patch mode, and diff-source switching.
• Added compacted directory chains and first-file focus behavior in the diff viewer file tree.
• Added mode-aware keymap layers so base shortcuts stop leaking into dialogs and autocomplete.

Fixed
• Fixed PgUp/PgDn keybind aliases.
• Fixed Zed editor context detection so OpenCode only reads Zed context when running inside a Zed terminal.
• Changed collapsed thinking/reasoning display to a less noisy `+ Thought` style.

CLI
Added
• Added shell mode to `opencode run`: start a prompt with `!` to run a shell command directly, stream it through the session shell endpoint, and render the command/output inline.
• Replaced always-visible subagent tabs in `opencode run` with an on-demand subagent picker, plus a footer indicator and ↓ shortcut hint.

Fixed
• Changed `opencode login` to default to `https://console.opencode.ai` when no URL is passed.
• Fixed imported sessions so project, directory, and relative path metadata are updated for the current workspace.

Server
Added
• Added structured v2 HTTP API error schemas for invalid requests, invalid cursors, unauthorized requests, provider-not-found, and catalog-unavailable cases.
• Exposed v2 request/catalog errors through OpenAPI instead of collapsing them into legacy generic errors.

LLM
Changed
• Expanded native runtime routing from OpenAI/OpenCode API-key models to Anthropic API-key models using the Anthropic Messages protocol.
• Changed OpenCode native auth selection to prefer the console provider API key over stored OpenCode auth when both exist.

Plugin
Added
• Added `api.mode.current()` and `api.mode.push()` to the TUI plugin API for mode-scoped keybindings.

Fixed
• Fixed plugin tools that omit `args`; they now register as no-arg tools instead of crashing tool registry initialization.
• Fixed local file-plugin loading so permanent load/shape failures do not trigger dependency waits or block later valid plugins.

Agent
Fixed
• Fixed agent, mode, and command names loaded from relative config paths, avoiding bad names when parent directories contain `agent` or `command`.
• Fixed invalid `OPENCODE_PERMISSION` JSON so it is skipped with a warning instead of breaking config load.

App
Added
• Added initial non-prod app-shell session tabs in the v2 titlebar.

Fixed
• Fixed custom providers in the app so provider queries refresh immediately after config updates.
• Improved per-directory sync context reuse for app session data.

Desktop
Added
• Added a desktop app menu for Windows titlebar flows, backed by shared File/Edit/View/Go/Window/Help actions and native zoom/window/edit commands.

Zen
Added
• Added Go referral support: referral codes, invite-link capture, reward tracking, usage-credit preview, and applying rewards against Lite usage.

Enterprise
Fixed
• Fixed shared-session message navigation hovercard behavior and active-state styling, including better labels from message text.

SDK
Changed
• Regenerated the JS SDK and OpenAPI schema for the new v2 error unions.

UI
Added
• Added public `@opencode-ai/ui/v2/*` exports with v2 primitives, tokens, and Storybook coverage for buttons, dialogs, menus, fields, tabs, tool cards, toasts, and related components.
• Added Ukrainian locale coverage across shared UI, app, desktop, console, and docs routing.

No noticeable bundle change

Compare: https://github.com/anomalyco/opencode/compare/v1.15.5...v1.15.6
```
