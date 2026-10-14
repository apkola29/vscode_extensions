# Privacy

## Repository and release contents

Only extension source, public documentation, artwork, synthetic tests, and release tooling are published.
Personal access tokens, passwords, account/email records, real local usage exports, session databases,
prompt/transcript content, debug logs, and machine-specific settings are excluded.
The public `apkola29` handle and its GitHub URLs are intentional project attribution.

## AI Credits Usage Tracker

- Reads the current OS user's supported local usage stores and current VS Code profile in read-only mode.
- Does not upload usage, prompts, transcripts, or authentication credentials.
- Native GitHub authentication is handled by VS Code; only the selected account ID preference and displayed
  account label are used. The extension does not persist or log authentication tokens.
- If several GitHub accounts exist, account selection is explicit rather than guessed.
- Historical untagged usage remains device-scoped, not proven account-scoped. Estimates are marked; the
  tracker is not an authoritative account-wide billing report.
- User-visible model/account labels are escaped. Native hover Markdown is untrusted and HTML is disabled.
- The optional detailed dashboard blocks scripts, network connections, and local resource access.
- Clipboard writes happen only when the user selects a model row.
- GitHub account metadata and local usage stay in that user's window; they are not public repository data.

## Agent Keep-Awake

- Manual controls hold/release a local OS power request; they do not read chats or credentials.
- Opening the editor alone does not prevent sleep.
- The extension does not install hooks, reroute model requests, simulate user input, or change a power plan.
- Off, window close/reload, expiry, and helper failure release owned protection.
- Automatic Copilot activity mode is explicitly unavailable in the included preview.

## Test-only processes

Desktop UI tests use an isolated profile and a temporary loopback debugging port. Their scripts are not
shipped in the production VSIX. Tests stop only owned processes, matching their PID and creation time,
and remove only their explicitly created temporary directories.
