# Security policy

Please do not include tokens, private prompts/transcripts, account identifiers, customer data, or personal
filesystem paths in public issues, screenshots, or logs.

Use a sanitized minimal reproduction and synthetic fixtures. For a sensitive report, use GitHub's private
vulnerability-reporting feature when available; never post a credential to obtain support.

## Supported release boundaries

- Credit tracking uses stable VS Code UI/authentication APIs and read-only local stores. Provider paths are
  not controlled by repository settings; untrusted and virtual workspaces are disabled for the tracker.
- Usage workers have bounded memory, queue and cache sizes, timeout/idle shutdown, and deactivation cleanup.
- Optional webviews use restrictive CSPs and disabled scripts; native hover text is not trusted Markdown.
- Keep-awake's documented native helper is intentional local power control, not a general command executor.
- Publishing credentials are supplied only through approved secure identity/secret mechanisms, never committed
  or passed as literal command-line arguments.
- GitHub Actions workflows have read-only repository permissions and do not publish automatically.

Local usage formats may change with VS Code, Copilot and Claude Code releases. This project cannot guarantee that future
upstream versions will remain compatible; regression tests and visible partial-data reporting are the safeguards.
