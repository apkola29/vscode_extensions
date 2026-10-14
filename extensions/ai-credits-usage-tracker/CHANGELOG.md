# Changelog

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
