# Publishing

GitHub repository ownership and Visual Studio Marketplace publisher ownership are separate permissions.
The approved public namespace for these projects is `apkola29`.

## Preconditions

1. Run each project's synthetic tests and type checks.
2. Package with the official `@vscode/vsce` CLI, leaving its secret scan enabled.
3. Inspect the archive file list and verify the compact tracker UI on the exact packaged VSIX.
4. Do not include logs, session data, credential files, personal screenshots, local account/configuration
   records, dependency folders, or local preview archives in commits. Documentation screenshots must use
   the isolated synthetic screenshot mode and contain no personal usage or account details.
5. Keep preview status explicit for Agent Keep-Awake. Auto activity detection is unavailable.

## Package

From the repository root:

```powershell
New-Item -ItemType Directory -Force release-artifacts

Set-Location extensions\ai-credits-usage-tracker
npx --yes @vscode/vsce@4.0.0 package --no-dependencies `
  --baseContentUrl https://github.com/apkola29/vscode_extensions/blob/main/extensions/ai-credits-usage-tracker `
  --baseImagesUrl https://github.com/apkola29/vscode_extensions/raw/main/extensions/ai-credits-usage-tracker `
  --out ..\..\release-artifacts\ai-usage-credits-meter-0.5.1.vsix

Set-Location ..\agent-keep-awake
npx --yes @vscode/vsce@4.0.0 package --no-dependencies --pre-release --out ..\..\release-artifacts\agent-keep-awake-1.1.1-preview.vsix
```

VSIX files belong in GitHub Releases, not git history. The tracker has no runtime npm dependencies.

## Marketplace authorization

Sign in to the [Marketplace publisher management portal](https://marketplace.visualstudio.com/manage)
using the Microsoft identity that owns or is authorized to manage publisher `apkola29`. A GitHub login
with that public handle does not automatically authorize a Microsoft Marketplace publisher.

Prefer an existing authorized Entra identity:

```powershell
npx --yes @vscode/vsce@4.0.0 verify-pat apkola29 --azure-credential
```

Alternatively, configure the official CLI's secure publisher login locally:

```powershell
npx --yes @vscode/vsce@4.0.0 login apkola29
```

Enter any PAT only into the local CLI's protected prompt. Use the minimum required Marketplace Manage
permission, a short expiration, and the correct publisher scope. Never paste a token into chat, put it
in a command-line argument, commit it, or include it in a screenshot.

An `Access Denied` response is a stop condition, not something to work around.

## Publish the already-verified archive

After secure authorization succeeds:

```powershell
npx --yes @vscode/vsce@4.0.0 publish --packagePath release-artifacts\ai-usage-credits-meter-0.5.1.vsix
```

For authorized Entra authentication, add `--azure-credential`.
Verify the public listing/version afterwards; a successful GitHub release is not proof of a
successful Marketplace publication.

The repository's CI never publishes automatically and contains no publishing credential.
