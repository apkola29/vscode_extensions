# VS Code extensions

Two independent VS Code extensions maintained under the public `apkola29` namespace.

| Project | Purpose | Status |
| --- | --- | --- |
| [Agent Keep-Awake](extensions/agent-keep-awake/README.md) | Explicit, OS-native sleep prevention with Off / Keep awake / timed-session controls. | Manual-mode preview; automatic Copilot activity detection is unavailable. |
| [GH Copilot Usage Tracker](extensions/ai-credits-usage-tracker/README.md) | Tracks **GitHub Copilot usage**: local credits and tokens by model/month, shown in a compact hover and popup. | GitHub Copilot is the supported default; Claude Code is a separate preview. |

Neither extension reroutes prompts, modifies Copilot, or requires a hardcoded identity.
Each project has its own manifest, license, tests, and independently installable VSIX.

## Install

Download the matching `.vsix` from [GitHub Releases](https://github.com/apkola29/vscode_extensions/releases).
In VS Code, use **Extensions: Install from VSIX...**, then reload that window.

Marketplace listings:

- [GH Copilot Usage Tracker](https://marketplace.visualstudio.com/items?itemName=apkola29.ai-usage-credits-meter) — `apkola29.ai-usage-credits-meter`.
- [Agent Keep-Awake](https://marketplace.visualstudio.com/items?itemName=apkola29.agent-keep-awake) — `apkola29.agent-keep-awake`; choose the **pre-release** manual-mode preview.

The stable extension IDs and project directories are retained for compatibility. Tracker usage is local/device-scoped, not an official account-wide GitHub bill. Keep-awake does not automatically detect Copilot activity or chat completion.

## GH Copilot Usage Tracker preview

Native VS Code screenshots using **synthetic usage and a fictional demo account**, not personal account data.

**Hover for the cycle total and highest-credit models:**

![GH Copilot Usage Tracker native hover with a synthetic usage total and five highest-credit models](extensions/ai-credits-usage-tracker/media/screenshots/usage-hover.png)

**Click for a compact, dismissible model list:**

![GH Copilot Usage Tracker compact popup with synthetic model credits and tokens, plus ranking, refresh and close buttons](extensions/ai-credits-usage-tracker/media/screenshots/usage-popup.png)

See the [tracker README](extensions/ai-credits-usage-tracker/README.md#screenshots) for the status-bar indicator, screenshots, and usage instructions. These images illustrate the interface, not model availability or pricing.

## Repository structure

```text
vscode_extensions/
  README.md
  PRIVACY.md
  SECURITY.md
  PUBLISHING.md
  LICENSE
  .github/workflows/ci.yml
  extensions/
    agent-keep-awake/
      README.md
      CHANGELOG.md
      LICENSE
      package.json
      src/
      test/
      images/
    ai-credits-usage-tracker/
      README.md
      CHANGELOG.md
      LICENSE
      package.json
      extension.js
      lib/
      test/
      media/
      scripts/
```

Each Marketplace overview is generated from its own project's `README.md`, not the root landing page.
The root README links both projects and their installation instructions; both manifests point to this repository and the correct `repository.directory`.

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
