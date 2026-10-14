# VS Code extensions

Two independent VS Code extensions maintained under the public `apkola29` namespace.

| Project | Purpose | Status |
| --- | --- | --- |
| [Agent Keep-Awake](extensions/agent-keep-awake/README.md) | Explicit, OS-native sleep prevention with Off / Keep awake / timed-session controls. | Manual-mode preview; automatic Copilot activity detection is unavailable. |
| [AI Credits Usage Tracker](extensions/ai-credits-usage-tracker/README.md) | Compact native hover and dismissible popup for local GitHub Copilot credits and tokens by model. | Public release candidate; GitHub Copilot default, Claude Code preview. |

Neither extension reroutes prompts, modifies Copilot, or requires a hardcoded identity.
Each project has its own manifest, license, tests, and independently installable VSIX.

## Install

Download the matching `.vsix` from [GitHub Releases](https://github.com/apkola29/vscode_extensions/releases).
In VS Code, use **Extensions: Install from VSIX...**, then reload that window.

Marketplace publication uses a separate Visual Studio Marketplace publisher authorization.
GitHub sign-in by itself does not grant permission to publish a Marketplace extension.
Release availability and any preview limitations are documented per project; do not assume an
unpublished Marketplace listing exists.

## Develop and test

Use Node.js 24 for the local validation scripts.

```powershell
cd extensions\ai-credits-usage-tracker
npm test
npm run package

cd ..\agent-keep-awake
npm ci --ignore-scripts
npm run typecheck
npm test
```

The credit tracker's desktop UI test verifies real native hover, mouse-leave dismissal, a click popup,
close/Escape/click-away behavior, and unchanged panel/editor layout. The keep-awake OS tests intentionally
hold a native power request and must be run only on a machine where that side effect is intended.
CI runs synthetic unit tests/type checks; it does not silently acquire power holds or publish extensions.

## Privacy and release boundaries

See [PRIVACY.md](PRIVACY.md) and [SECURITY.md](SECURITY.md).

This repository contains authored source and synthetic test fixtures only, not personal Copilot histories,
tokens, account records, telemetry dumps, session logs, or machine-specific configuration.
Generated VSIX files are release assets rather than committed binary history.

## License

[MIT](LICENSE). Original project-specific attribution is retained.
