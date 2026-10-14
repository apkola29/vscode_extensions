# Agent Keep-Awake

**Manual-mode preview: keep your computer awake while you run Copilot or other agent work.**

**Keep your normal coding workflow. Choose a power mode, not a different chat.**

Use the coffee control to choose **Off**, **Keep awake**, or **Auto - Copilot
activity**. Keep awake is an explicit local hold until switched off or its
window closes. Auto is currently **Unavailable**, not working automatic chat
protection: no native lifecycle adapter has passed its evidence gates.
Simply opening VS Code never prevents sleep.

This source is included in the public
[VS Code extensions repository](https://github.com/apkola29/vscode_extensions/tree/main/extensions/agent-keep-awake)
with the owner's explicit approval. The original standalone repository is preserved.
This remains a manual-mode preview: automatic Copilot activity detection is not a released feature.
Publishing source does not silently update an existing Marketplace installation.

## Use it in VS Code

Requirements: **desktop VS Code 1.95 or newer**. Manual power control needs
no hooks, model account, API key, or subscription. Windows is the validated
native-request target; macOS/Linux protection remains explicitly unverified.

1. Install the **pre-release** from the [Visual Studio Marketplace](https://marketplace.visualstudio.com/items?itemName=apkola29.agent-keep-awake), or download the preview VSIX from [GitHub Releases](https://github.com/apkola29/vscode_extensions/releases)
   and install it through **Extensions: Install from VSIX...**
   in the Command Palette, or launch **Run Extension** with F5 from this project.
2. Click the coffee control to open the **mode picker**.
3. Choose **Keep awake** for until-you-switch-it-off protection.
4. On Windows, wait for the acknowledged **green cup**, then use normal Copilot,
   Claude, or any other application. No `@awake` prefix or model replacement is required.
5. Choose **Off** when done, or run **Agent Keep-Awake: Turn Off**.
   Off disables only this extension's protection and never cancels native Copilot.

The primary **Keep awake** choice is indefinite by design. Explicit timed
commands still use **Duration (Hours)**, which defaults to **1 hour**.
Open **Settings**, search **Agent Keep-Awake**, and set **Duration (Hours)**:

| Value | Session |
|---|---|
| `0` | Live-forever mode: until you turn it off or close/reload its VS Code window |
| `0.5` | 30 minutes |
| `1` | 1 hour (default) |
| `2`, `4`, `8`, etc. | That many hours, up to 24 |

You can also run **Agent Keep-Awake: Configure Duration (Hours)** from the
Command Palette. The setting applies to the **next explicit timed** session only; changing it
does not silently extend, shorten, or disable a session already running.
The duration is an application setting, not a workspace-file override.

For a one-off duration without changing the default, use **Agent Keep-Awake:
Choose Duration for a Long Prompt**, including **Until I turn it off**.
Live-forever mode has no expiry timer, but it never starts by itself or survives
closing/reloading the window.

**Manual mode does not detect chat completion.** Pressing Stop in a chat does
not switch Keep Awake off. Use the mode picker or **Agent Keep-Awake: Turn Off**.
Selecting Off never aborts or modifies Copilot work.

| Coffee status | Meaning |
|---|---|
| Neutral cup with **@awake ready** | Ready to activate, but not preventing sleep |
| Spinner **Keep Awake: Starting...** | Waiting for the OS to accept protection; not yet confirmed |
| Green cup only, with no ready text | The OS helper has acknowledged active protection; the item shrinks so adjacent icons shift |
| Warning **Keep Awake: Failed** | Protection could not start or was lost; sleep is allowed |
| **Auto: Unavailable** | No supported native-hook profile has been verified; no power hold |
| **Keep Awake: Unverified** on macOS/Linux | A helper may be running, but this build has no native acknowledgement proof; never shown as confirmed green |

The tooltip explains **Off**, **Manual**, or **Auto**, confirmed protection,
owner count, and any deadline. Click to choose a mode.
Hover to see expiry date/time, or **until you turn it off**.
The screen-reader label
also announces On or Off; green follows the theme's success color. Opening another window
does not activate it. Closing/reloading the owning window clears its session.
There is no persistent always-on setting or editor-activity heuristic.
Old `enabled`, `mode`, and activity-timeout settings are ignored.
**Show Status** gives a short plain-English explanation; **Show Log** shows
technical lifecycle diagnostics. Hiding the icon does not stop an active session.

## Auto - Copilot activity: unavailable in this preview

Supported native hooks exist, but complete terminal/cancellation behavior and
window-instance routing have not been verified for the current Local or Copilot
Agent Host runtime. A `Stop` hook may require another turn; it is not proof that
work ended. Some session and operation identifiers are optional or absent.

Selecting Auto from Off shows **Auto: Unavailable**, with no power helper,
monitoring timer, local IPC endpoint, or hook configuration changes. Attempting
unavailable Auto while Manual is active preserves that hold and explains why.
Choose Keep awake when you need reliable explicit ownership.

The old `@awake` participant is no longer contributed or bundled. No prompts
are rerouted, no model is selected, and no tool permission is changed. Its
historical regression tests remain in the development repository only.

## What is protected

| Situation | This extension's behavior |
|---|---|
| Keep awake | One local hold until Off or owning-window exit; independent of chat/app activity |
| Timed coffee session | Hold protection until stopped, expired, or its window closes |
| Live-forever coffee session (`Duration (Hours) = 0`) | No expiry; still releases on Off, window close/reload, or helper failure |
| Normal Copilot/Claude chat during Manual | Request local sleep protection; read no chat content |
| Auto with no verified adapter | Unavailable; do not guess activity or acquire power |
| OS protection unavailable or lost | Clear green; report failure/retry without cancelling native Copilot |
| Window close, reload, or extension-host exit | Release the helper owned by that window |
| Ordinary editor activity while Off | No power request |
| Other windows or applications holding power | Off releases only this extension's window, not another owner's request |

## Free and entirely local

The extension is free and MIT-licensed. Manual controls read no chat content
and need no sign-in, API key, model access, or subscription. There are no
production runtime dependencies, listening servers, telemetry, or cloud calls.
Your normal chat provider keeps its own account, consent, plan, and usage rules;
this extension neither uses nor bypasses them.

No personal transcripts, private chat storage, credentials, or provider logs
are watched. Other chats are not modified. Only maintainers need publication
credentials; local installation does not.

## Security and cleanup boundaries

- The coffee control makes no model, network, authentication, or telemetry calls.
  It starts only a local, platform-native helper with fixed commands and arguments.
- It opens no listening port, requests no elevation, writes no power plan or
  registry policy, and never simulates keyboard/mouse input.
- Manual uses fixed local commands and no workspace execution. Auto requires
  a separately verified trusted local runtime, which is not enabled here.
- Settings are application-scoped; workspace files cannot silently choose
  indefinite protection or hide its control. There is no persistent On setting.
- Only one coordinator owns the backend. Owner identities include instance,
  generation and source, with idempotent begin/end and stale-event rejection.
  Internal mock-adapter tests do not establish native Copilot coverage.
- Logs contain mode/state/count/deadline diagnostics, never prompts,
  transcript paths, hook capabilities, credentials, or tool data.
- Each window owns its helper. Off, expiry and disposal clear its owners/timers.
  Host exit releases the platform helper. Helper failure clears confirmation,
  while bounded backend retry may restore a still-desired hold.
- No native chat is cancelled because power protection fails or is disabled.
- The packaged runtime contains no LLM client, chat participant, IPC bridge,
  hook client, hook configuration, or historical chat-processing module.

The earlier optional-chat attachment issue was mitigated in its historical
implementation; that route is now excluded from the shipped runtime entirely.
Bounded review and passing tests do not prove all possible defects are absent.

## Lightweight and bounded

- No polling, timers, or helper process while idle.
- A timed session uses one expiry timer, not a countdown polling loop.
- Live-forever mode uses no expiry timer. Invalid durations fail visibly
  instead of silently falling back to an hour or enabling indefinite protection.
- One small OS helper per active window on Windows/macOS; Linux may use two
  native inhibitors for desktop compatibility.
- Windows uses `SetThreadExecutionState`; macOS uses `caffeinate`; Linux uses
  `systemd-inhibit` and/or `gnome-session-inhibit`.
- **On Windows the screen stays on while enabled**, using combined system and
  display activity requests. This is required to address idle Modern Standby
  on machines where system-only requests allow screen-off standby entry.
  macOS/Linux continue to use system-only protection. Power plans are never edited.
- Protection must start within 10 seconds or the request fails visibly.
- No model/token/tool polling, transcript watcher, or IPC service is needed.
- Native backend readiness on macOS/Linux currently uses process survival,
  not a proven native assertion; the UI must say Unverified rather than green.

Sleep requests cannot override every OS policy, forced shutdown, or explicit
sleep action. On Linux, a logind block inhibitor can also affect lid/power-button
suspend. Linux permission/session behavior still needs native validation.

### Windows Modern Standby and the reported idle failure

The earlier system-only build acknowledged a request while this laptop still
entered Modern Standby at its three-minute idle timeout. Checking acknowledgement
bits was not sufficient proof of unattended protection.

The corrected Windows route requests **both system and display activity**.
The screen-on tradeoff is explicit: use AC power for dependable long runs.
Windows battery policy, lid/power-button sleep, explicit Sleep, and company
policies can still override requests. The extension does not bypass lock
screens, simulate input, change registry/power-plan policy, or need admin rights.
Green indicates an acknowledged live request, not immunity to forced OS actions.

The native idle test below additionally checks actual Kernel-Power sleep/
Modern Standby events and the measured last-input interval beyond the existing
idle policy. Input during the test makes it inconclusive, not a passed soak.

## Local testing and UAT

```sh
npm run typecheck
npm test
npm run test:os
npm run test:integration
```

For a real unattended Windows test on AC power:

```powershell
.\test\os\verify-idle-windows.ps1 -Seconds 240
```

The test must exceed the machine's current finite sleep/display idle timeouts.
It makes no power-plan changes, injects no input, checks for sleep/Modern
Standby events, and releases only its own helper afterward. It requires
PowerShell 7 and Node, and is not a guarantee for battery or forced-sleep policy.

Integration tests run the actual power-control commands in a separate VS Code
profile. They check native holds, Off, timed/no-expiry behavior, settings,
rapid transitions, truthful unavailable Auto, failures and editor shutdown.
No model is invoked. These are **not** evidence that native Copilot Auto or
the unattended laptop sleep problem has passed UAT.
Unit tests have a 5-second per-test deadline. Integration runs have a 5-minute
watchdog (`VSCODE_TEST_RUN_TIMEOUT_MS` can override it for CI or timeout
verification). Failure cleanup targets only that runner's descendants and
recorded helper PIDs with matching process-birth identities. Windows runs with
an existing system/display power hold fail as **inconclusive**, not as passed
acquire/release verification.

For Windows UAT, open the mode picker and choose Keep awake. Verify the green
cup and confirmed Manual tooltip. Continue your normal prompt; select Off when
done and verify the neutral ready label returns with no owned helper.
Check explicit timed expiry and the 0-hour no-expiry choice separately.
Auto must remain clearly unavailable and must not silently stop an active
Manual hold. Opening the editor without selecting a mode must stay inactive.

Installing an update does not replace the handler in an already-running window.
If clicking a ready cup only shows the old scope message, that window is using
the earlier build. Use **Developer: Reload Window** when its agent work is done.
The extension's own log records the loaded version so this can be verified,
rather than guessing from the installed Extensions list.

Native macOS/Linux tests are still required before claiming validated support.
Linux OS verification uses `busctl` JSON output from logind's `ListInhibitors`
in `what, who, why, mode, uid, pid` order. It requires JSON-capable `busctl` and
a reachable logind system bus; malformed or failed queries fail the tests.

## Native Auto evidence gates

Official Local/Copilot hooks are legitimate integration routes; they are not
universally unusable. Before Auto can be offered as working protection, its
specific harness must prove request start, final end/cancellation, failure,
blocked Stop/continuation, silent work, overlap, child ownership and routing
to the correct local window. A repository path or optional session ID alone
does not establish that routing.

The Local `Stop` event explicitly means **about to stop**, not inactive.
Copilot's `agentStop` can also block and force continuation. No short
silence timeout or arbitrary file activity is used as a substitute.
The verified profile, metadata-only transport and real native UAT remain release gates, not shipped features.
Private implementation notes are intentionally not part of the public repository or package.

Sources:
[Local hooks reference](https://code.visualstudio.com/docs/agents/reference/hooks-reference),
[Copilot hooks reference](https://docs.github.com/en/copilot/reference/hooks-reference),
[VS Code extension hosts](https://code.visualstudio.com/api/advanced-topics/extension-host).

## Preview scope and publication

This manual-mode preview is published with the owner's approval in the
[two-extension repository](https://github.com/apkola29/vscode_extensions) and Marketplace pre-release channel.
Repository CI runs synthetic tests and type checks; it does not publish automatically or silently start a power hold.
Native Auto and unattended-sleep claims remain separately blocked until their evidence gates pass.

The companion [GH Copilot Usage Tracker](../ai-credits-usage-tracker/README.md) tracks local GitHub Copilot
credits and tokens. It is a separate extension; installing it does not enable keep-awake behavior.

License: [MIT](LICENSE).

Windows references:
[SetThreadExecutionState](https://learn.microsoft.com/windows/win32/api/winbase/nf-winbase-setthreadexecutionstate),
[power-request limits](https://learn.microsoft.com/windows/win32/api/winbase/nf-winbase-powersetrequest).
