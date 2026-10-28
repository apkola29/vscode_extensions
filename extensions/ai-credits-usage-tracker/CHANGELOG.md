# Changelog

## 0.5.0

- Show **Claude Code** token usage in the same hover and compact popup as GitHub Copilot, in its own section. It covers the Claude Code extension for VS Code and the Claude Code CLI, which share local transcripts.
- Add the `both` provider and make it the default. Claude Code appears only when local transcripts exist; set `aiUsageCreditsMeter.provider` to `githubCopilot` for the previous Copilot-only view.
- Keep the sources separate: Copilot credits are never added to Claude Code values, which are API list-price estimates rather than subscription charges, and a library call that names no provider now returns the two sections instead of one merged total. Claude Code sessions that Copilot also recorded are left in the Copilot section when they share a session id (CLI, SDK, agent-host and VS Code chat sessions), which is a best-effort match.
- Say plainly that Claude values are a lower bound: Anthropic documents per-step output token counts as placeholders, so output tokens and the value derived from them are under-reported.
- The Claude Code status label and rows use tokens and API value; the Claude-only provider no longer asks for a GitHub account.
- Resilience: a Claude Code transcript record over 8 MiB is skipped and counted instead of being buffered, so one huge tool result cannot exhaust the worker; transcripts are compacted to one entry per message before caching; absurd token or cost values are ignored; a failed combined scan falls back to GitHub Copilot alone and says Claude Code could not be read. That section is shown as "not available in this scan", not as empty, and a scan that was only queued behind a stalled one is cancelled and run again once instead of being blamed for the stall.
- Accuracy: duplicate messages keep the most complete record, any recorded cost and, on ties, the more recently written copy; id-less copies are deduplicated by content; very long ids are hashed rather than truncated so distinct messages never merge; a malformed record is skipped without discarding its neighbours; overlapping or linked config roots count each transcript once; and a full file cache keeps its files instead of re-reading everything on every scan.
- Pricing: add Claude Fable/Mythos 5 and 5.1 and Claude Haiku 5.5, including its higher rates for prompts over 100,000 tokens. A model without a list price shows its tokens and `n/a`.
- `CLAUDE_CONFIG_DIR` is treated as one directory (a path may contain commas); use `aiUsageCreditsMeter.claudeConfigDirs` for several. Settings of the wrong type (for example a list-valued provider, a non-array directory list, or an object where the reset day or ranking belongs) are ignored, only absolute directory strings are used, and Windows device paths (`\\.\`, `\\?\`) are never scanned.
- Display hardening: model names are shortened on character boundaries, lose control and bidirectional formatting characters, and cannot render links or `$(icon)` glyphs; error text shows one line with local paths reduced to file names, and an unreadable Claude Code folder is reported by error code only because Claude Code names project folders after your working directory; a transcript's model id is capped so a hostile file cannot stall a scan; tool-result spill files and MCP task state are no longer read as transcripts; and Bedrock `global.anthropic.…` model ids are recognized.
- The internal `aiUsageCreditsMeter.compute` command now returns `{ provider: 'both', githubCopilot, claudeCode }` by default.
- Each section now reports its own first problem in the hover, so a routine Copilot note cannot hide a Claude Code error, and an empty Claude section no longer takes over the status label.
- Report Claude read problems separately from Copilot ones, and render both sections in the optional detailed dashboard (the credits total there is marked `≈` only when it includes an estimate).
- Refresh the screenshots with a synthetic Claude Code section; test the combined provider mode, hover, popup, dashboard, fallback and the exact packaged VSIX.
- Claude transcripts are conversation files, so only token counts, timestamps, session ids and model ids are extracted; prompt and response text is not retained, displayed, logged or uploaded, and Claude sign-in or account files are never opened.

## 0.4.3

- Add native status-bar, hover and compact-popup screenshots to the Marketplace overview and repository introduction.
- Use only synthetic usage and a fictional demo account in an isolated screenshot profile; no personal screenshots or histories are published.
- Validate screenshot links, PNG metadata and demo-data isolation. Runtime behavior is unchanged.

## 0.4.2

- Rename the visible extension, hover, popup, Command Palette categories and output channel to **GH Copilot Usage Tracker**.
- Clearly describe GitHub Copilot credits/token usage tracking and local-device versus account-wide billing boundaries.
- Preserve extension, command, setting and repository-directory IDs for update compatibility.
- Document Marketplace installation and the two-project repository structure; validate README links and packaged overview content.

## 0.4.1

Initial public release of AI Credits Usage Tracker.

- Native status-bar hover for cycle totals and the five highest-credit models.
- Compact click popup with close, Escape, click-away, refresh, and ranking controls.
- GitHub Copilot local usage by default; Claude Code remains an explicit preview provider.
- Native VS Code GitHub identity selection without credential persistence.
- Read-only, device-scoped accounting with visible estimate/partial-data caveats.
- Bounded worker memory, queue, cache, timeout, and idle/deactivation cleanup.
- Synthetic accounting/identity/lifecycle/UI regression tests and real desktop interaction checks.
