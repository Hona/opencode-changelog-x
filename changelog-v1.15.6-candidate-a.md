# Candidate A

```text
𝙊𝙥𝙚𝙣𝘾𝙤𝙙𝙚 v1.15.6 released. TL;DR:
Added TUI diff viewer, introduced shell mode in CLI run prompt, routed Anthropic key models natively, and shipped titlebar tabs with massive UI v2 components.

𝗧𝗨𝗜
𝗔𝗱𝗱𝗲𝗱
• Added a built-in terminal diff viewer supporting side-by-side split and unified layouts for reviewing file changes and snapshot/Git diffs.
• Added a collapsible and expandable directory file tree within the TUI diff viewer for easy file navigation.
• Replaced subagent navigation tabs with an on-demand command palette picker and a Down-arrow shortcut from empty composers.
𝗙𝗶𝘅𝗲𝗱
• Fixed legacy Page Up and Page Down keybind aliases (pgup/pgdn) for terminal scroll navigation.
• Gated Zed editor context integration on active terminal environment variables to avoid overhead outside active editor sessions.

𝗖𝗟𝗜
𝗔𝗱𝗱𝗲𝗱
• Added a shell execution mode in opencode run triggered by typing ! on an empty prompt to run commands directly through session.shell.
𝗙𝗶𝘅𝗲𝗱
• Fixed the default login URL resolved by the console account CLI commands to point to the correct endpoint.

𝗖𝗼𝗿𝗲
𝗙𝗶𝘅𝗲𝗱
• Fixed resolution of agent and command names when defined using relative paths.
• Tolerated invalid JSON in the OPENCODE_PERMISSION environment variable gracefully instead of causing runtime crashes.

𝗔𝗴𝗲𝗻𝘁
𝗙𝗶𝘅𝗲𝗱
• Fixed imported sessions by correctly updating directory and path fields to align with the current workspace.

𝗦𝗲𝗿𝘃𝗲𝗿
𝗔𝗱𝗱𝗲𝗱
• Added structured public error schemas to the HTTP API v2 (e.g. InvalidRequestError, ProviderNotFoundError, and SessionBusyError) with exact mapped status codes.

𝗟𝗟𝗠
𝗔𝗱𝗱𝗲𝗱
• Routed Anthropic API-key models through the native high-performance LLM runtime.
𝗙𝗶𝘅𝗲𝗱
• Prioritized configured console OpenCode tokens/keys over fallback API keys in the native LLM runtime.

𝗣𝗹𝘂𝗴𝗶𝗻
𝗙𝗶𝘅𝗲𝗱
• Tolerated plugin tool definitions with missing arguments instead of crashing during tool registration.
• Handled permanent file plugin loading errors gracefully without blocking the runtime.

𝗔𝗽𝗽
𝗔𝗱𝗱𝗲𝗱
• Added an initial visual and workspace tabs implementation in the main titlebar.
𝗙𝗶𝘅𝗲𝗱
• Invalidated provider queries immediately following configuration updates to display custom providers instantly in the user interface.

𝗗𝗲𝘀𝗸𝘁𝗼𝗽
𝗔𝗱𝗱𝗲𝗱
• Added a native desktop application menu for Windows platforms.

𝗖𝗼𝗻𝘀𝗼𝗹𝗲
𝗔𝗱𝗱𝗲𝗱
• Added full UI support, invite flows, and styling for referral codes.

𝗭𝗲𝗻
𝗔𝗱𝗱𝗲𝗱
• Added Gemini 3.5 Flash support and pricing tables to Zen endpoints.

𝗘𝗻𝘁𝗲𝗿𝗽𝗿𝗶𝘀𝗲
𝗙𝗶𝘅𝗲𝗱
• Fixed active styling and hovercard interactive behaviors in the shared message navigation bar.

𝗦𝗗𝗞
𝗖𝗵𝗮𝗻𝗴𝗲𝗱
• Updated the JS SDK client and generated types to support and expose structured HTTP API v2 public error schemas.

𝗨𝗜
𝗔𝗱𝗱𝗲𝗱
• Added a full-featured v2 visual component library (including accordion, buttons, menu, selects, checkboxes, fields, and tool cards) to support modern v2 UI designs.
• Added Ukrainian (uk) locale language dictionary support.

𝗚𝗶𝘁𝗛𝘂𝗯
𝗙𝗶𝘅𝗲𝗱
• Removed an orphan symlink from the copilot SDK directory that was causing staging issues during GitHub Action builds.

No noticeable bundle change

Compare: https://github.com/anomalyco/opencode/compare/v1.15.5...v1.15.6
```
